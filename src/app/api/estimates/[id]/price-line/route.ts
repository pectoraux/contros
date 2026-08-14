import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import {
  priceLine,
  computeConfidence,
  type PricingInput,
  type ExecutionSegmentInput,
} from '@/lib/engines'
import { round2 } from '@/lib/engines/money'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Recompute an estimate line deterministically using the pricing engine.
// This is the ONLY way a price enters the canonical estimate — never via AI.
// INVARIANT 5: AI cannot silently commit a price.
// INVARIANT 12: scoped by ctx.organizationId — verifies estimate ownership.
// P0-4: incomplete calculations persist calculationStatus + blockingInputsJson
//       and create a CommercialException record.
// P0-5: hybrid strategy requires executionSegments — fetched from the relation.
// P0-6: persists estimatedTotalCost, expectedProfit, expectedMarginPct.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const { estimateLineId, overheadPct, profitPct, contingencyPct, executionStrategy } = body as {
      estimateLineId?: string
      overheadPct?: number
      profitPct?: number
      contingencyPct?: number
      executionStrategy?: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided'
    }

    if (!estimateLineId) {
      return NextResponse.json({ error: 'estimateLineId required' }, { status: 400 })
    }

    // P0-12: verify the estimate belongs to ctx.organizationId.
    // Use findFirst (not findUnique) so organizationId is enforced at the DB layer.
    const line = await db.estimateLine.findFirst({
      where: {
        id: estimateLineId,
        estimateId: id,
        estimate: { organizationId: ctx.organizationId },
      },
      include: {
        workDefinition: true,
        workDefinitionVersion: { include: { priceObservations: true } },
        estimate: true,
        scopeItem: true,
        executionSegments: true,
      },
    })
    if (!line) {
      return NextResponse.json({ error: 'Line not found in this estimate' }, { status: 404 })
    }

    const wdv = line.workDefinitionVersion

    // P0-5: fetch the subcontract quote (if any) for this line.
    // Look up via SubcontractPackageLine → SubcontractPackage → selectedQuote.
    let subcontractQuote: { totalAmount: number; coveragePct: number } | null = null
    const pkgLine = await db.subcontractPackageLine.findFirst({
      where: { estimateLineId: line.id },
      include: {
        subcontractPackage: {
          include: {
            quotes: true,
          },
        },
      },
    })
    if (pkgLine) {
      const selectedQuoteId = pkgLine.subcontractPackage.selectedQuoteId
      if (selectedQuoteId) {
        const sq = pkgLine.subcontractPackage.quotes.find((q) => q.id === selectedQuoteId)
        if (sq) {
          subcontractQuote = {
            totalAmount: sq.totalAmount,
            coveragePct: sq.coveragePct,
          }
        }
      }
    }

    // P0-5: build ExecutionSegmentInput[] from the persisted relation.
    // For subcontract segments, fetch the segment's referenced quote (if any).
    const executionSegments: ExecutionSegmentInput[] = []
    for (const seg of line.executionSegments) {
      let segQuote: { totalAmount: number; coveragePct: number } | null | undefined = undefined
      if (seg.strategy === 'subcontract' && seg.subcontractQuoteId) {
        const sq = await db.subcontractQuote.findUnique({
          where: { id: seg.subcontractQuoteId },
          select: { totalAmount: true, coveragePct: true },
        })
        if (sq) {
          segQuote = { totalAmount: sq.totalAmount, coveragePct: sq.coveragePct }
        } else {
          segQuote = null
        }
      }
      executionSegments.push({
        strategy: seg.strategy as 'self-perform' | 'subcontract',
        quantityPct: seg.quantityPct,
        subcontractQuote: segQuote,
      })
    }

    // Build pricing input (P0-5: pass executionSegments for hybrid).
    const pricingInput: PricingInput = {
      workDefinitionVersion: wdv
        ? {
            id: wdv.id,
            name: line.workDefinition?.name ?? '',
            version: wdv.version,
            unit: line.workDefinition?.unit ?? line.unit,
            wastage: wdv.wastage,
            productivityRule: wdv.productivityRule ?? undefined,
            costRecipeJson: wdv.costRecipeJson,
          }
        : null,
      quantity: line.quantity,
      executionStrategy: executionStrategy ?? line.executionStrategy,
      executionSegments: executionSegments.length > 0 ? executionSegments : undefined,
      overheadPct: overheadPct ?? line.estimate.overheadPct,
      profitPct: profitPct ?? line.estimate.profitPct,
      contingencyPct: contingencyPct ?? line.estimate.contingencyPct,
      subcontractQuote,
    }

    const breakdown = priceLine(pricingInput)

    // Compute confidence from evidence
    const confidence = computeConfidence({
      observedAt: wdv?.priceObservations?.[0]?.observedAt ?? null,
      provenance: wdv?.priceObservations?.[0]?.provenance ?? null,
      workDefinitionApproval: wdv?.approvalState ?? null,
      scopeCompleteness: line.scopeItem ? 0.7 : 0.5,
      executionStrategy: pricingInput.executionStrategy,
      hasSubcontractQuote: !!subcontractQuote,
      productivityEvidence: wdv?.productivityRule ?? null,
      quantity: line.quantity,
      unit: line.unit,
    })

    // Provenance summary string
    const provenanceSummary = breakdown.provenance.length
      ? breakdown.provenance
          .map((p) => `${p.resourceName}: ${p.provenance}${p.sourceReference ? ` #${p.sourceReference}` : ''} @ GHS ${p.price.toFixed(2)} (${new Date(p.observedAt).toLocaleDateString()})`)
          .join('; ')
      : 'No price observations — unsourced'

    // Persist deterministic computation to canonical estimate (P0-4/P0-6 new fields).
    const updated = await db.estimateLine.update({
      where: { id: line.id },
      data: {
        materialCost: round2(breakdown.material),
        labourCost: round2(breakdown.labour),
        plantCost: round2(breakdown.plant),
        subcontractCost: round2(breakdown.subcontract),
        directCost: round2(breakdown.directCost),
        projectCost: round2(breakdown.projectCost),
        riskCost: round2(breakdown.riskCost),
        overheadCost: round2(breakdown.overhead),
        profitCost: round2(breakdown.profit),
        // P0-6 new fields
        estimatedTotalCost: round2(breakdown.estimatedTotalCost),
        expectedProfit: round2(breakdown.expectedProfit),
        expectedMarginPct: round2(breakdown.expectedMarginPct),
        sellPrice: round2(breakdown.sellPrice),
        unitRate: round2(breakdown.unitRate),
        marginPct: round2(breakdown.marginPct),
        // P0-4 new fields
        calculationStatus: breakdown.calculationStatus,
        blockingInputsJson: JSON.stringify(breakdown.blockingInputs),
        confidence: round2(confidence.score),
        isUnsourced: breakdown.unsourced,
        provenanceSummary,
        executionStrategy: pricingInput.executionStrategy,
      },
    })

    // P0-4/P0-8: if calculation is incomplete, record a CommercialException.
    if (breakdown.calculationStatus === 'incomplete') {
      const reason = breakdown.blockingInputs.length > 0
        ? breakdown.blockingInputs
            .map((b) => `${b.kind}: ${b.detail}`)
            .join(' | ')
        : 'Calculation incomplete — unknown reason.'
      // Avoid duplicate open exceptions: only create if none exists for this line+type.
      const existing = await db.commercialException.findFirst({
        where: {
          estimateLineId: line.id,
          type: 'incomplete-calculation',
          organizationId: ctx.organizationId,
        },
      })
      if (!existing) {
        await db.commercialException.create({
          data: {
            organizationId: ctx.organizationId,
            estimateLineId: line.id,
            entityType: 'estimate-line',
            entityId: line.id,
            type: 'incomplete-calculation',
            reason,
            exposure: round2(breakdown.sellPrice),
            approvalRequired: false,
          },
        })
      }
    }

    // Append audit log
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        actorId: ctx.userId,
        action: 'estimate.rate-recomputed',
        entityType: 'EstimateLine',
        entityId: line.id,
        summary: `Rate recomputed for "${line.description}": GHS ${round2(breakdown.unitRate).toFixed(2)}/${line.unit} [${breakdown.calculationStatus.toUpperCase()}]${breakdown.unsourced ? ' [UNSOURCED]' : ''}`,
        afterJson: JSON.stringify({
          unitRate: breakdown.unitRate,
          sellPrice: breakdown.sellPrice,
          unsourced: breakdown.unsourced,
          calculationStatus: breakdown.calculationStatus,
          blockingInputs: breakdown.blockingInputs,
        }),
      },
    })

    return NextResponse.json({
      line: {
        id: updated.id,
        unitRate: updated.unitRate,
        sellPrice: updated.sellPrice,
        marginPct: updated.marginPct,
        // P0-4/P0-6 new fields
        calculationStatus: updated.calculationStatus,
        estimatedTotalCost: updated.estimatedTotalCost,
        expectedProfit: updated.expectedProfit,
        expectedMarginPct: updated.expectedMarginPct,
        blockingInputs: breakdown.blockingInputs,
        confidence: updated.confidence,
        isUnsourced: updated.isUnsourced,
        provenanceSummary: updated.provenanceSummary,
        breakdown: {
          material: breakdown.material,
          labour: breakdown.labour,
          plant: breakdown.plant,
          subcontract: breakdown.subcontract,
          directCost: breakdown.directCost,
          projectCost: breakdown.projectCost,
          riskCost: breakdown.riskCost,
          overhead: breakdown.overhead,
          profit: breakdown.profit,
          // P0-6 new fields
          estimatedTotalCost: breakdown.estimatedTotalCost,
          expectedProfit: breakdown.expectedProfit,
          expectedMarginPct: breakdown.expectedMarginPct,
          sellPrice: breakdown.sellPrice,
          unitRate: breakdown.unitRate,
          marginPct: breakdown.marginPct,
          // P0-4
          calculationStatus: breakdown.calculationStatus,
          blockingInputs: breakdown.blockingInputs,
        },
        provenance: breakdown.provenance,
        unsourcedResources: breakdown.unsourcedResources,
      },
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
