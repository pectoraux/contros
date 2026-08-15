/**
 * BidService — application service for bid lifecycle and commercial submission.
 *
 * Owns: bid creation, state machine transitions, submission gate invocation,
 * adjudication, submission, outcome recording, and transaction boundaries.
 *
 * Does NOT own: pricing calculations (pricing-engine), gate checks (pre-submission-gate),
 * or revision validation (revision-service). The service orchestrates these pure engines.
 *
 * FROZEN pattern: RequestContext → Service → Repository → Engine → Transaction → Audit
 */

import { db } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  runPreSubmissionGate,
  computeScopeCompleteness,
  validateBidSubmission,
  type PreSubmissionGateInput,
  type GateEstimateLine,
  type GateSubcontractPackage,
  type ScopeCompletenessItem,
  type ScopeCompletenessQuestion,
  type GateResult,
} from '@/lib/engines'
import { round2 } from '@/lib/engines/money'
import {
  bidRepository,
  auditLogRepository,
  estimateRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface BidWorkspaceInput {
  ctx: RequestContext
  opportunityId: string
}

export interface BidWorkspaceResult {
  ok: true
  bid: {
    id: string
    status: string
    tenderPackStatus: string
    finalPrice: number | null
    directorAdjustment: number
    adjustmentRationale: string | null
    submittedAt: string | null
    outcome: string | null
    estimateRevisionId: string | null
    programmeRevisionId: string | null
    estimateId: string
    opportunityId: string
  } | null
  gate: GateResult
  estimateStatus: string | null
  estimateId: string | null
}

export interface CreateBidInput {
  ctx: RequestContext
  opportunityId: string
  estimateId: string
}

export interface TransitionStatusInput {
  ctx: RequestContext
  bidId: string
  newStatus: string
}

export interface RunGateInput {
  ctx: RequestContext
  opportunityId: string
}

export interface RecordAdjudicationInput {
  ctx: RequestContext
  bidId: string
  directorAdjustment: number
  adjustmentRationale: string
}

export interface SubmitBidInput {
  ctx: RequestContext
  bidId: string
  estimateRevisionId: string
  programmeRevisionId?: string
}

export interface RecordOutcomeInput {
  ctx: RequestContext
  bidId: string
  outcome: string
  winningPrice?: number
  ourRank?: number
  lossReason?: string
  clientFeedback?: string
}

export interface WithdrawBidInput {
  ctx: RequestContext
  bidId: string
}

// ─── State Machine ──────────────────────────────────────────────────────────

// Bid tenderPackStatus state machine:
// draft → ready → submitted → clarification → won/lost
//                              submitted → withdrawn
// Any non-terminal → withdrawn
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  draft: ['ready', 'adjudication', 'withdrawn'],
  ready: ['submitted', 'adjudication', 'draft', 'withdrawn'],
  adjudication: ['submitted', 'ready', 'withdrawn'],
  submitted: ['clarification', 'won', 'lost', 'withdrawn'],
  clarification: ['won', 'lost', 'withdrawn'],
  won: [],
  lost: [],
  withdrawn: [],
}

function isLegalTransition(from: string, to: string): boolean {
  const allowed = LEGAL_TRANSITIONS[from]
  return allowed ? allowed.includes(to) : false
}

// ─── BidService ─────────────────────────────────────────────────────────────

