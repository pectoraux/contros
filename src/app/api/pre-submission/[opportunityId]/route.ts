import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import {
  runPreSubmissionGate,
  computeScopeCompleteness,
  type PreSubmissionGateInput,
  type ScopeCompletenessItem,
  type ScopeCompletenessQuestion,
} from '@/lib/engines'

// Pre-submission control gate — deterministic validation pipeline
// Returns PASS / WARNING / BLOCKER per check + overall verdict
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params

  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      scopePackage: { include: { items: true, questions: true, assumptions: true } },
      estimates: {
        include: { lines: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
      subcontractPackages: {
        include: { lines: true, quotes: true },
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

  // Estimate lines
  const estimate = opportunity.estimates[0]
  const estimateLines = (estimate?.lines ?? []).map((l) => ({
    id: l.id,
    description: l.description,
    isUnsourced: l.isUnsourced,
    acknowledged: l.acknowledged,
    unitRate: l.unitRate,
  }))

  // Subcontract packages
  const subcontractPackages = opportunity.subcontractPackages.map((sp) => ({
    id: sp.id,
    name: sp.name,
    coveragePct: sp.quotes.find((q) => q.id === sp.selectedQuoteId)?.coveragePct ?? 0,
    selectedQuoteId: sp.selectedQuoteId,
  }))

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
}
