import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { priceLine, computeConfidence, type PricingInput } from '@/lib/engines'
import { round2 } from '@/lib/engines/money'

// Recompute an estimate line deterministically using the pricing engine.
// This is the ONLY way a price enters the canonical estimate — never via AI.
// INVARIANT 5: AI cannot silently commit a price.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const line = await db.estimateLine.findUnique({
    where: { id: estimateLineId },
    include: {
      workDefinitionVersion: { include: { priceObservations: true } },
      estimate: true,
      scopeItem: true,
    },
  })
  if (!line || line.estimateId !== id) {
    return NextResponse.json({ error: 'Line not found in this estimate' }, { status: 404 })
  }

  const wdv = line.workDefinitionVersion
  const recipeLines = wdv ? JSON.parse(wdv.costRecipeJson || '[]') : []

  // Build pricing input
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
    overheadPct: overheadPct ?? line.estimate.overheadPct,
    profitPct: profitPct ?? line.estimate.profitPct,
    contingencyPct: contingencyPct ?? line.estimate.contingencyPct,
    subcontractQuote: null,
  }

  const breakdown = priceLine(pricingInput)

  // Compute confidence from evidence
  const confidence = computeConfidence({
    observedAt: wdv?.priceObservations?.[0]?.observedAt ?? null,
    provenance: wdv?.priceObservations?.[0]?.provenance ?? null,
    workDefinitionApproval: wdv?.approvalState ?? null,
    scopeCompleteness: line.scopeItem ? 0.7 : 0.5,
    executionStrategy: pricingInput.executionStrategy,
    hasSubcontractQuote: false,
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

  // Persist deterministic computation to canonical estimate
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
      sellPrice: round2(breakdown.sellPrice),
      unitRate: round2(breakdown.unitRate),
      marginPct: round2(breakdown.marginPct),
      confidence: round2(confidence.score),
      isUnsourced: breakdown.unsourced,
      provenanceSummary,
      executionStrategy: pricingInput.executionStrategy,
    },
  })

  // Append audit log
  await db.auditLog.create({
    data: {
      organizationId: line.estimate.organizationId,
      action: 'estimate.rate-recomputed',
      entityType: 'EstimateLine',
      entityId: line.id,
      summary: `Rate recomputed for "${line.description}": GHS ${round2(breakdown.unitRate).toFixed(2)}/${line.unit}${breakdown.unsourced ? ' [UNSOURCED]' : ''}`,
      afterJson: JSON.stringify({ unitRate: breakdown.unitRate, sellPrice: breakdown.sellPrice, unsourced: breakdown.unsourced }),
    },
  })

  return NextResponse.json({
    line: {
      id: updated.id,
      unitRate: updated.unitRate,
      sellPrice: updated.sellPrice,
      marginPct: updated.marginPct,
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
        sellPrice: breakdown.sellPrice,
        unitRate: breakdown.unitRate,
        marginPct: breakdown.marginPct,
      },
      provenance: breakdown.provenance,
      unsourcedResources: breakdown.unsourcedResources,
    },
  })
}
