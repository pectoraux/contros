/**
 * Opportunity / Client / Scope / Member repositories — tenant-aware.
 *
 * These repositories make unscoped retrieval impossible to express — every
 * method requires orgId and verifies the full ownership chain:
 *
 *   Client            → organizationId
 *   Opportunity       → organizationId
 *   ScopePackage      → opportunity.organizationId
 *   ScopeItem         → scopePackage.opportunity.organizationId
 *   ScopeQuestion     → scopePackage.opportunity.organizationId
 *   ScopeAssumption   → scopePackage.opportunity.organizationId
 *   ScopeEvidence     → scopePackage.opportunity.organizationId
 *   User (as owner)   → organizationId
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * A repository must never return an org-owned entity solely from an
 * attacker-supplied ID.
 *
 * Convention: use findFirst (not findUnique) with explicit organizationId
 * filter, so the tenant-safety source-code audit passes.
 *
 * P0 hardening: the detail graph loader does NOT blindly trust FK relations.
 * It verifies nested ownership (WorkDefinition.organizationId,
 * WorkDefinitionVersion → WorkDefinition, SubcontractPackageLine.estimateLine
 * → same org) and surfaces `graphInconsistent=true` with diagnostics when a
 * cross-tenant relationship is detected, rather than silently serializing
 * foreign commercial data as though it were valid.
 */

import { db } from '@/lib/db'
import type { PrismaTransaction } from './index'

// ─── User / Member Repository ───────────────────────────────────────────────
//
// Used to validate that an `ownerId` belongs to the current organization
// before assigning it to an Opportunity. Without this check, a caller could
// assign a foreign-org user as the owner of an opportunity, leaking their
// existence across tenants.

export const userRepository = {
  /**
   * Verify a user belongs to the given organization.
   * Returns the user's id + name if they do, null otherwise.
   * Never reveals cross-tenant user existence to the caller — null is null.
   */
  async getForOrganization(orgId: string, userId: string) {
    return db.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { id: true, name: true, email: true, role: true },
    })
  },
}
// ─── Client Repository ──────────────────────────────────────────────────────

export const clientRepository = {
  /** List all clients for an organization. */
  async listForOrganization(orgId: string) {
    return db.client.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    })
  },

  /** Get a single client, tenant-scoped. Returns null if not found or cross-org. */
  async getForOrganization(orgId: string, clientId: string) {
    return db.client.findFirst({
      where: { id: clientId, organizationId: orgId },
    })
  },

  /** Create a client within a transaction. */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      name: string
      contactName?: string | null
      contactEmail?: string | null
      contactPhone?: string | null
      sector?: string | null
    },
  ) {
    return tx.client.create({
      data: { organizationId: orgId, ...data },
    })
  },

  /** Create a client (non-transactional). */
  async create(orgId: string, data: {
    name: string
    contactName?: string | null
    contactEmail?: string | null
    contactPhone?: string | null
    sector?: string | null
  }) {
    return db.client.create({
      data: { organizationId: orgId, ...data },
    })
  },
}

// ─── Opportunity Repository ─────────────────────────────────────────────────

