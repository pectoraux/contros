/**
 * OpportunityService — application service for opportunity lifecycle, client
 * management, and scope package operations.
 *
 * This service is UPSTREAM of EstimateService, SubcontractService, and
 * BidService. It establishes the canonical representation of the initial
 * problem:
 *
 *   RFQ received → client / project → scope package → scope completeness
 *   → ready for estimating
 *
 * Architecture:
 *   RequestContext → Service → Repository → Engine → Transaction → Audit
 *
 * Key invariants:
 * - Every opportunity auto-creates a 1:1 ScopePackage (enforced by the repo).
 * - Every scope item/question mutation recomputes scopePackage.completeness
 *   via the pure computeScopeCompleteness engine and persists the float.
 * - Opportunity.status transitions are guarded by a legal-transitions state
 *   machine (analogous to BidService.tenderPackStatus).
 * - Transitioning to 'estimating' requires at least one scope item (soft
 *   business rule: don't start estimating an empty scope).
 * - All mutations are transactional (dbTx.$transaction) with audit log entries.
 * - No raw Prisma in the service — all access through tenant-scoped repositories.
 */

import { db, dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import { computeScopeCompleteness } from '@/lib/engines/scope-completeness'
import {
  clientRepository,
  opportunityRepository,
  scopePackageRepository,
  scopeItemRepository,
  scopeQuestionRepository,
  scopeAssumptionRepository,
  scopeEvidenceRepository,
  auditLogRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface ListClientsInput { ctx: RequestContext }
export interface CreateClientInput {
  ctx: RequestContext
  name: string
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  sector?: string | null
}

export interface ListOpportunitiesInput { ctx: RequestContext }
export interface GetOpportunityDetailInput { ctx: RequestContext; opportunityId: string }
export interface CreateOpportunityInput {
  ctx: RequestContext
  clientId: string
  title: string
  reference?: string | null
  source?: string | null
  description?: string | null
  submissionDeadline?: Date | null
  location?: string | null
  ownerId?: string | null
}
export interface UpdateOpportunityInput {
  ctx: RequestContext
  opportunityId: string
  title?: string
  reference?: string | null
  description?: string | null
  submissionDeadline?: Date | null
  location?: string | null
  ownerId?: string | null
}
export interface TransitionStatusInput {
  ctx: RequestContext
  opportunityId: string
  newStatus: string
}

export interface GetScopeWorkspaceInput { ctx: RequestContext; opportunityId: string }
export interface AddScopeItemInput {
  ctx: RequestContext
  opportunityId: string
  description: string
  category?: string | null
  status: string // known | missing | ambiguous
  origin?: string // client | inferred | ai | estimator
}
export interface UpdateScopeItemInput {
  ctx: RequestContext
  opportunityId: string
  itemId: string
  description?: string
  category?: string | null
  status?: string
  origin?: string
}
export interface RemoveScopeItemInput {
  ctx: RequestContext
  opportunityId: string
  itemId: string
}
export interface AddScopeQuestionInput {
  ctx: RequestContext
  opportunityId: string
  question: string
  category?: string | null
  interpretationA?: string | null
  interpretationB?: string | null
}
export interface ClarifyScopeQuestionInput {
  ctx: RequestContext
  opportunityId: string
  questionId: string
  selectedInterpretation?: string | null
  resolution?: string | null
  status?: string // open | clarified | assumed | resolved
}
export interface AddAssumptionInput {
  ctx: RequestContext
  opportunityId: string
  text: string
  rationale?: string | null
  riskLevel?: string // low | medium | high
}
export interface AcknowledgeAssumptionInput {
  ctx: RequestContext
  opportunityId: string
  assumptionId: string
}
export interface AddEvidenceInput {
  ctx: RequestContext
  opportunityId: string
  type: string // rfq | drawing | specification | client-boq | photo | email | note | ai-extraction
  summary: string
  reference?: string | null
}

// ─── Opportunity Status State Machine ───────────────────────────────────────
//
// The Opportunity.status field tracks the high-level pipeline position.
// It is DISTINCT from Bid.tenderPackStatus (which tracks the commercial
// workflow). OpportunityService owns Opportunity.status exclusively.
//
// States:
//   received          — RFQ just logged
//   qualifying        — being assessed for go/no-go
//   no-bid            — decision: not pursuing (terminal)
//   scope-development — actively building the scope package
//   estimating        — scope sufficiently complete to start estimating
//   internal-review   — estimate ready for internal review
//   adjudication      — in commercial adjudication
//   submitted         — bid submitted to client
//   clarification     — client requesting clarification
//   won               — awarded (terminal)
//   lost              — not awarded (terminal)
//   withdrawn         — pulled out (terminal)
//   lapsed            — deadline passed without submission (terminal)

const LEGAL_TRANSITIONS: Record<string, string[]> = {
  received: ['qualifying', 'no-bid', 'scope-development', 'lapsed', 'withdrawn'],
  qualifying: ['scope-development', 'no-bid', 'received', 'lapsed', 'withdrawn'],
  'scope-development': ['estimating', 'no-bid', 'qualifying', 'lapsed', 'withdrawn'],
  estimating: ['internal-review', 'no-bid', 'scope-development', 'withdrawn'],
  'internal-review': ['adjudication', 'estimating', 'no-bid', 'withdrawn'],
  adjudication: ['submitted', 'estimating', 'withdrawn'],
  submitted: ['clarification', 'won', 'lost', 'withdrawn'],
  clarification: ['won', 'lost', 'withdrawn'],
  no_bid: [],
  won: [],
  lost: [],
  withdrawn: [],
  lapsed: [],
}

function isLegalTransition(from: string, to: string): boolean {
  const allowed = LEGAL_TRANSITIONS[from]
  return allowed ? allowed.includes(to) : false
}

const VALID_STATUSES = [
  'received', 'qualifying', 'no-bid', 'scope-development', 'estimating',
  'internal-review', 'adjudication', 'submitted', 'clarification',
  'won', 'lost', 'withdrawn', 'lapsed',
]

const VALID_SCOPE_ITEM_STATUSES = ['known', 'missing', 'ambiguous']
const VALID_SCOPE_ITEM_ORIGINS = ['client', 'inferred', 'ai', 'estimator']
const VALID_QUESTION_STATUSES = ['open', 'clarified', 'assumed', 'resolved']
const VALID_RISK_LEVELS = ['low', 'medium', 'high']
const VALID_EVIDENCE_TYPES = [
  'rfq', 'drawing', 'specification', 'client-boq',
  'photo', 'email', 'note', 'ai-extraction',
]

// ─── OpportunityService ─────────────────────────────────────────────────────

export const opportunityService = {
  // ─── Clients ────────────────────────────────────────────────────────────

  /**
   * List all clients for the authenticated organization.
   */
  async listClients(input: ListClientsInput): Promise<{ ok: true; clients: Awaited<ReturnType<typeof clientRepository.listForOrganization>> } | Err> {
    const { ctx } = input
    const clients = await clientRepository.listForOrganization(ctx.organizationId)
    return { ok: true, clients }
  },

  /**
   * Create a client — transactional with audit.
   */
  async createClient(input: CreateClientInput): Promise<{ ok: true; clientId: string } | Err> {
    const { ctx, name, contactName, contactEmail, contactPhone, sector } = input

    if (!name || !name.trim()) {
      return { ok: false, error: 'Client name is required', status: 400 }
    }

    const client = await dbTx.$transaction(async (tx) => {
      const created = await clientRepository.createInTransaction(tx, ctx.organizationId, {
        name: name.trim(),
        contactName: contactName ?? null,
        contactEmail: contactEmail ?? null,
        contactPhone: contactPhone ?? null,
        sector: sector ?? null,
      })
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'client.created',
        entityType: 'Client',
        entityId: created.id,
        summary: `Client "${created.name}" created`,
        afterJson: JSON.stringify({ name: created.name, sector: created.sector }),
      })
      return created
    })

    return { ok: true, clientId: client.id }
  },

  // ─── Opportunities ──────────────────────────────────────────────────────

  /**
   * List opportunities for the organization — returns the serialized list
   * shape the frontend expects (OpportunityListItem[]).
   */
  async listOpportunities(input: ListOpportunitiesInput): Promise<{ ok: true; opportunities: unknown[] } | Err> {
    const { ctx } = input
    const raw = await opportunityRepository.listForOrganization(ctx.organizationId)

    const opportunities = raw.map((o) => {
      const latestEstimate = o.estimates[0]
      const estimateValue = latestEstimate
        ? latestEstimate.lines.reduce((s, l) => s + l.sellPrice, 0)
        : 0
      return {
        id: o.id,
        title: o.title,
        reference: o.reference,
        status: o.status,
        source: o.source,
        location: o.location,
        submissionDeadline: o.submissionDeadline,
        receivedAt: o.receivedAt,
        client: { id: o.client.id, name: o.client.name, sector: o.client.sector },
        owner: o.owner ? { id: o.owner.id, name: o.owner.name } : null,
        hasEstimate: !!latestEstimate,
        estimateId: latestEstimate?.id ?? null,
        estimateValue,
        estimateStatus: latestEstimate?.status ?? null,
        bidOutcome: o.bid?.outcome ?? null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      }
    })

    return { ok: true, opportunities }
  },

  /**
   * Get the full opportunity detail — returns the serialized shape the
   * frontend expects (OpportunityDetail). Includes scope package (with
   * all children), estimates, subcontract packages, bid, and audit logs.
   */
  async getOpportunityDetail(input: GetOpportunityDetailInput): Promise<{ ok: true; opportunity: unknown } | Err> {
    const { ctx, opportunityId } = input

    const opportunity = await opportunityRepository.getDetailForOrganization(
      ctx.organizationId, opportunityId,
    )
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }

    // Fetch audit logs referencing this opportunity or its child entities.
    const estimateIds = opportunity.estimates.map((e) => e.id)
    const lineIds = opportunity.estimates.flatMap((e) => e.lines.map((l) => l.id))
    const scopeItemIds = opportunity.scopePackage?.items.map((i) => i.id) ?? []
    const quoteIds = opportunity.subcontractPackages.flatMap((sp) => sp.quotes.map((q) => q.id))
    const relevantEntityIds = [opportunity.id, ...estimateIds, ...lineIds, ...scopeItemIds, ...quoteIds]

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

    // Helper: safely parse blockingInputsJson.
    const parseBlockingInputs = (json: string | null | undefined): unknown[] => {
      if (!json) return []
      try {
        const parsed: unknown = JSON.parse(json)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    // Serialize estimates.
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
          calculationStatus: l.calculationStatus,
          blockingInputs: parseBlockingInputs(l.blockingInputsJson),
          estimatedTotalCost: l.estimatedTotalCost,
          expectedProfit: l.expectedProfit,
          expectedMarginPct: l.expectedMarginPct,
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
            pricingBasis: seg.pricingBasis,
            quoteCoversSegmentScope: seg.quoteCoversSegmentScope,
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

    return {
      ok: true,
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
        organization: {
          id: opportunity.organization.id,
          name: opportunity.organization.name,
          currency: opportunity.organization.currency,
        },
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
            valueWeight: a.valueWeight,
          })),
          lines: sp.lines.map((l) => ({
            id: l.id,
            requiredScope: l.requiredScope,
            estimateLineId: l.estimateLineId,
            estimateLine: l.estimateLine
              ? {
                  id: l.estimateLine.id,
                  description: l.estimateLine.description,
                  sellPrice: l.estimateLine.sellPrice,
                  unit: l.estimateLine.unit,
                  quantity: l.estimateLine.quantity,
                }
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
    }
  },

  /**
   * Create an opportunity from an RFQ. Auto-creates the 1:1 ScopePackage.
   * Transactional with audit.
   */
  async createOpportunity(input: CreateOpportunityInput): Promise<{ ok: true; opportunityId: string } | Err> {
    const { ctx, clientId, title, reference, source, description, submissionDeadline, location, ownerId } = input

    if (!title || !title.trim()) {
      return { ok: false, error: 'Opportunity title is required', status: 400 }
    }
    if (!clientId) {
      return { ok: false, error: 'Client is required', status: 400 }
    }

    const opportunity = await dbTx.$transaction(async (tx) => {
      const created = await opportunityRepository.createInTransaction(tx, ctx.organizationId, {
        clientId,
        title: title.trim(),
        reference: reference ?? null,
        source: source ?? null,
        description: description ?? null,
        submissionDeadline: submissionDeadline ?? null,
        location: location ?? null,
        ownerId: ownerId ?? null,
      })
      if (!created) return null

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'opportunity.created',
        entityType: 'Opportunity',
        entityId: created.id,
        summary: `Opportunity "${created.title}" created`,
        afterJson: JSON.stringify({
          title: created.title, clientId, status: 'received',
          reference: created.reference, source: created.source,
        }),
      })
      return created
    })

    if (!opportunity) {
      return { ok: false, error: 'Client not found in this organization', status: 404 }
    }
    return { ok: true, opportunityId: opportunity.id }
  },

  /**
   * Update opportunity metadata. Transactional with audit.
   */
  async updateOpportunity(input: UpdateOpportunityInput): Promise<{ ok: true } | Err> {
    const { ctx, opportunityId, title, reference, description, submissionDeadline, location, ownerId } = input

    const existing = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!existing) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }

    const data: Record<string, unknown> = {}
    if (title !== undefined) data.title = title
    if (reference !== undefined) data.reference = reference
    if (description !== undefined) data.description = description
    if (submissionDeadline !== undefined) data.submissionDeadline = submissionDeadline
    if (location !== undefined) data.location = location
    if (ownerId !== undefined) data.ownerId = ownerId

    if (Object.keys(data).length === 0) {
      return { ok: true } // Nothing to update
    }

    await dbTx.$transaction(async (tx) => {
      const updated = await opportunityRepository.updateInTransaction(tx, ctx.organizationId, opportunityId, data)
      if (!updated) throw new Error('Opportunity update failed')
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'opportunity.updated',
        entityType: 'Opportunity',
        entityId: opportunityId,
        summary: `Opportunity "${existing.title}" updated`,
        afterJson: JSON.stringify(data),
      })
    })

    return { ok: true }
  },

  /**
   * Transition the opportunity status — enforces the state machine.
   *
   * Business rule: transitioning to 'estimating' requires at least one
   * scope item. Don't start estimating an empty scope.
   */
  async transitionStatus(input: TransitionStatusInput): Promise<{ ok: true; newStatus: string; completeness: number } | Err> {
    const { ctx, opportunityId, newStatus } = input

    if (!VALID_STATUSES.includes(newStatus)) {
      return { ok: false, error: `Invalid status: ${newStatus}`, status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }

    const currentStatus = opportunity.status
    if (currentStatus === newStatus) {
      // Idempotent — return current completeness
      const completeness = opportunity.scopePackage?.completeness ?? 0
      return { ok: true, newStatus, completeness }
    }

    if (!isLegalTransition(currentStatus, newStatus)) {
      return { ok: false, error: `Illegal status transition: ${currentStatus} → ${newStatus}`, status: 400 }
    }

    // Business rule: estimating requires at least one scope item.
    if (newStatus === 'estimating') {
      const itemCount = opportunity.scopePackage?.items.length ?? 0
      if (itemCount === 0) {
        return {
          ok: false,
          error: 'Cannot transition to estimating — scope package has no items. Add at least one scope item first.',
          status: 400,
        }
      }
    }

    // Compute current completeness for the audit record.
    const completeness = opportunity.scopePackage?.completeness ?? 0

    await dbTx.$transaction(async (tx) => {
      const updated = await opportunityRepository.updateStatusInTransaction(
        tx, ctx.organizationId, opportunityId, newStatus,
      )
      if (!updated) throw new Error('Status update failed')
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'opportunity.status-changed',
        entityType: 'Opportunity',
        entityId: opportunityId,
        summary: `Opportunity status: ${currentStatus} → ${newStatus}`,
        afterJson: JSON.stringify({ from: currentStatus, to: newStatus, completeness }),
      })
    })

    return { ok: true, newStatus, completeness }
  },

  // ─── Scope Package ──────────────────────────────────────────────────────

  /**
   * Get the scope workspace — the scope package with all children plus
   * the computed completeness breakdown.
   */
  async getScopeWorkspace(input: GetScopeWorkspaceInput): Promise<{ ok: true; scopePackage: unknown; completeness: unknown } | Err> {
    const { ctx, opportunityId } = input

    const scopePackage = await scopePackageRepository.getForOpportunity(ctx.organizationId, opportunityId)
    if (!scopePackage) {
      // The opportunity might exist but have no scope package — check.
      const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
      if (!opportunity) {
        return { ok: false, error: 'Opportunity not found', status: 404 }
      }
      // Scope package should always exist (auto-created), but handle gracefully.
      return {
        ok: true,
        scopePackage: null,
        completeness: { score: 0, knownCount: 0, missingCount: 0, ambiguousCount: 0, known: [], missing: [], ambiguous: [], openQuestions: 0 },
      }
    }

    const completeness = computeScopeCompleteness(
      scopePackage.items.map((i) => ({
        description: i.description,
        status: i.status as 'known' | 'missing' | 'ambiguous',
        category: i.category ?? undefined,
      })),
      scopePackage.questions.map((q) => ({ status: q.status })),
    )

    return { ok: true, scopePackage, completeness }
  },

  // ─── Scope Items ────────────────────────────────────────────────────────

  /**
   * Add a scope item. Recomputes completeness. Transactional with audit.
   */
  async addScopeItem(input: AddScopeItemInput): Promise<{ ok: true; itemId: string; score: number } | Err> {
    const { ctx, opportunityId, description, category, status, origin } = input

    if (!description || !description.trim()) {
      return { ok: false, error: 'Scope item description is required', status: 400 }
    }
    if (!VALID_SCOPE_ITEM_STATUSES.includes(status)) {
      return { ok: false, error: `Invalid scope item status: ${status}. Must be known, missing, or ambiguous.`, status: 400 }
    }
    if (origin && !VALID_SCOPE_ITEM_ORIGINS.includes(origin)) {
      return { ok: false, error: `Invalid scope item origin: ${origin}`, status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found for this opportunity', status: 404 }
    }

    const scopePackageId = opportunity.scopePackage.id

    const result = await dbTx.$transaction(async (tx) => {
      const item = await scopeItemRepository.createInTransaction(tx, ctx.organizationId, scopePackageId, {
        description: description.trim(),
        category: category ?? null,
        status,
        origin: origin ?? 'client',
      })
      if (!item) throw new Error('Scope item creation failed')

      const score = await scopePackageRepository.recomputeCompletenessInTransaction(
        tx, ctx.organizationId, opportunityId,
      )

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.item-added',
        entityType: 'ScopeItem',
        entityId: item.id,
        summary: `Scope item added: "${description.trim()}" (${status})`,
        afterJson: JSON.stringify({ description: description.trim(), status, category: category ?? null, origin: origin ?? 'client', completeness: score }),
      })

      return { item, score }
    })

    return { ok: true, itemId: result.item.id, score: result.score ?? 0 }
  },

  /**
   * Update a scope item. Recomputes completeness. Transactional with audit.
   */
  async updateScopeItem(input: UpdateScopeItemInput): Promise<{ ok: true; score: number } | Err> {
    const { ctx, opportunityId, itemId, description, category, status, origin } = input

    if (status && !VALID_SCOPE_ITEM_STATUSES.includes(status)) {
      return { ok: false, error: `Invalid scope item status: ${status}`, status: 400 }
    }
    if (origin && !VALID_SCOPE_ITEM_ORIGINS.includes(origin)) {
      return { ok: false, error: `Invalid scope item origin: ${origin}`, status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const data: Record<string, unknown> = {}
    if (description !== undefined) data.description = description
    if (category !== undefined) data.category = category
    if (status !== undefined) data.status = status
    if (origin !== undefined) data.origin = origin

    if (Object.keys(data).length === 0) {
      return { ok: true, score: opportunity.scopePackage.completeness }
    }

    const score = await dbTx.$transaction(async (tx) => {
      const updated = await scopeItemRepository.updateInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id, itemId, data,
      )
      if (!updated) throw new Error('Scope item not found or does not belong to this opportunity')

      const newScore = await scopePackageRepository.recomputeCompletenessInTransaction(
        tx, ctx.organizationId, opportunityId,
      )

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.item-updated',
        entityType: 'ScopeItem',
        entityId: itemId,
        summary: `Scope item updated`,
        afterJson: JSON.stringify({ ...data, completeness: newScore }),
      })

      return newScore
    })

    return { ok: true, score: score ?? 0 }
  },

  /**
   * Remove a scope item. Recomputes completeness. Transactional with audit.
   */
  async removeScopeItem(input: RemoveScopeItemInput): Promise<{ ok: true; score: number } | Err> {
    const { ctx, opportunityId, itemId } = input

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const score = await dbTx.$transaction(async (tx) => {
      const deleted = await scopeItemRepository.deleteInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id, itemId,
      )
      if (!deleted) throw new Error('Scope item not found or does not belong to this opportunity')

      const newScore = await scopePackageRepository.recomputeCompletenessInTransaction(
        tx, ctx.organizationId, opportunityId,
      )

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.item-removed',
        entityType: 'ScopeItem',
        entityId: itemId,
        summary: `Scope item removed`,
        afterJson: JSON.stringify({ completeness: newScore }),
      })

      return newScore
    })

    return { ok: true, score: score ?? 0 }
  },

  // ─── Scope Questions ────────────────────────────────────────────────────

  /**
   * Add a scope question. Recomputes completeness (open questions affect the
   * completeness result). Transactional with audit.
   */
  async addScopeQuestion(input: AddScopeQuestionInput): Promise<{ ok: true; questionId: string; score: number } | Err> {
    const { ctx, opportunityId, question, category, interpretationA, interpretationB } = input

    if (!question || !question.trim()) {
      return { ok: false, error: 'Question text is required', status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const result = await dbTx.$transaction(async (tx) => {
      const q = await scopeQuestionRepository.createInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id,
        { question: question.trim(), category: category ?? null, interpretationA: interpretationA ?? null, interpretationB: interpretationB ?? null },
      )
      if (!q) throw new Error('Scope question creation failed')

      const score = await scopePackageRepository.recomputeCompletenessInTransaction(
        tx, ctx.organizationId, opportunityId,
      )

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.question-added',
        entityType: 'ScopeQuestion',
        entityId: q.id,
        summary: `Scope question added: "${question.trim().substring(0, 80)}"`,
        afterJson: JSON.stringify({ question: question.trim(), completeness: score }),
      })

      return { q, score }
    })

    return { ok: true, questionId: result.q.id, score: result.score ?? 0 }
  },

  /**
   * Clarify/resolve a scope question. Recomputes completeness (resolving an
   * open question may change the openQuestions count). Transactional with audit.
   */
  async clarifyScopeQuestion(input: ClarifyScopeQuestionInput): Promise<{ ok: true; score: number } | Err> {
    const { ctx, opportunityId, questionId, selectedInterpretation, resolution, status } = input

    if (status && !VALID_QUESTION_STATUSES.includes(status)) {
      return { ok: false, error: `Invalid question status: ${status}`, status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const data: Record<string, unknown> = {}
    if (selectedInterpretation !== undefined) data.selectedInterpretation = selectedInterpretation
    if (resolution !== undefined) data.resolution = resolution
    if (status !== undefined) data.status = status

    if (Object.keys(data).length === 0) {
      return { ok: true, score: opportunity.scopePackage.completeness }
    }

    const score = await dbTx.$transaction(async (tx) => {
      const updated = await scopeQuestionRepository.updateInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id, questionId, data,
      )
      if (!updated) throw new Error('Scope question not found or does not belong to this opportunity')

      const newScore = await scopePackageRepository.recomputeCompletenessInTransaction(
        tx, ctx.organizationId, opportunityId,
      )

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.question-clarified',
        entityType: 'ScopeQuestion',
        entityId: questionId,
        summary: `Scope question ${status ?? 'updated'}`,
        afterJson: JSON.stringify({ ...data, completeness: newScore }),
      })

      return newScore
    })

    return { ok: true, score: score ?? 0 }
  },

  // ─── Assumptions ────────────────────────────────────────────────────────

  /**
   * Add a scope assumption. Transactional with audit.
   * Assumptions don't affect the completeness score (they're risk records,
   * not scope coverage), so no recompute is needed.
   */
  async addAssumption(input: AddAssumptionInput): Promise<{ ok: true; assumptionId: string } | Err> {
    const { ctx, opportunityId, text, rationale, riskLevel } = input

    if (!text || !text.trim()) {
      return { ok: false, error: 'Assumption text is required', status: 400 }
    }
    if (riskLevel && !VALID_RISK_LEVELS.includes(riskLevel)) {
      return { ok: false, error: `Invalid risk level: ${riskLevel}`, status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const assumption = await dbTx.$transaction(async (tx) => {
      const created = await scopeAssumptionRepository.createInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id,
        { text: text.trim(), rationale: rationale ?? null, riskLevel: riskLevel ?? 'medium' },
      )
      if (!created) throw new Error('Assumption creation failed')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.assumption-added',
        entityType: 'ScopeAssumption',
        entityId: created.id,
        summary: `Assumption added: "${text.trim().substring(0, 80)}" (risk: ${riskLevel ?? 'medium'})`,
        afterJson: JSON.stringify({ text: text.trim(), riskLevel: riskLevel ?? 'medium' }),
      })

      return created
    })

    return { ok: true, assumptionId: assumption.id }
  },

  /**
   * Acknowledge a scope assumption. Transactional with audit.
   * Acknowledged assumptions don't block the pre-submission gate.
   */
  async acknowledgeAssumption(input: AcknowledgeAssumptionInput): Promise<{ ok: true } | Err> {
    const { ctx, opportunityId, assumptionId } = input

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    await dbTx.$transaction(async (tx) => {
      const updated = await scopeAssumptionRepository.acknowledgeInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id, assumptionId,
      )
      if (!updated) throw new Error('Assumption not found or does not belong to this opportunity')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.assumption-acknowledged',
        entityType: 'ScopeAssumption',
        entityId: assumptionId,
        summary: `Assumption acknowledged`,
      })
    })

    return { ok: true }
  },

  // ─── Evidence ───────────────────────────────────────────────────────────

  /**
   * Add a scope evidence record. Transactional with audit.
   * Evidence is provenance — doesn't affect completeness.
   */
  async addEvidence(input: AddEvidenceInput): Promise<{ ok: true; evidenceId: string } | Err> {
    const { ctx, opportunityId, type, summary, reference } = input

    if (!type || !VALID_EVIDENCE_TYPES.includes(type)) {
      return { ok: false, error: `Invalid evidence type: ${type}`, status: 400 }
    }
    if (!summary || !summary.trim()) {
      return { ok: false, error: 'Evidence summary is required', status: 400 }
    }

    const opportunity = await opportunityRepository.getForOrganization(ctx.organizationId, opportunityId)
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found', status: 404 }
    }
    if (!opportunity.scopePackage) {
      return { ok: false, error: 'Scope package not found', status: 404 }
    }

    const evidence = await dbTx.$transaction(async (tx) => {
      const created = await scopeEvidenceRepository.createInTransaction(
        tx, ctx.organizationId, opportunity.scopePackage!.id,
        { type, summary: summary.trim(), reference: reference ?? null },
      )
      if (!created) throw new Error('Evidence creation failed')

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'scope.evidence-added',
        entityType: 'ScopeEvidence',
        entityId: created.id,
        summary: `Evidence added: ${type} — "${summary.trim().substring(0, 80)}"`,
        afterJson: JSON.stringify({ type, summary: summary.trim(), reference: reference ?? null }),
      })

      return created
    })

    return { ok: true, evidenceId: evidence.id }
  },
}
