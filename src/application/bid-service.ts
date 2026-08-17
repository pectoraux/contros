/**
 * BidService — application service for bid lifecycle and commercial submission.
 *
 * Final corrections:
 * - Submission gate uses FROZEN adjudicated revision for commercial data (not mutable estimate)
 * - Deliverable readiness uses TenderDeliverable records (not estimateRevision existence)
 * - Required deliverables block submission when missing
 * - Post-submission immutability for commercial fields
 *
 * Y1/Y2 CORRECTION — Programme authority migration:
 * - The programme deliverable is NO LONGER resolved through the legacy
 *   EstimateRevision(revisionType='programme') path. It is now resolved
 *   through the new ProgrammeRevision domain.
 * - submitBid() validates Bid.programmeRevisionId → ProgrammeRevision (via
 *   programmeRevisionRepo.getForOrganization), NOT TenderDeliverable.revisionId
 *   → EstimateRevision(revisionType='programme').
 * - TenderDeliverable(kind='programme') is DEPRECATED for new bids — it
 *   remains for legacy-read compatibility but does not define the programme
 *   revision for new submissions. The programme deliverable's status
 *   (ready/finalized) is still checked for the gate, but the revisionId on
 *   the deliverable is no longer the authority.
 * - The authoritative programme truth is:
 *       Bid.programmeRevisionId → ProgrammeRevision → Programme → Organization
 *
 * FROZEN pattern: RequestContext → Service → Repository → Engine → Transaction → Audit
 */

import { db, dbTx } from '@/lib/db'
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
  programmeRevisionRepo,
  tenderDeliverableRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface BidWorkspaceInput { ctx: RequestContext; opportunityId: string }
export interface TenderDeliverableRequirement {
  kind: string // boq | programme | method-statement | jha | cover-letter | assumptions | clarifications | certificate
  required: boolean
}

export interface CreateBidInput {
  ctx: RequestContext
  opportunityId: string
  estimateId: string
  requiredDeliverables?: TenderDeliverableRequirement[]
}
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

// ─── Tender Deliverable Classification ──────────────────────────────────────
//
// Y1/Y2: TenderDeliverable(kind='programme') is DEPRECATED as a programme
// revision authority. The programme deliverable's STATUS (ready/finalized)
// is still checked for the submission gate, but its revisionId is NO LONGER
// the source of programme truth. The authoritative programme revision is
// Bid.programmeRevisionId → ProgrammeRevision.
//
// All deliverable kinds are now 'document-backed' for deliverable-status
// purposes. The programme revision is validated separately via
// programmeRevisionRepo (see submitBid).
//
// Legacy: existing TenderDeliverable(kind='programme').revisionId rows that
// point to EstimateRevision(revisionType='programme') are retained for
// backward-read compatibility but are NOT consulted for new submissions.

export type DeliverableKindClass = 'document-backed' | 'legacy-revision-backed'

export const DELIVERABLE_KIND_CLASS: Record<string, DeliverableKindClass> = {
  // Y1/Y2: 'programme' is now document-backed for gate purposes.
  // The programme revision is validated via Bid.programmeRevisionId → ProgrammeRevision.
  programme: 'document-backed',
  boq: 'document-backed',
  'method-statement': 'document-backed',
  jha: 'document-backed',
  'cover-letter': 'document-backed',
  assumptions: 'document-backed',
  clarifications: 'document-backed',
  certificate: 'document-backed',
}

// Y1/Y2: No kinds are revision-backed in the new path. The legacy
// REVISION_BACKED_KIND_TYPE is retained for reference but not used.
export const REVISION_BACKED_KIND_TYPE: Record<string, string> = {
  // programme: 'programme',  // DEPRECATED — now via ProgrammeRevision
}

