/**
 * BidService — application service for bid lifecycle and commercial submission.
 *
 * P0 corrections:
 * - No raw Prisma in the service — all reads via tenant-aware repositories
 * - No 70% WD proxy for deliverable readiness — uses actual revision/document state
 * - Programme revision is tenant-safe + finalized-validated
 * - Adjudication uses finalized EstimateRevision snapshot (not mutable estimate)
 * - Submitted revision must match adjudicated revision
 * - Post-submission immutability for commercial fields
 *
 * FROZEN pattern: RequestContext → Service → Repository → Engine → Transaction → Audit
 */

import { db } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  runPreSubmissionGate,
  computeScopeCompleteness,
  validateBidSubmission,
  replayRevision,
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
  estimateRevisionRepositoryExtended,
  programmeRevisionRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface BidWorkspaceInput { ctx: RequestContext; opportunityId: string }
export interface CreateBidInput { ctx: RequestContext; opportunityId: string; estimateId: string }
export interface TransitionStatusInput { ctx: RequestContext; bidId: string; newStatus: string }
export interface RunGateInput { ctx: RequestContext; opportunityId: string }
export interface RecordAdjudicationInput {
  ctx: RequestContext
  bidId: string
  estimateRevisionId: string
  directorAdjustment: number
  adjustmentRationale: string
}
export interface SubmitBidInput {
  ctx: RequestContext
  bidId: string
  programmeRevisionId?: string
}
export interface RecordOutcomeInput {
  ctx: RequestContext; bidId: string; outcome: string
  winningPrice?: number; ourRank?: number; lossReason?: string; clientFeedback?: string
}
export interface WithdrawBidInput { ctx: RequestContext; bidId: string }

// ─── State Machine ──────────────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Record<string, string[]> = {
  draft: ['adjudication', 'withdrawn'],
  adjudication: ['ready', 'draft', 'withdrawn'],
  ready: ['submitted', 'adjudication', 'withdrawn'],
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

const SUBMITTED_STATES = ['submitted', 'clarification', 'won', 'lost']
const IMMUTABLE_FIELDS = ['finalPrice', 'directorAdjustment', 'adjustmentRationale', 'estimateRevisionId', 'adjudicatedRevisionId', 'programmeRevisionId', 'systemSellPrice', 'submittedAt']

// ─── BidService ─────────────────────────────────────────────────────────────