export const opportunityRepository = {
  /**
   * List opportunities for an organization, with client, owner, latest
   * estimate (+ lines), and bid. Used by the opportunities list view.
   */
  async listForOrganization(orgId: string) {
    return db.opportunity.findMany({
      where: { organizationId: orgId },
      include: {
        client: true,
        owner: true,
        estimates: {
          include: { lines: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        bid: true,
      },
      orderBy: { updatedAt: 'desc' },
    })
  },

  /**
   * Get the full detail graph for an opportunity — scope package (with all
   * children), estimates (with lines + revisions), subcontract packages,
   * bid, client, owner, organization. Used by the detail view.
   *
   * This is the canonical "load everything" query. It includes
   * scopePackage.evidence (which bidRepository.getOpportunityBidWorkspace
   * intentionally omits — the gate doesn't need evidence).
   */
  async getDetailForOrganization(orgId: string, opportunityId: string) {
    return db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: orgId },
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
  },

  /**
   * Get a lightweight opportunity record (no heavy includes) — used for
   * ownership verification and status transitions.
   * Includes scope package with items, questions, AND assumptions — the
   * assumptions are needed for the estimating-readiness rule (unacknowledged
   * high-risk assumptions block the estimating transition).
   */
  async getForOrganization(orgId: string, opportunityId: string) {
    return db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: orgId },
      include: {
        scopePackage: {
          include: { items: true, questions: true, assumptions: true },
        },
      },
    })
  },

  /**
   * Create an opportunity + an empty scope package (1:1) within a transaction.
   * Every opportunity starts with a scope package so scope mutations always
   * have a target.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      clientId: string
      title: string
      reference?: string | null
      source?: string | null
      description?: string | null
      submissionDeadline?: Date | null
      location?: string | null
      ownerId?: string | null
    },
  ) {
    // Verify the client belongs to this org before creating.
    const client = await tx.client.findFirst({
      where: { id: data.clientId, organizationId: orgId },
      select: { id: true },
    })
    if (!client) return null

    const opportunity = await tx.opportunity.create({
      data: {
        organizationId: orgId,
        clientId: data.clientId,
        title: data.title,
        reference: data.reference ?? null,
        source: data.source ?? null,
        description: data.description ?? null,
        submissionDeadline: data.submissionDeadline ?? null,
        location: data.location ?? null,
        ownerId: data.ownerId ?? null,
        status: 'received',
      },
    })

    // Auto-create the 1:1 scope package.
    await tx.scopePackage.create({
      data: {
        opportunityId: opportunity.id,
        completeness: 0,
        origin: 'rfq',
      },
    })

    return opportunity
  },

  /** Update opportunity metadata within a transaction. */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    opportunityId: string,
    data: {
      title?: string
      reference?: string | null
      description?: string | null
      submissionDeadline?: Date | null
      location?: string | null
      ownerId?: string | null
    },
  ) {
    const updated = await tx.opportunity.updateMany({
      where: { id: opportunityId, organizationId: orgId },
      data,
    })
    return updated.count > 0
  },

  /** Update opportunity status within a transaction. */
  async updateStatusInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    opportunityId: string,
    status: string,
  ) {
    const updated = await tx.opportunity.updateMany({
      where: { id: opportunityId, organizationId: orgId },
      data: { status },
    })
    return updated.count > 0
  },
}

// ─── Scope Package Repository ───────────────────────────────────────────────

export const scopePackageRepository = {
  /**
   * Get the scope package for an opportunity, with all children (items,
   * questions, assumptions, evidence). Tenant-scoped via opportunity → org.
   */
  async getForOpportunity(orgId: string, opportunityId: string) {
    return db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      include: {
        items: true,
        questions: true,
        assumptions: true,
        evidence: true,
      },
    })
  },

  /**
   * Recompute scopePackage.completeness from the current items + questions,
   * and persist the float. Returns the new score.
   *
   * This MUST be called after every scope item/question mutation to keep
   * the cached completeness field in sync with reality.
   *
   * Uses computeScopeCompleteness internally — the same pure engine the
   * pre-submission gate uses — so the score is always consistent with what
   * the gate sees.
   */
  async recomputeCompletenessInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    opportunityId: string,
  ): Promise<number | null> {
    // Load the scope package + items + questions, tenant-scoped.
    const scopePackage = await tx.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      include: { items: true, questions: true },
    })
    if (!scopePackage) return null

    // Import the engine lazily to avoid a circular import at module load.
    const { computeScopeCompleteness } = await import('@/lib/engines/scope-completeness')

    const result = computeScopeCompleteness(
      scopePackage.items.map((i) => ({
        description: i.description,
        status: i.status as 'known' | 'missing' | 'ambiguous',
      })),
      scopePackage.questions.map((q) => ({ status: q.status })),
    )

    await tx.scopePackage.update({
      where: { id: scopePackage.id },
      data: { completeness: result.score },
    })

    return result.score
  },
}

