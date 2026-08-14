import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Full opportunity detail — scope, estimate+lines, subcontract packages, bid, audit.
// INVARIANT 12: scoped by ctx.organizationId — uses findFirst (not findUnique).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params

    const opportunity = await db.opportunity.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        client: true,
        owner: true,
        organization: true,
        scopePackage: {
          include: {
            items: true,
            questions: true,
            assumptions: true,
            evidence: true,
          },
        },
        estimates: {
          include: {
            lines: {
              include: {
                scopeItem: true,
                workDefinition: true,
                workDefinitionVersion: true,
                executionSegments: true,
              },
            },
            revisions: true,
          },
          orderBy: { updatedAt: 'desc' },
        },
        subcontractPackages: {
          include: {
            lines: { include: { estimateLine: true } },
            quotes: { include: { lines: true, scopeCoverages: true } },
            scopeAtoms: true,
          },
        },
        bid: true,
      },
    })

    if (!opportunity) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
    }

    // Audit logs: fetch those referencing this opportunity OR its child entities.
    // AuditLog has no direct FK to Opportunity, so query by organization + relevant entity ids.
    const estimateIds = opportunity.estimates.map((e) => e.id)
    const lineIds = opportunity.estimates.flatMap((e) => e.lines.map((l) => l.id))
    const scopeItemId = opportunity.scopePackage?.items.map((i) => i.id) ?? []
    const quoteIds = opportunity.subcontractPackages.flatMap((sp) => sp.quotes.map((q) => q.id))
    const relevantEntityIds = [opportunity.id, ...estimateIds, ...lineIds, ...scopeItemId, ...quoteIds]

    const auditLogs = await db.auditLog.findMany({
      where: {
        organizationId: ctx.organizationId,
        OR: [
          { entityId: { in: relevantEntityIds } },
          { action: { contains: 'ai.assistant' } },
        ],
      },
      include: { actor: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    // Helper: safely parse blockingInputsJson into an array.
    const parseBlockingInputs = (json: string | null | undefined): unknown[] => {
      if (!json) return []
      try {
        const parsed: unknown = JSON.parse(json)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    // Serialize + flatten estimates for the UI
    const estimates = opportunity.estimates.map((e) => {
      const totalDirect = e.lines.reduce((s, l) => s + l.directCost, 0)
      const totalSell = e.lines.reduce((s, l) => s + l.sellPrice, 0)
      const totalCost = e.lines.reduce((s, l) => s + l.projectCost + l.riskCost + l.overheadCost + l.profitCost, 0)
      const avgConfidence = e.lines.length
        ? e.lines.reduce((s, l) => s + l.confidence, 0) / e.lines.length
        : 0
      const unsourcedCount = e.lines.filter((l) => l.isUnsourced).length
      return {
        id: e.id,
        status: e.status,
        version: e.version,
        overheadPct: e.overheadPct,
        profitPct: e.profitPct,
        contingencyPct: e.contingencyPct,
        totalDirectCost: totalDirect,
        totalSellPrice: totalSell,
        totalCost,
        averageMarginPct: totalSell > 0 ? ((totalSell - totalDirect) / totalSell) * 100 : 0,
        averageConfidence: avgConfidence,
        unsourcedLineCount: unsourcedCount,
        lines: e.lines.map((l) => ({
          id: l.id,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          executionStrategy: l.executionStrategy,
          // P0-4/P0-6 new fields
          calculationStatus: l.calculationStatus,
          blockingInputs: parseBlockingInputs(l.blockingInputsJson),
          estimatedTotalCost: l.estimatedTotalCost,
          expectedProfit: l.expectedProfit,
          expectedMarginPct: l.expectedMarginPct,
          // existing fields
          materialCost: l.materialCost,
          labourCost: l.labourCost,
          plantCost: l.plantCost,
          subcontractCost: l.subcontractCost,
          directCost: l.directCost,
          projectCost: l.projectCost,
          riskCost: l.riskCost,
          overheadCost: l.overheadCost,
          profitCost: l.profitCost,
          sellPrice: l.sellPrice,
          unitRate: l.unitRate,
          marginPct: l.marginPct,
          confidence: l.confidence,
          provenanceSummary: l.provenanceSummary,
          isUnsourced: l.isUnsourced,
          unsourcedRationale: l.unsourcedRationale,
          unsourcedConfidence: l.unsourcedConfidence,
          acknowledged: l.acknowledged,
          executionSegments: l.executionSegments.map((seg) => ({
            id: seg.id,
            strategy: seg.strategy,
            scopeDefinition: seg.scopeDefinition,
            quantityPct: seg.quantityPct,
            subcontractQuoteId: seg.subcontractQuoteId,
          })),
          scopeItem: l.scopeItem
            ? { id: l.scopeItem.id, description: l.scopeItem.description, status: l.scopeItem.status }
            : null,
          workDefinition: l.workDefinition
            ? { id: l.workDefinition.id, code: l.workDefinition.code, name: l.workDefinition.name, unit: l.workDefinition.unit }
            : null,
          workDefinitionVersion: l.workDefinitionVersion
            ? {
                id: l.workDefinitionVersion.id,
                version: l.workDefinitionVersion.version,
                approvalState: l.workDefinitionVersion.approvalState,
                productivityRule: l.workDefinitionVersion.productivityRule,
                wastage: l.workDefinitionVersion.wastage,
                hazardsJson: l.workDefinitionVersion.hazardsJson,
                controlsJson: l.workDefinitionVersion.controlsJson,
                methodStatementFragment: l.workDefinitionVersion.methodStatementFragment,
                requiredPPE: l.workDefinitionVersion.requiredPPE,
                requiredPermits: l.workDefinitionVersion.requiredPermits,
                costRecipeJson: l.workDefinitionVersion.costRecipeJson,
                subcontractability: l.workDefinitionVersion.subcontractability,
              }
            : null,
        })),
        revisions: e.revisions.map((r) => ({
          id: r.id,
          revisionNo: r.revisionNo,
          finalizedAt: r.finalizedAt,
        })),
      }
    })

    return NextResponse.json({
      opportunity: {
        id: opportunity.id,
        title: opportunity.title,
        reference: opportunity.reference,
        status: opportunity.status,
        source: opportunity.source,
        description: opportunity.description,
        location: opportunity.location,
        receivedAt: opportunity.receivedAt,
        submissionDeadline: opportunity.submissionDeadline,
        createdAt: opportunity.createdAt,
        updatedAt: opportunity.updatedAt,
        client: opportunity.client,
        owner: opportunity.owner,
        organization: { id: opportunity.organization.id, name: opportunity.organization.name, currency: opportunity.organization.currency },
        scopePackage: opportunity.scopePackage
          ? {
              id: opportunity.scopePackage.id,
              completeness: opportunity.scopePackage.completeness,
              origin: opportunity.scopePackage.origin,
              items: opportunity.scopePackage.items,
              questions: opportunity.scopePackage.questions,
              assumptions: opportunity.scopePackage.assumptions,
              evidence: opportunity.scopePackage.evidence,
            }
          : null,
        estimates,
        subcontractPackages: opportunity.subcontractPackages.map((sp) => ({
          id: sp.id,
          name: sp.name,
          scope: sp.scope,
          executionStrategy: sp.executionStrategy,
          status: sp.status,
          selectedQuoteId: sp.selectedQuoteId,
          scopeAtoms: sp.scopeAtoms.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
          })),
          lines: sp.lines.map((l) => ({
            id: l.id,
            requiredScope: l.requiredScope,
            estimateLineId: l.estimateLineId,
            estimateLine: l.estimateLine
              ? { id: l.estimateLine.id, description: l.estimateLine.description, sellPrice: l.estimateLine.sellPrice, unit: l.estimateLine.unit, quantity: l.estimateLine.quantity }
              : null,
          })),
          quotes: sp.quotes.map((q) => ({
            id: q.id,
            supplierName: q.supplierName,
            totalAmount: q.totalAmount,
            currency: q.currency,
            receivedAt: q.receivedAt,
            exclusionsJson: q.exclusionsJson,
            assumptionsJson: q.assumptionsJson,
            coveragePct: q.coveragePct,
            status: q.status,
            lines: q.lines,
            scopeCoverages: q.scopeCoverages.map((c) => ({
              id: c.id,
              scopeAtomId: c.scopeAtomId,
              status: c.status,
              note: c.note,
            })),
          })),
        })),
        bid: opportunity.bid,
        auditLogs: auditLogs.map((a) => ({
          id: a.id,
          action: a.action,
          summary: a.summary,
          entityType: a.entityType,
          entityId: a.entityId,
          actor: a.actor?.name ?? 'System',
          createdAt: a.createdAt,
        })),
      },
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