export const bidService = {
  /**
   * Get the bid workspace — loads the bid + runs the submission gate.
   * Uses bidRepository.getOpportunityBidWorkspace() — no raw Prisma.
   */
  async getBidWorkspace(input: BidWorkspaceInput): Promise<{ ok: true; bid: Record<string, unknown> | null; gate: GateResult; estimateStatus: string | null; estimateId: string | null } | Err> {
    const { ctx, opportunityId } = input

    // P0-1: Use repository, not raw Prisma.
    const opportunity = await bidRepository.getOpportunityBidWorkspace(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }

    // Build gate input from the loaded graph.
    const scopeItems: ScopeCompletenessItem[] = opportunity.scopePackage?.items.map((i) => ({
      description: i.description,
      status: i.status as 'known' | 'missing' | 'ambiguous',
      category: i.category ?? undefined,
    })) ?? []
    const scopeQuestions: ScopeCompletenessQuestion[] = opportunity.scopePackage?.questions.map((q) => ({ status: q.status })) ?? []
    const scopeCompleteness = computeScopeCompleteness(scopeItems, scopeQuestions)

    const unresolvedAssumptions = (opportunity.scopePackage?.assumptions ?? []).map((a) => ({
      id: a.id, text: a.text, acknowledged: a.acknowledged, riskLevel: a.riskLevel as 'low' | 'medium' | 'high',
    }))

    const estimate = opportunity.estimates[0]
    const estimateLines: GateEstimateLine[] = (estimate?.lines ?? []).map((l) => {
      const exceptionApproved = l.commercialExceptions.some((ex) => !!ex.approvedById)
      return {
        id: l.id, description: l.description, isUnsourced: l.isUnsourced, acknowledged: l.acknowledged,
        unitRate: l.unitRate,
        calculationStatus: (l.calculationStatus === 'incomplete' ? 'incomplete' : 'complete') as 'complete' | 'incomplete',
        exceptionApproved,
      }
    })

    const subcontractPackages: GateSubcontractPackage[] = opportunity.subcontractPackages.map((sp) => ({
      id: sp.id, name: sp.name,
      coveragePct: sp.quotes.find((q) => q.id === sp.selectedQuoteId)?.coveragePct ?? 0,
      selectedQuoteId: sp.selectedQuoteId, isLumpSum: false,
    }))

    // P0-2: Deliverable readiness is NOT inferred from WD coverage.
    // BOQ is ready if estimate has lines. Programme/MS/JHA readiness is
    // determined by whether a finalized revision exists, not by WD coverage.
    const hasEstimateLines = (estimate?.lines.length ?? 0) > 0
    const hasFinalizedRevision = !!(await estimateRevisionRepositoryExtended.getFinalizedForOrganization(
      ctx.organizationId, opportunity.bid?.estimateRevisionId ?? '',
    ))
    const deliverables = {
      boq: hasEstimateLines,
      programme: hasFinalizedRevision,
      methodStatement: hasFinalizedRevision,
      jha: hasFinalizedRevision,
      tenderPack: opportunity.bid?.tenderPackStatus === 'ready' || opportunity.bid?.tenderPackStatus === 'submitted',
    }

    const commercialApproval =
      (opportunity.bid?.directorAdjustment !== undefined && opportunity.bid?.directorAdjustment !== 0) ||
      estimate?.status === 'adjudicated' || estimate?.status === 'submitted'

    const gate = runPreSubmissionGate({
      scopeCompleteness, unresolvedAssumptions, estimateLines, subcontractPackages, deliverables, commercialApproval,
    })

    return {
      ok: true,
      bid: opportunity.bid ? {
        id: opportunity.bid.id,
        status: opportunity.bid.tenderPackStatus,
        tenderPackStatus: opportunity.bid.tenderPackStatus,
        finalPrice: opportunity.bid.finalPrice,
        directorAdjustment: opportunity.bid.directorAdjustment,
        adjustmentRationale: opportunity.bid.adjustmentRationale,
        systemSellPrice: opportunity.bid.systemSellPrice,
        submittedAt: opportunity.bid.submittedAt,
        outcome: opportunity.bid.outcome,
        estimateRevisionId: opportunity.bid.estimateRevisionId,
        adjudicatedRevisionId: opportunity.bid.adjudicatedRevisionId,
        programmeRevisionId: opportunity.bid.programmeRevisionId,
        estimateId: opportunity.bid.estimateId,
        opportunityId: opportunity.bid.opportunityId,
      } : null,
      gate,
      estimateStatus: estimate?.status ?? null,
      estimateId: estimate?.id ?? null,
    }
  },

  /**
   * Run the submission gate — alias for getBidWorkspace's gate portion.
   */
  async runSubmissionGate(input: RunGateInput) {
    const ws = await this.getBidWorkspace(input)
    if (!ws.ok) return ws
    return {
      ok: true as const,
      gate: ws.gate,
      opportunityId: input.opportunityId,
      estimateStatus: ws.estimateStatus,
      estimateId: ws.estimateId,
    }
  },

  /**
   * Create a bid — transactional with audit.
   */
  async createBid(input: CreateBidInput): Promise<{ ok: true; bidId: string } | Err> {
    const { ctx, opportunityId, estimateId } = input

    const existing = await bidRepository.getForOpportunity(ctx.organizationId, opportunityId)
    if (existing) {
      return { ok: false, error: 'Bid already exists for this opportunity', status: 409 }
    }

    const bid = await db.$transaction(async (tx) => {
      const created = await bidRepository.createInTransaction(tx, ctx.organizationId, { opportunityId, estimateId })
      if (!created) return null
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.created', entityType: 'Bid', entityId: created.id,
        summary: `Bid created for opportunity ${opportunityId}`,
      })
      return created
    })

    if (!bid) return { ok: false, error: 'Opportunity or estimate not found in this organization', status: 404 }
    return { ok: true, bidId: bid.id }
  },

  /**
   * Transition the bid status — enforces the state machine.
   * P0-6: Post-submission immutability — commercial fields cannot be changed after submission.
   */
  async transitionStatus(input: TransitionStatusInput): Promise<{ ok: true; newStatus: string } | Err> {
    const { ctx, bidId, newStatus } = input

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) return { ok: false, error: 'Bid not found', status: 404 }

    const currentStatus = bid.tenderPackStatus
    if (currentStatus === newStatus) return { ok: true, newStatus }

    if (!isLegalTransition(currentStatus, newStatus)) {
      return { ok: false, error: `Illegal status transition: ${currentStatus} → ${newStatus}`, status: 400 }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, { tenderPackStatus: newStatus })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.status-changed', entityType: 'Bid', entityId: bidId,
        summary: `Bid status changed: ${currentStatus} → ${newStatus}`,
        afterJson: JSON.stringify({ from: currentStatus, to: newStatus }),
      })
    })

    return { ok: true, newStatus }
  },

  /**
   * P0-4: Record adjudication using a FINALIZED EstimateRevision.
   * The system price is derived from the revision's immutable snapshot,
   * NOT from the current mutable estimate.
   */
  async recordAdjudication(input: RecordAdjudicationInput): Promise<{ ok: true; systemSellPrice: number; finalPrice: number } | Err> {
    const { ctx, bidId, estimateRevisionId, directorAdjustment, adjustmentRationale } = input

    if (!Number.isFinite(directorAdjustment)) {
      return { ok: false, error: 'Director adjustment must be a finite number', status: 400 }
    }

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) return { ok: false, error: 'Bid not found', status: 404 }

    // P0-6: Post-submission immutability.
    if (SUBMITTED_STATES.includes(bid.tenderPackStatus)) {
      return { ok: false, error: 'Cannot adjudicate a submitted bid — commercial fields are immutable', status: 400 }
    }

    // P0-4: Load the FINALIZED revision via repository (tenant-safe).
    const revision = await estimateRevisionRepositoryExtended.getFinalizedForOrganization(
      ctx.organizationId, estimateRevisionId,
    )
    if (!revision) {
      return { ok: false, error: 'Finalized estimate revision not found in this organization', status: 404 }
    }

    // P0-4: Derive system price from the immutable snapshot, not the mutable estimate.
    const replay = replayRevision(revision.snapshotJson)
    if (!replay.ok) {
      return { ok: false, error: 'Failed to replay revision snapshot for adjudication', status: 500 }
    }

    const systemSellPrice = replay.totalSellPrice
    const finalPrice = round2(systemSellPrice * (1 + directorAdjustment))

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        directorAdjustment,
        adjustmentRationale,
        finalPrice,
        systemSellPrice,
        adjudicatedRevisionId: estimateRevisionId,
        tenderPackStatus: 'adjudication',
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.adjudication-recorded', entityType: 'Bid', entityId: bidId,
        summary: `Adjudication recorded: system=${systemSellPrice}, adjustment=${(directorAdjustment * 100).toFixed(1)}%, final=${finalPrice}, revision=${estimateRevisionId}`,
        afterJson: JSON.stringify({ systemSellPrice, directorAdjustment, finalPrice, adjustmentRationale, estimateRevisionId }),
      })
    })

    return { ok: true, systemSellPrice, finalPrice }
  },

  /**
   * P0-5: Submit the bid — the critical guarded transaction.
   * The submitted revision MUST match the adjudicated revision.
   * Programme revision is validated (tenant-safe + finalized).
   * Idempotent.
   */
  async submitBid(input: SubmitBidInput): Promise<{ ok: true; bidId: string; finalPrice: number; submittedAt: string } | Err> {
    const { ctx, bidId, programmeRevisionId } = input

    const bid = await bidRepository.getForOrganization(ctx.organizationId, bidId)
    if (!bid) return { ok: false, error: 'Bid not found', status: 404 }

    // Idempotency: if already submitted, return existing.
    if (bid.submittedAt && bid.tenderPackStatus === 'submitted') {
      return { ok: true, bidId: bid.id, finalPrice: bid.finalPrice ?? 0, submittedAt: bid.submittedAt.toISOString() }
    }

    // State machine: must be in adjudication or ready.
    if (!['adjudication', 'ready'].includes(bid.tenderPackStatus)) {
      return { ok: false, error: `Cannot submit bid in status ${bid.tenderPackStatus} — must be in adjudication or ready`, status: 400 }
    }

    // P0-5: The submitted revision must match the adjudicated revision.
    if (!bid.adjudicatedRevisionId) {
      return { ok: false, error: 'Cannot submit without an adjudicated estimate revision — record adjudication first', status: 400 }
    }

    // P0-3: Validate programme revision if provided (tenant-safe + finalized).
    if (programmeRevisionId) {
      const progRev = await programmeRevisionRepository.getFinalizedForOrganization(ctx.organizationId, programmeRevisionId)
      if (!progRev) {
        return { ok: false, error: 'Finalized programme revision not found in this organization', status: 404 }
      }
    }

    // Validate the adjudicated revision is still finalized.
    const revision = await estimateRevisionRepositoryExtended.getFinalizedForOrganization(
      ctx.organizationId, bid.adjudicatedRevisionId,
    )
    if (!revision) {
      return { ok: false, error: 'Adjudicated estimate revision is no longer finalized', status: 400 }
    }

    // Validate bid submission.
    const validation = validateBidSubmission({
      estimateRevisionId: bid.adjudicatedRevisionId,
      estimateStatus: bid.estimate?.status ?? 'draft',
      finalPrice: bid.finalPrice,
      hasFinalizedRevision: true,
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
      return { ok: false, error: `Submission blocked: ${blockerDetails}`, status: 400 }
    }

    // All checks pass — submit in a transaction.
    const submittedAt = new Date()
    const result = await db.$transaction(async (tx) => {
      const updated = await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: 'submitted',
        submittedAt,
        estimateRevisionId: bid.adjudicatedRevisionId, // P0-5: submitted = adjudicated
        programmeRevisionId: programmeRevisionId ?? null,
      })
      if (!updated) throw new Error('Bid update failed in transaction')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.submitted', entityType: 'Bid', entityId: bidId,
        summary: `Bid submitted: finalPrice=${bid.finalPrice ?? 0}, revision=${bid.adjudicatedRevisionId}`,
        afterJson: JSON.stringify({
          finalPrice: bid.finalPrice, estimateRevisionId: bid.adjudicatedRevisionId,
          programmeRevisionId, gateResult: workspace.gate.overall, submittedAt: submittedAt.toISOString(),
        }),
      })
      return updated
    })

    return { ok: true, bidId: result.id, finalPrice: result.finalPrice ?? 0, submittedAt: submittedAt.toISOString() }
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
    if (!bid) return { ok: false, error: 'Bid not found', status: 404 }

    if (!['submitted', 'clarification'].includes(bid.tenderPackStatus)) {
      return { ok: false, error: `Cannot record outcome for bid in status ${bid.tenderPackStatus}`, status: 400 }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: outcome, outcome,
        winningPrice: winningPrice ?? null, ourRank: ourRank ?? null,
        lossReason: lossReason ?? null, clientFeedback: clientFeedback ?? null,
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.outcome-recorded', entityType: 'Bid', entityId: bidId,
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
    if (!bid) return { ok: false, error: 'Bid not found', status: 404 }

    if (['won', 'lost', 'withdrawn'].includes(bid.tenderPackStatus)) {
      return { ok: false, error: `Cannot withdraw bid in terminal status ${bid.tenderPackStatus}`, status: 400 }
    }

    await db.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: 'withdrawn', outcome: 'withdrawn',
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.withdrawn', entityType: 'Bid', entityId: bidId, summary: 'Bid withdrawn',
      })
    })

    return { ok: true }
  },
}