// ─── Scope Item Repository ──────────────────────────────────────────────────
//
// ScopeItem has no direct organizationId — ownership flows through
// scopePackage → opportunity → organization. Every method verifies this chain.

export const scopeItemRepository = {
  /** Create a scope item within a transaction. Verifies scopePackage → org. */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    data: {
      description: string
      category?: string | null
      status: string
      origin?: string
      confidence?: number
    },
  ) {
    // Verify ownership: scopePackage → opportunity → org
    const scopePackage = await tx.scopePackage.findFirst({
      where: {
        id: scopePackageId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return null

    return tx.scopeItem.create({
      data: {
        scopePackageId,
        description: data.description,
        category: data.category ?? null,
        status: data.status,
        origin: data.origin ?? 'client',
        confidence: data.confidence ?? 1,
      },
    })
  },

  /** Update a scope item within a transaction. Verifies ownership chain. */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    itemId: string,
    data: {
      description?: string
      category?: string | null
      status?: string
      origin?: string
      confidence?: number
    },
  ) {
    const updated = await tx.scopeItem.updateMany({
      where: {
        id: itemId,
        scopePackageId,
        scopePackage: { opportunity: { organizationId: orgId } },
      },
      data,
    })
    return updated.count > 0
  },

  /** Delete a scope item within a transaction. Verifies ownership chain. */
  async deleteInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    itemId: string,
  ) {
    const deleted = await tx.scopeItem.deleteMany({
      where: {
        id: itemId,
        scopePackageId,
        scopePackage: { opportunity: { organizationId: orgId } },
      },
    })
    return deleted.count > 0
  },
}

// ─── Scope Question Repository ──────────────────────────────────────────────