export const bidService = {
  /**
   * Get the bid workspace — loads the bid (if exists) + runs the submission gate.
   * Replaces the current pre-submission route logic.
   */
  async getBidWorkspace(input: BidWorkspaceInput): Promise<BidWorkspaceResult | Err> {
    const { ctx, opportunityId } = input

    const opportunity = await db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: ctx.organizationId },
      include: {
        scopePackage: { include: { items: true, questions: true, assumptions: true } },
        estimates: {
          include: { lines: { include: { commercialExceptions: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        subcontractPackages: {
          include: {
            lines: { include: { estimateLine: { include: { estimate: { select: { organizationId: true } } } } } },
            quotes: { include: { scopeCoverages: true } },
            scopeAtoms: true,
          },
        },
        bid: true,
      },
    })

    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }

    // Build gate input (same logic as the old route, but in the service).
    const scopeItems: ScopeCompletenessItem[] = opportunity.scopePackage?.items.map((i) => ({
      description: i.description,
      status: i.status as 'known' | 'missing' | 'ambiguous',
      category: i.category ?? undefined,
    })) ?? []
    const scopeQuestions: ScopeCompletenessQuestion[] = opportunity.scopePackage?.questions.map((q) => ({
      status: q.status,
    })) ?? []
    const scopeCompleteness = computeScopeCompleteness(scopeItems, scopeQuestions)

    const unresolvedAssumptions = (opportunity.scopePackage?.assumptions ?? []).map((a) => ({
      id: a.id,
      text: a.text,
      acknowledged: a.acknowledged,
      riskLevel: a.riskLevel as 'low' | 'medium' | 'high',
    }))

    const estimate = opportunity.estimates[0]
    const estimateLines: GateEstimateLine[] = (estimate?.lines ?? []).map((l) => {
      const exceptionApproved = l.commercialExceptions.some((ex) => !!ex.approvedById)
      return {
        id: l.id,
        description: l.description,
        isUnsourced: l.isUnsourced,
        acknowledged: l.acknowledged,
        unitRate: l.unitRate,
        calculationStatus: (l.calculationStatus === 'incomplete' ? 'incomplete' : 'complete') as 'complete' | 'incomplete',
        exceptionApproved,
      }
    })

    const subcontractPackages: GateSubcontractPackage[] = opportunity.subcontractPackages.map((sp) => {
      const selectedQuote = sp.quotes.find((q) => q.id === sp.selectedQuoteId) ?? null
      return {
        id: sp.id,
        name: sp.name,
        coveragePct: selectedQuote?.coveragePct ?? 0,
        selectedQuoteId: sp.selectedQuoteId,
        isLumpSum: false, // Simplified — SubcontractService handles detailed reconciliation
      }
    })

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

    const commercialApproval =
      opportunity.bid?.directorAdjustment !== undefined && opportunity.bid?.directorAdjustment !== 0
        ? true
        : estimate?.status === 'adjudicated' || estimate?.status === 'submitted'

    const gateInput: PreSubmissionGateInput = {
      scopeCompleteness,
      unresolvedAssumptions,
      estimateLines,
      subcontractPackages,
      deliverables,
      commercialApproval,
    }

    const gate = runPreSubmissionGate(gateInput)

    return {
      ok: true,
      bid: opportunity.bid
        ? {
            id: opportunity.bid.id,
            status: opportunity.bid.tenderPackStatus,
            tenderPackStatus: opportunity.bid.tenderPackStatus,
            finalPrice: opportunity.bid.finalPrice,
            directorAdjustment: opportunity.bid.directorAdjustment,
            adjustmentRationale: opportunity.bid.adjustmentRationale,
            submittedAt: opportunity.bid.submittedAt,
            outcome: opportunity.bid.outcome,
            estimateRevisionId: opportunity.bid.estimateRevisionId,
            programmeRevisionId: opportunity.bid.programmeRevisionId,
            estimateId: opportunity.bid.estimateId,
            opportunityId: opportunity.bid.opportunityId,
          }
        : null,
      gate,
      estimateStatus: estimate?.status ?? null,
      estimateId: estimate?.id ?? null,
    }
  },

  /**
   * Run the submission gate — alias for getBidWorkspace's gate portion.
   */
  async runSubmissionGate(input: RunGateInput): Promise<{ ok: true; gate: GateResult; opportunityId: string; opportunityTitle: string; scopeCompleteness: unknown; deliverables: unknown; estimateStatus: string | null; estimateId: string | null } | Err> {
    const workspace = await this.getBidWorkspace(input)
    if (!workspace.ok) return workspace
    return {
      ok: true,
      gate: workspace.gate,
      opportunityId: input.opportunityId,
      opportunityTitle: '', // The workspace doesn't return title; could add if needed
      scopeCompleteness: null, // Derived in workspace; simplified for the gate endpoint
      deliverables: null,
      estimateStatus: workspace.estimateStatus,
      estimateId: workspace.estimateId,
    }
  },

  /**
   * Create a bid for an opportunity.
   */
  async createBid(input: CreateBidInput): Promise<{ ok: true; bidId: string } | Err> {
    const { ctx, opportunityId, estimateId } = input

    const existing = await bidRepository.getForOpportunity(ctx.organizationId, opportunityId)
    if (existing) {
      return { ok: false, error: 'Bid already exists for this opportunity', status: 409 }
    }

    const bid = await db.$transaction(async (tx) => {
      const created = await bidRepository.createInTransaction(tx, ctx.organizationId, {
        opportunityId,
        estimateId,
      })
      if (!created) return null

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.created',
        entityType: 'Bid',
        entityId: created.id,
        summary: `Bid created for opportunity ${opportunityId}`,
      })

      return created
    })

    if (!bid) {
      return { ok: false, error: 'Opportunity or estimate not found in this organization', status: 404 }
    }

    return { ok: true, bidId: bid.id }
  },

  /**
   * Transition the bid status — enforces the state machine.
   */
  async transitionStatus(input: TransitionStatusInput): Promise<{ ok: true; newStatus: string } | Err> {
    const { ctx, bidId, newStatus } = input

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) {
      return { ok: false, error: 'Bid not found', status: 404 }
    }

    const currentStatus = bid.tenderPackStatus
    if (currentStatus === newStatus) {
      return { ok: true, newStatus }
    }

    if (!isLegalTransition(currentStatus, newStatus)) {
      return {
        ok: false,
        error: `Illegal status transition: ${currentStatus} → ${newStatus}`,
        status: 400,
      }
    }

    // Post-submission immutability: if already submitted, only allow clarification/outcome/withdrawn.
    if (['submitted', 'clarification', 'won', 'lost'].includes(currentStatus)) {
      if (!['clarification', 'won', 'lost', 'withdrawn'].includes(newStatus)) {
        return {
          ok: false,
          error: `Cannot transition from ${currentStatus} to ${newStatus} — bid is post-submission`,
          status: 400,
        }
      }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: newStatus,
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.status-changed',
        entityType: 'Bid',
        entityId: bidId,
        summary: `Bid status changed: ${currentStatus} → ${newStatus}`,
        afterJson: JSON.stringify({ from: currentStatus, to: newStatus }),
      })
    })

    return { ok: true, newStatus }
  },

  /**
   * Record adjudication — preserves system price + human override separately.
   */
  async recordAdjudication(input: RecordAdjudicationInput): Promise<{ ok: true; finalPrice: number } | Err> {
    const { ctx, bidId, directorAdjustment, adjustmentRationale } = input

    if (!Number.isFinite(directorAdjustment)) {
      return { ok: false, error: 'Director adjustment must be a finite number', status: 400 }
    }

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) {
      return { ok: false, error: 'Bid not found', status: 404 }
    }

    // Compute final price: system sell price + director adjustment.
    const estimate = await estimateRepository.getForOrganization(ctx.organizationId, bid.estimateId)
    if (!estimate) {
      return { ok: false, error: 'Estimate not found', status: 404 }
    }

    // Get the total sell price from the estimate lines.
    const lines = await db.estimateLine.findMany({
      where: { estimateId: estimate.id },
      select: { sellPrice: true },
    })
    const systemSellPrice = round2(lines.reduce((s, l) => s + l.sellPrice, 0))
    const finalPrice = round2(systemSellPrice * (1 + directorAdjustment))

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        directorAdjustment,
        adjustmentRationale,
        finalPrice,
        tenderPackStatus: 'adjudication',
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.adjudication-recorded',
        entityType: 'Bid',
        entityId: bidId,
        summary: `Adjudication recorded: system=${systemSellPrice}, adjustment=${(directorAdjustment * 100).toFixed(1)}%, final=${finalPrice}`,
        afterJson: JSON.stringify({ systemSellPrice, directorAdjustment, finalPrice, adjustmentRationale }),
      })
    })

    return { ok: true, finalPrice }
  },

  /**
   * Submit the bid — the critical guarded transaction.
   * Validates: finalized revision, gate pass, no blockers. Idempotent.
   */
  async submitBid(input: SubmitBidInput): Promise<{ ok: true; bidId: string; finalPrice: number; submittedAt: string } | Err> {
    const { ctx, bidId, estimateRevisionId, programmeRevisionId } = input

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) {
      return { ok: false, error: 'Bid not found', status: 404 }
    }

    // Idempotency: if already submitted, return existing.
    if (bid.submittedAt && bid.tenderPackStatus === 'submitted') {
      return {
        ok: true,
        bidId: bid.id,
        finalPrice: bid.finalPrice ?? 0,
        submittedAt: bid.submittedAt.toISOString(),
      }
    }

    // State machine: must be in adjudication or ready to submit.
    if (!['adjudication', 'ready'].includes(bid.tenderPackStatus)) {
      return {
        ok: false,
        error: `Cannot submit bid in status ${bid.tenderPackStatus} — must be in adjudication or ready`,
        status: 400,
      }
    }

    // Validate the estimate revision is finalized.
    const revision = await db.estimateRevision.findFirst({
      where: { id: estimateRevisionId, estimate: { organizationId: ctx.organizationId } },
      select: { id: true, status: true },
    })
    if (!revision) {
      return { ok: false, error: 'Estimate revision not found in this organization', status: 404 }
    }

    const validation = validateBidSubmission({
      estimateRevisionId,
      estimateStatus: bid.estimate?.status ?? 'draft',
      finalPrice: bid.finalPrice,
      hasFinalizedRevision: revision.status === 'finalized',
    })

    if (!validation.ok) {
      return { ok: false, error: validation.errors.join('; '), status: 400 }
    }

    // Run the submission gate.
    const workspace = await this.getBidWorkspace({ ctx, opportunityId: bid.opportunityId })
    if (!workspace.ok) return workspace

    if (workspace.gate.overall === 'blocker') {
      const blockerDetails = workspace.gate.checks
        .filter((c) => c.status === 'blocker')
        .map((c) => `${c.label}: ${c.detail ?? ''}`)
        .join('; ')
      return {
        ok: false,
        error: `Submission blocked: ${blockerDetails}`,
        status: 400,
      }
    }

    // All checks pass — submit in a transaction.
    const submittedAt = new Date()
    const result = await db.$transaction(async (tx) => {
      const updated = await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: 'submitted',
        submittedAt,
        estimateRevisionId,
        programmeRevisionId: programmeRevisionId ?? null,
      })
      if (!updated) throw new Error('Bid update failed in transaction')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.submitted',
        entityType: 'Bid',
        entityId: bidId,
        summary: `Bid submitted: finalPrice=${bid.finalPrice ?? 0}, revision=${estimateRevisionId}`,
        afterJson: JSON.stringify({
          finalPrice: bid.finalPrice,
          estimateRevisionId,
          programmeRevisionId,
          gateResult: workspace.gate.overall,
          submittedAt: submittedAt.toISOString(),
        }),
      })

      return updated
    })

    return {
      ok: true,
      bidId: result.id,
      finalPrice: result.finalPrice ?? 0,
      submittedAt: submittedAt.toISOString(),
    }
  },

  /**
   * Record the bid outcome (won/lost/withdrawn).
   */
  async recordOutcome(input: RecordOutcomeInput): Promise<{ ok: true; outcome: string } | Err> {
    const { ctx, bidId, outcome, winningPrice, ourRank, lossReason, clientFeedback } = input

    const validOutcomes = ['won', 'lost', 'withdrawn', 'unknown']
    if (!validOutcomes.includes(outcome)) {
      return { ok: false, error: `Invalid outcome: ${outcome}`, status: 400 }
    }

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) {
      return { ok: false, error: 'Bid not found', status: 404 }
    }

    // Must be submitted or in clarification to record outcome.
    if (!['submitted', 'clarification'].includes(bid.tenderPackStatus)) {
      return {
        ok: false,
        error: `Cannot record outcome for bid in status ${bid.tenderPackStatus}`,
        status: 400,
      }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: outcome,
        outcome,
        winningPrice: winningPrice ?? null,
        ourRank: ourRank ?? null,
        lossReason: lossReason ?? null,
        clientFeedback: clientFeedback ?? null,
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.outcome-recorded',
        entityType: 'Bid',
        entityId: bidId,
        summary: `Outcome recorded: ${outcome}${winningPrice ? `, winning price=${winningPrice}` : ''}${ourRank ? `, rank=${ourRank}` : ''}`,
        afterJson: JSON.stringify({ outcome, winningPrice, ourRank, lossReason, clientFeedback }),
      })
    })

    return { ok: true, outcome }
  },

  /**
   * Withdraw the bid.
   */
  async withdrawBid(input: WithdrawBidInput): Promise<{ ok: true } | Err> {
    const { ctx, bidId } = input

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) {
      return { ok: false, error: 'Bid not found', status: 404 }
    }

    if (['won', 'lost', 'withdrawn', 'lapsed'].includes(bid.tenderPackStatus)) {
      return { ok: false, error: `Cannot withdraw bid in terminal status ${bid.tenderPackStatus}`, status: 400 }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: 'withdrawn',
        outcome: 'withdrawn',
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.withdrawn',
        entityType: 'Bid',
        entityId: bidId,
        summary: 'Bid withdrawn',
      })
    })

    return { ok: true }
  },
}
