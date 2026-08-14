import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import {
  runPreSubmissionGate,
  computeScopeCompleteness,
  reconcileSubcontract,
  type PreSubmissionGateInput,
  type ScopeCompletenessItem,
  type ScopeCompletenessQuestion,
  type GateEstimateLine,
  type GateSubcontractPackage,
} from '@/lib/engines'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Pre-submission control gate — deterministic validation pipeline.
// Returns PASS / WARNING / BLOCKER per check + overall verdict.
// INVARIANT 12: scoped by ctx.organizationId — verifies opportunity ownership.
// P0-4: passes calculationStatus per line (incomplete-calculations check).
// P0-7: passes isLumpSum per subcontract package (lump-sum = blocker).
// P0-8: passes exceptionApproved per line (unsourced-rates approval rule).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId } = await params

    // Verify ownership — findFirst (not findUnique).
    const opportunity = await db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: ctx.organizationId },
      include: {
        scopePackage: { include: { items: true, questions: true, assumptions: true } },
        estimates: {
          include: {
            lines: {
              include: {
                commercialExceptions: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        subcontractPackages: {
          include: {
            lines: { include: { estimateLine: true } },
            quotes: { include: { scopeCoverages: true } },
            scopeAtoms: true,
          },
        },
        bid: true,
      },
    })

    if (!opportunity) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
    }

    // Scope completeness (recomputed deterministically)
    const scopeItems: ScopeCompletenessItem[] = opportunity.scopePackage?.items.map((i) => ({
      description: i.description,
      status: i.status as 'known' | 'missing' | 'ambiguous',
      category: i.category ?? undefined,
    })) ?? []
    const scopeQuestions: ScopeCompletenessQuestion[] = opportunity.scopePackage?.questions.map((q) => ({
      status: q.status,
    })) ?? []
    const scopeCompleteness = computeScopeCompleteness(scopeItems, scopeQuestions)

    // Unresolved assumptions
    const unresolvedAssumptions = (opportunity.scopePackage?.assumptions ?? []).map((a) => ({
      id: a.id,
      text: a.text,
      acknowledged: a.acknowledged,
      riskLevel: a.riskLevel as 'low' | 'medium' | 'high',
    }))

    // Estimate lines (P0-4: calculationStatus; P0-8: exceptionApproved).
    const estimate = opportunity.estimates[0]
    const estimateLines: GateEstimateLine[] = (estimate?.lines ?? []).map((l) => {
      // P0-8: a CommercialException is "approved" if it exists and has approvedById set.
      const exceptionApproved = l.commercialExceptions.some((ex) => !!ex.approvedById)
      return {
        id: l.id,
        description: l.description,
        isUnsourced: l.isUnsourced,
        acknowledged: l.acknowledged,
        unitRate: l.unitRate,
        // P0-4
        calculationStatus: (l.calculationStatus === 'incomplete' ? 'incomplete' : 'complete') as
          | 'complete'
          | 'incomplete',
        // P0-8
        exceptionApproved,
      }
    })

    // Subcontract packages (P0-7: isLumpSum for the selected quote).
    const subcontractPackages: GateSubcontractPackage[] = opportunity.subcontractPackages.map((sp) => {
      const selectedQuote = sp.quotes.find((q) => q.id === sp.selectedQuoteId) ?? null
      let isLumpSum = false
      let coveragePct = 0
      if (selectedQuote) {
        coveragePct = selectedQuote.coveragePct
        // Run reconciliation to determine lump-sum status.
        const scopeAtoms = sp.scopeAtoms.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? undefined,
        }))
        const scopeCoverages = selectedQuote.scopeCoverages.map((c) => ({
          scopeAtomId: c.scopeAtomId,
          status: c.status as 'covered' | 'excluded' | 'unstated',
          note: c.note ?? undefined,
        }))
        const requiredLines = sp.lines.map((l) => ({
          id: l.estimateLineId,
          description: l.requiredScope || l.estimateLine?.description || '',
          sellPrice: l.estimateLine?.sellPrice ?? 0,
        }))
        const recon = reconcileSubcontract({
          requiredLines,
          scopeAtoms,
          quote: {
            id: selectedQuote.id,
            totalAmount: selectedQuote.totalAmount,
            scopeCoverages,
            exclusionsJson: selectedQuote.exclusionsJson,
            assumptionsJson: selectedQuote.assumptionsJson,
          },
        })
        isLumpSum = recon.isLumpSum
        coveragePct = recon.coveragePct
      }
      return {
        id: sp.id,
        name: sp.name,
        coveragePct,
        selectedQuoteId: sp.selectedQuoteId,
        // P0-7
        isLumpSum,
      }
    })

    // Deliverables — heuristic for MVP: BOQ ready if estimate has lines,
    // Programme/MS/JHA inferred from work-definition coverage on estimate lines.
    const hasEstimateLines = (estimate?.lines.length ?? 0) > 0
    const wdCoverage = estimate
      ? estimate.lines.filter((l) => l.workDefinitionVersionId).length / Math.max(estimate.lines.length, 1)
      : 0
    const deliverables = {
      boq: hasEstimateLines,
      programme: wdCoverage >= 0.7,
      methodStatement: wdCoverage >= 0.7,
      jha: wdCoverage >= 0.7,
      tenderPack: opportunity.bid?.tenderPackStatus === 'ready' || opportunity.bid?.tenderPackStatus === 'submitted',
    }

    const commercialApproval = opportunity.bid?.directorAdjustment !== undefined && opportunity.bid?.directorAdjustment !== 0
      ? true
      : estimate?.status === 'adjudicated' || estimate?.status === 'submitted'

    const input: PreSubmissionGateInput = {
      scopeCompleteness,
      unresolvedAssumptions,
      estimateLines,
      subcontractPackages,
      deliverables,
      commercialApproval,
    }

    const gate = runPreSubmissionGate(input)

    return NextResponse.json({
      opportunityId,
      opportunityTitle: opportunity.title,
      gate,
      scopeCompleteness,
      deliverables,
      estimateStatus: estimate?.status ?? null,
      estimateId: estimate?.id ?? null,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