function isRevisionBackedKind(_kind: string): boolean {
  // Y1/Y2: No kinds are revision-backed in the new path.
  return false
}

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

    // Build gate input.
    // P0-1 (final): If the bid has an adjudicated revision, use the FROZEN
    // commercial state from that revision — NOT the mutable current estimate.
    // Current mutable state is used only for workflow items (scope, assumptions).

    // Workflow state (current/mutable — OK to use current data):
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

    // Commercial state (frozen/mutable depending on adjudication):
    const estimate = opportunity.estimates[0]
    const bid = opportunity.bid

    let estimateLines: GateEstimateLine[]
    let subcontractPackages: GateSubcontractPackage[]

    if (bid?.adjudicatedRevisionId) {
      // P0-1: Use FROZEN adjudicated revision for ALL commercial data.
      // NEVER fall back to current estimate if adjudicated revision is set.
      const revision = await estimateRevisionRepositoryExtended.getFinalizedForBid(
        ctx.organizationId, bid.estimateId, opportunity.id, bid.adjudicatedRevisionId,
      )
      if (!revision) {
        // P0-1: Missing revision = BLOCKER. Do NOT fall back to current estimate.
        estimateLines = [{
          id: 'blocked', description: 'Adjudicated estimate revision is unavailable',
          isUnsourced: true, acknowledged: false, unitRate: 0,
          calculationStatus: 'incomplete' as const, exceptionApproved: false,
        }]
        subcontractPackages = []
      } else {
        const replay = replayRevision(revision.snapshotJson)
        if (!replay.ok) {
          // P0-1: Replay failure = BLOCKER. Do NOT fall back.
          estimateLines = [{
            id: 'blocked', description: 'Adjudicated estimate revision cannot be replayed',
            isUnsourced: true, acknowledged: false, unitRate: 0,
            calculationStatus: 'incomplete' as const, exceptionApproved: false,
          }]
          subcontractPackages = []
        } else {
          // Build gate lines from the frozen snapshot.
          estimateLines = replay.lines.map((l) => ({
            id: l.lineId,
            description: l.description,
            isUnsourced: l.breakdown.unsourced,
            acknowledged: false,
            unitRate: l.breakdown.unitRate,
            calculationStatus: l.breakdown.calculationStatus,
            exceptionApproved: false,
          }))

          // P0-2: Build subcontract packages from the FROZEN revision snapshot.
          // The snapshot contains subcontractQuote per line — use it, NOT current packages.
          // P0 (final): If the frozen snapshot has zero subcontract quotes, that means
          // NO subcontract commercial basis existed at adjudication. Do NOT fall back
          // to current mutable subcontract packages. Empty = empty.
          const frozenQuotes = replay.subcontractScopeSnapshots
          subcontractPackages = frozenQuotes.map((sq) => ({
            id: sq.id,
            name: sq.supplierName,
            coveragePct: sq.economicCoveragePct,
            selectedQuoteId: sq.id,
            isLumpSum: sq.economicCoverageUnknown,
          }))
          // No fallback to current packages — empty snapshot = empty packages.
        }
      }
    } else {
      // No adjudicated revision yet — use current estimate (pre-adjudication is OK)
      estimateLines = (estimate?.lines ?? []).map((l) => ({
        id: l.id, description: l.description, isUnsourced: l.isUnsourced, acknowledged: l.acknowledged,
        unitRate: l.unitRate,
        calculationStatus: (l.calculationStatus === 'incomplete' ? 'incomplete' : 'complete') as 'complete' | 'incomplete',
        exceptionApproved: l.commercialExceptions.some((ex) => !!ex.approvedById),
      }))
      // Pre-adjudication: use current subcontract packages
      subcontractPackages = opportunity.subcontractPackages.map((sp) => ({
        id: sp.id, name: sp.name,
        coveragePct: sp.quotes.find((q) => q.id === sp.selectedQuoteId)?.coveragePct ?? 0,
        selectedQuoteId: sp.selectedQuoteId, isLumpSum: false,
      }))
    }

    // P0-3: Deliverable readiness uses TenderDeliverable records ONLY.
    // P1-4: BOQ readiness must NOT fall back to estimate-lines existence.
    //
    // Gate-level readiness is status-based for ALL kinds (both revision-backed
    // and document-backed). The revisionId semantic distinction is enforced
    // at submission time in submitBid() — the gate itself only checks that
    // required deliverables have status='ready'|'finalized'.
    const deliverableRecords = bid
      ? await tenderDeliverableRepository.getForBid(ctx.organizationId, bid.id)
      : []
    const getDeliverableStatus = (kind: string): boolean => {
      const rec = deliverableRecords.find((d) => d.kind === kind)
      if (!rec) return false
      if (!rec.required) return true // Not required = pass
      return rec.status === 'ready' || rec.status === 'finalized'
    }
    const deliverables = {
      boq: getDeliverableStatus('boq'),
      programme: getDeliverableStatus('programme'),
      methodStatement: getDeliverableStatus('method-statement'),
      jha: getDeliverableStatus('jha'),
      tenderPack: bid?.tenderPackStatus === 'ready' || bid?.tenderPackStatus === 'submitted',
    }

    // P0 (final): Commercial approval must NOT come from current mutable Estimate.status.
    // After adjudication, approval is derived from the bid's adjudication state, not the estimate.
    // Before adjudication, current estimate status is acceptable.
    const commercialApproval = bid?.adjudicatedRevisionId
      ? // Post-adjudication: approval exists if adjudication was recorded (directorAdjustment or systemSellPrice set)
        !!(bid.directorAdjustment !== 0 || bid.systemSellPrice)
      : // Pre-adjudication: use current estimate status (acceptable before commercial freeze)
        (bid?.directorAdjustment !== undefined && bid?.directorAdjustment !== 0) ||
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
    const { ctx, opportunityId, estimateId, requiredDeliverables } = input

    const existing = await bidRepository.getForOpportunity(ctx.organizationId, opportunityId)
    if (existing) {
      return { ok: false, error: 'Bid already exists for this opportunity', status: 409 }
    }

    const bid = await dbTx.$transaction(async (tx) => {
      const created = await bidRepository.createInTransaction(tx, ctx.organizationId, { opportunityId, estimateId })
      if (!created) return null
      // P1-3: Create tender deliverables — use caller-specified requirements
      // or sensible defaults if not provided.
      // NOTE: These defaults are MVP defaults and are not the final industry/tender
      // requirement model. The full tender-requirement derivation will come later.
      const defaults: TenderDeliverableRequirement[] = requiredDeliverables ?? [
        { kind: 'boq', required: true },
        { kind: 'programme', required: true },
        { kind: 'method-statement', required: true },
        { kind: 'jha', required: true },
        { kind: 'assumptions', required: true },
      ]
      for (const d of defaults) {
        await tx.tenderDeliverable.create({
          data: { bidId: created.id, kind: d.kind, required: d.required, status: 'missing' },
        })
      }
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

    await dbTx.$transaction(async (tx) => {
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

    // P0-1: Load the FINALIZED revision via repository — verifies the FULL chain:
    //   revision → estimate → organization
    //   AND estimate.id === bid.estimateId
    //   AND estimate.opportunityId === bid.opportunityId
    // This prevents using a revision from a different estimate/opportunity
    // even within the same organization.
    const revision = await estimateRevisionRepositoryExtended.getFinalizedForBid(
      ctx.organizationId,
      bid.estimateId,
      bid.opportunityId,
      estimateRevisionId,
    )
    if (!revision) {
      return { ok: false, error: 'Finalized estimate revision not found for this bid\'s estimate and opportunity', status: 404 }
    }

    // P0-4: Derive system price from the immutable snapshot, not the mutable estimate.
    const replay = replayRevision(revision.snapshotJson)
    if (!replay.ok) {
      return { ok: false, error: 'Failed to replay revision snapshot for adjudication', status: 500 }
    }

    const systemSellPrice = replay.totalSellPrice
    const finalPrice = round2(systemSellPrice * (1 + directorAdjustment))

    await dbTx.$transaction(async (tx) => {
      await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        directorAdjustment,
        adjustmentRationale,
        finalPrice,
        systemSellPrice,
        adjudicatedRevisionId: estimateRevisionId,
        // P0-4: Set estimateRevisionId = adjudicatedRevisionId so the gate
        // and submission use the same revision.
        estimateRevisionId: estimateRevisionId,
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
   *
   * Y1/Y2: Programme revision is validated via Bid.programmeRevisionId →
   * ProgrammeRevision (tenant-scoped). The legacy TenderDeliverable(kind=
   * 'programme').revisionId path is DEPRECATED and no longer consulted.
   * Idempotent.
   */
  async submitBid(input: SubmitBidInput): Promise<{ ok: true; bidId: string; finalPrice: number; submittedAt: string } | Err> {
    const { ctx, bidId } = input

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

    // P0-3/P0-4: Validate required tender deliverables (status readiness only).
    // Y1/Y2: All kinds are now 'document-backed' for gate purposes. The
    // programme revision is validated separately below via ProgrammeRevision.
    const deliverables = await tenderDeliverableRepository.getForBid(ctx.organizationId, bidId)

    const missingRequired = deliverables.filter(
      (d) => d.required && d.status !== 'ready' && d.status !== 'finalized',
    )
    if (missingRequired.length > 0) {
      const missingNames = missingRequired.map((d) => d.kind).join(', ')
      return { ok: false, error: `Required deliverables not ready: ${missingNames}`, status: 400 }
    }

    // Y1/Y2/Z1: Validate the programme revision via the NEW ProgrammeRevision domain.
    // Z1: all validation is in the repository — no direct db.programme access in the service.
    // The repository method validates: finalized + same org + EXACT opportunity match
    // (null opportunityId on the Programme is rejected — a bid-associated programme
    // must belong to the same opportunity).
    let resolvedProgrammeRevisionId: string | null = bid.programmeRevisionId ?? null
    if (resolvedProgrammeRevisionId) {
      const progRev = await programmeRevisionRepo.getForBid(
        ctx.organizationId,
        resolvedProgrammeRevisionId,
        bid.opportunityId,
      )
      if (!progRev) {
        return {
          ok: false,
          error: 'Programme revision not found for this bid (not finalized, wrong org, or wrong opportunity)',
          status: 400,
        }
      }
    }

    // P0-1: Validate the adjudicated revision is still finalized AND belongs to this bid's estimate+opportunity.
    const revision = await estimateRevisionRepositoryExtended.getFinalizedForBid(
      ctx.organizationId, bid.estimateId, bid.opportunityId, bid.adjudicatedRevisionId,
    )
    if (!revision) {
      return { ok: false, error: 'Adjudicated estimate revision is no longer finalized or does not belong to this bid', status: 400 }
    }

    // P0-1 (final): validateBidSubmission must NOT use current mutable Estimate.status.
    // After adjudication, the frozen revision is the commercial truth — current
    // estimate status is irrelevant.
    const validation = validateBidSubmission({
      estimateRevisionId: bid.adjudicatedRevisionId,
      estimateStatus: 'adjudicated', // Always pass — the adjudicated revision IS the commercial truth
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
    const result = await dbTx.$transaction(async (tx) => {
      const updated = await bidRepository.updateInTransaction(tx, ctx.organizationId, bidId, {
        tenderPackStatus: 'submitted',
        submittedAt,
        estimateRevisionId: bid.adjudicatedRevisionId, // P0-5: submitted = adjudicated
        programmeRevisionId: resolvedProgrammeRevisionId, // Y1/Y2: from Bid.programmeRevisionId → ProgrammeRevision
      })
      if (!updated) throw new Error('Bid update failed in transaction')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'bid.submitted', entityType: 'Bid', entityId: bidId,
        summary: `Bid submitted: finalPrice=${bid.finalPrice ?? 0}, revision=${bid.adjudicatedRevisionId}`,
        afterJson: JSON.stringify({
          finalPrice: bid.finalPrice, estimateRevisionId: bid.adjudicatedRevisionId,
          programmeRevisionId: resolvedProgrammeRevisionId, // Y1/Y2: from ProgrammeRevision domain
          gateResult: workspace.gate.overall, submittedAt: submittedAt.toISOString(),
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

    await dbTx.$transaction(async (tx) => {
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

    await dbTx.$transaction(async (tx) => {
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