export const scopeQuestionRepository = {
  /** Create a scope question within a transaction. Verifies ownership chain. */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    data: {
      question: string
      category?: string | null
      interpretationA?: string | null
      interpretationB?: string | null
    },
  ) {
    const scopePackage = await tx.scopePackage.findFirst({
      where: {
        id: scopePackageId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return null

    return tx.scopeQuestion.create({
      data: {
        scopePackageId,
        question: data.question,
        category: data.category ?? null,
        interpretationA: data.interpretationA ?? null,
        interpretationB: data.interpretationB ?? null,
        status: 'open',
      },
    })
  },

  /** Update/clarify a scope question within a transaction. Verifies ownership. */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    questionId: string,
    data: {
      selectedInterpretation?: string | null
      resolution?: string | null
      status?: string
      costImpact?: number
      programmeImpact?: number
    },
  ) {
    const updated = await tx.scopeQuestion.updateMany({
      where: {
        id: questionId,
        scopePackageId,
        scopePackage: { opportunity: { organizationId: orgId } },
      },
      data,
    })
    return updated.count > 0
  },
}

// ─── Scope Assumption Repository ────────────────────────────────────────────

export const scopeAssumptionRepository = {
  /** Create a scope assumption within a transaction. Verifies ownership. */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    data: {
      text: string
      rationale?: string | null
      riskLevel?: string
    },
  ) {
    const scopePackage = await tx.scopePackage.findFirst({
      where: {
        id: scopePackageId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return null

    return tx.scopeAssumption.create({
      data: {
        scopePackageId,
        text: data.text,
        rationale: data.rationale ?? null,
        riskLevel: data.riskLevel ?? 'medium',
        acknowledged: false,
      },
    })
  },

  /** Mark an assumption as acknowledged within a transaction. Verifies ownership. */
  async acknowledgeInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    assumptionId: string,
  ) {
    const updated = await tx.scopeAssumption.updateMany({
      where: {
        id: assumptionId,
        scopePackageId,
        scopePackage: { opportunity: { organizationId: orgId } },
      },
      data: { acknowledged: true },
    })
    return updated.count > 0
  },
}

// ─── Scope Evidence Repository ──────────────────────────────────────────────

export const scopeEvidenceRepository = {
  /** Create a scope evidence record within a transaction. Verifies ownership. */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    scopePackageId: string,
    data: {
      type: string
      summary: string
      reference?: string | null
    },
  ) {
    const scopePackage = await tx.scopePackage.findFirst({
      where: {
        id: scopePackageId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return null

    return tx.scopeEvidence.create({
      data: {
        scopePackageId,
        type: data.type,
        summary: data.summary,
        reference: data.reference ?? null,
      },
    })
  },
}

// ─── Audit Log Workspace Repository ─────────────────────────────────────────
//
// P0: The application service must contain ZERO direct db.auditLog.find*
// calls. This repository owns audit-log retrieval, tenant-scoped.

export const auditLogWorkspaceRepository = {
  /**
   * Get audit logs for an opportunity workspace — references the opportunity
   * itself OR any of its child entities (estimates, estimate lines, scope
   * items, subcontract quotes). Also includes AI assistant actions.
   *
   * Tenant-scoped: organizationId filter is always applied.
   *
   * Returns the most recent 30 entries with the actor included.
   */
  async getForOpportunityWorkspace(
    orgId: string,
    relevantEntityIds: string[],
  ) {
    if (relevantEntityIds.length === 0) return []
    return db.auditLog.findMany({
      where: {
        organizationId: orgId,
        OR: [
          { entityId: { in: relevantEntityIds } },
          { action: { contains: 'ai.assistant' } },
        ],
      },
      include: { actor: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
  },
}

// ─── Opportunity Detail Graph — Hardened Loader ────────────────────────────
//
// P0: The detail graph is loaded in TWO phases:
//   1. Load the opportunity + scope package + estimates + subcontract packages
//      via the standard tenant-scoped findFirst (root is organizationId-filtered).
//   2. For nested organization-owned entities (WorkDefinition, WorkDefinitionVersion),
//      verify their organizationId matches ctx.organizationId. For nested
//      cross-references (SubcontractPackageLine.estimateLine), verify the
//      estimateLine belongs to the same organization.
//
// If any nested entity is cross-tenant inconsistent, we DO NOT silently
// serialize it as valid. We surface `graphInconsistent=true` with a
// diagnostic describing the broken relationship, and we strip the foreign
// commercial data from the response.
//
// This mirrors the SubcontractService graph-inconsistency philosophy.

export interface GraphInconsistency {
  path: string       // e.g. "estimates[0].lines[2].workDefinition"
  reason: string     // e.g. "WorkDefinition belongs to a different organization"
  entityId: string   // the foreign entity's id (for audit/diagnostic)
}

export interface HardenedOpportunityDetail {
  opportunity: Awaited<ReturnType<typeof opportunityRepository.getDetailForOrganization>>
  graphInconsistent: boolean
  inconsistencies: GraphInconsistency[]
}

export const opportunityDetailGraphRepository = {
  /**
   * Load the opportunity detail graph AND verify nested ownership.
   *
   * Returns:
   *   - opportunity: the raw Prisma graph (may contain foreign nested entities)
   *   - graphInconsistent: true if any nested entity fails ownership verification
   *   - inconsistencies: diagnostic list of broken relationships
   *
   * The service layer is responsible for stripping/serializing based on
   * graphInconsistent. This repository only DETECTS — it does not mutate.
   */
  async loadHardenedForOrganization(
    orgId: string,
    opportunityId: string,
  ): Promise<HardenedOpportunityDetail | null> {
    const opportunity = await opportunityRepository.getDetailForOrganization(orgId, opportunityId)
    if (!opportunity) return null

    const inconsistencies: GraphInconsistency[] = []

    // ─── Verify EstimateLine → WorkDefinition ownership ────────────────────
    // WorkDefinition has its own organizationId. An EstimateLine may reference
    // a WorkDefinition from another org (e.g. via direct DB manipulation or
    // a past bug). We must not expose that foreign WD's code/name/recipe.
    for (const estimate of opportunity.estimates) {
      for (const line of estimate.lines) {
        if (line.workDefinition && line.workDefinition.organizationId !== orgId) {
          inconsistencies.push({
            path: `estimates[${estimate.id}].lines[${line.id}].workDefinition`,
            reason: `WorkDefinition belongs to organization ${line.workDefinition.organizationId}, not ${orgId}`,
            entityId: line.workDefinition.id,
          })
        }
        // ─── Verify EstimateLine → WorkDefinitionVersion → WorkDefinition ──
        // WDV doesn't have its own organizationId — ownership flows through WD.
        // Two inconsistency cases:
        //   (a) WDV's workDefinitionId doesn't match the line's workDefinitionId
        //       (broken FK chain — WDV belongs to a different WD).
        //   (b) The line's WorkDefinition is already flagged as cross-tenant.
        //       In that case the WDV is ALSO foreign (it belongs to that foreign
        //       WD), so we must flag it too — otherwise we'd strip the WD but
        //       still expose the WDV's cost recipe, hazards, etc.
        if (line.workDefinitionVersion) {
          const wdMismatch = line.workDefinition &&
            line.workDefinitionVersion.workDefinitionId !== line.workDefinition.id
          const wdForeign = line.workDefinition &&
            line.workDefinition.organizationId !== orgId
          if (wdMismatch || wdForeign) {
            inconsistencies.push({
              path: `estimates[${estimate.id}].lines[${line.id}].workDefinitionVersion`,
              reason: wdForeign
                ? 'WorkDefinitionVersion belongs to a foreign-organization WorkDefinition'
                : 'WorkDefinitionVersion does not belong to the line\'s WorkDefinition',
              entityId: line.workDefinitionVersion.id,
            })
          }
        }
        // ─── Verify EstimateLine → ScopeItem ownership ─────────────────────
        // ScopeItem ownership flows through scopePackage → opportunity → org.
        // If the scopeItem's scopePackage.opportunityId !== this opportunity's id,
        // it's a cross-opportunity leak (even within the same org).
        if (line.scopeItem) {
          // We can't directly check scopeItem.scopePackage.opportunityId here
          // because the include didn't load that deep. But if the scopeItem
          // appears on a line of an estimate that belongs to THIS opportunity,
          // and the scopeItem belongs to a DIFFERENT opportunity's scope package,
          // that's a graph inconsistency. We detect this by checking if the
          // scopeItem id appears in THIS opportunity's scope package.
          const ownScopeItemIds = opportunity.scopePackage?.items.map((i) => i.id) ?? []
          if (!ownScopeItemIds.includes(line.scopeItem.id)) {
            inconsistencies.push({
              path: `estimates[${estimate.id}].lines[${line.id}].scopeItem`,
              reason: 'ScopeItem does not belong to this opportunity\'s scope package',
              entityId: line.scopeItem.id,
            })
          }
        }
      }
    }

    // ─── Verify SubcontractPackageLine → EstimateLine ownership ────────────
    // SubcontractPackageLine.estimateLineId references an EstimateLine.
    // That EstimateLine must belong to an Estimate that belongs to THIS
    // opportunity (and thus this org). If the estimateLine belongs to a
    // different opportunity/org, we must not expose its sellPrice.
    const ownEstimateLineIds = new Set(
      opportunity.estimates.flatMap((e) => e.lines.map((l) => l.id)),
    )
    for (const sp of opportunity.subcontractPackages) {
      for (const pkgLine of sp.lines) {
        if (pkgLine.estimateLine && !ownEstimateLineIds.has(pkgLine.estimateLine.id)) {
          inconsistencies.push({
            path: `subcontractPackages[${sp.id}].lines[${pkgLine.id}].estimateLine`,
            reason: 'SubcontractPackageLine references an EstimateLine that does not belong to this opportunity',
            entityId: pkgLine.estimateLine.id,
          })
        }
      }
    }

    return {
      opportunity,
      graphInconsistent: inconsistencies.length > 0,
      inconsistencies,
    }
  },
}
