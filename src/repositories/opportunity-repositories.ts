/**
 * Opportunity / Client / Scope repositories — tenant-aware.
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
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * A repository must never return an org-owned entity solely from an
 * attacker-supplied ID.
 *
 * Convention: use findFirst (not findUnique) with explicit organizationId
 * filter, so the tenant-safety source-code audit passes.
 */

import { db } from '@/lib/db'
import type { PrismaTransaction } from './index'

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
   */
  async getForOrganization(orgId: string, opportunityId: string) {
    return db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: orgId },
      include: {
        scopePackage: {
          include: { items: true, questions: true },
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
