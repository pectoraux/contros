/**
 * Knowledge / Work Library repositories — tenant-aware.
 *
 * These repositories make unscoped retrieval impossible to express — every
 * method requires orgId and verifies the full ownership chain:
 *
 *   WorkDefinition            → organizationId (direct)
 *   WorkDefinitionVersion     → workDefinition.organizationId
 *   Resource                  → organizationId (direct)
 *   ResourcePriceObservation  → resource.organizationId
 *   KnowledgeAlert            → organizationId (direct)
 *
 * INVARIANT 4: Approved WorkDefinitions are versioned and immutable.
 * Once a WorkDefinitionVersion is approved (approvalState='approved'),
 * it CANNOT be modified. New changes require a new version.
 *
 * INVARIANT 12: Every organization is isolated.
 *
 * Convention: use findFirst (not findUnique) with explicit organizationId
 * filter, so the tenant-safety source-code audit passes.
 */

import { db } from '@/lib/db'
import type { PrismaTransaction } from './index'

// ─── Work Definition Repository ─────────────────────────────────────────────

export const workDefinitionRepository = {
  /**
   * List all WorkDefinitions for an organization, with versions ordered
   * by version DESC (latest first).
   */
  async listForOrganization(orgId: string) {
    return db.workDefinition.findMany({
      where: { organizationId: orgId },
      include: {
        versions: {
          orderBy: { version: 'desc' },
        },
      },
      orderBy: { code: 'asc' },
    })
  },

  /**
   * Get a single WorkDefinition by ID, tenant-scoped, with all versions.
   */
  async getForOrganization(orgId: string, wdId: string) {
    return db.workDefinition.findFirst({
      where: { id: wdId, organizationId: orgId },
      include: {
        versions: {
          orderBy: { version: 'desc' },
        },
      },
    })
  },

  /**
   * Create a WorkDefinition within a transaction. Tenant-scoped by construction.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      code: string
      name: string
      category?: string | null
      unit: string
      industry?: string
    },
  ) {
    return tx.workDefinition.create({
      data: {
        organizationId: orgId,
        code: data.code,
        name: data.name,
        industry: data.industry ?? 'construction',
        category: data.category ?? null,
        unit: data.unit,
        approvalState: 'draft',
      },
    })
  },

  /**
   * Update WorkDefinition metadata (NOT versions) within a transaction.
   * Tenant-scoped via organizationId in updateMany.
   */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    wdId: string,
    data: {
      code?: string
      name?: string
      category?: string | null
      approvalState?: string
      currentVersionId?: string | null
    },
  ) {
    const updated = await tx.workDefinition.updateMany({
      where: { id: wdId, organizationId: orgId },
      data,
    })
    return updated.count > 0
  },

  /**
   * Get the latest version number for a WorkDefinition (for monotonic numbering).
   * Returns 0 if no versions exist yet.
   */
  async getLatestVersionNumberInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    wdId: string,
  ): Promise<number> {
    const wd = await tx.workDefinition.findFirst({
      where: { id: wdId, organizationId: orgId },
      select: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true },
        },
      },
    })
    return wd?.versions[0]?.version ?? 0
  },
}

// ─── Work Definition Version Repository ─────────────────────────────────────
//
// WorkDefinitionVersion ownership flows through workDefinition → organization.
// Approved versions are IMMUTABLE — no update method is provided for them.

export const workDefinitionVersionRepository = {
  /**
   * Create a new draft version within a transaction.
   * The caller is responsible for computing the next version number.
   * Verifies the WorkDefinition belongs to this org.
   */
  async createDraftInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    wdId: string,
    data: {
      version: number
      costRecipeJson: string
      productivityRule?: number | null
      crewComposition?: string | null
      equipment?: string | null
      wastage?: number
      sequencing?: string | null
      methodStatementFragment?: string | null
      hazardsJson?: string
      controlsJson?: string
      qualityChecklistJson?: string
      requiredPPE?: string | null
      requiredPermits?: string | null
      subcontractability?: string
      commonAssumptions?: string | null
      commonExclusions?: string | null
      measurementRule?: string | null
    },
  ) {
    // Verify ownership: workDefinition → org
    const wd = await tx.workDefinition.findFirst({
      where: { id: wdId, organizationId: orgId },
      select: { id: true },
    })
    if (!wd) return null

    return tx.workDefinitionVersion.create({
      data: {
        workDefinitionId: wdId,
        version: data.version,
        costRecipeJson: data.costRecipeJson,
        productivityRule: data.productivityRule ?? null,
        crewComposition: data.crewComposition ?? null,
        equipment: data.equipment ?? null,
        wastage: data.wastage ?? 0.05,
        sequencing: data.sequencing ?? null,
        methodStatementFragment: data.methodStatementFragment ?? null,
        hazardsJson: data.hazardsJson ?? '[]',
        controlsJson: data.controlsJson ?? '[]',
        qualityChecklistJson: data.qualityChecklistJson ?? '[]',
        requiredPPE: data.requiredPPE ?? null,
        requiredPermits: data.requiredPermits ?? null,
        subcontractability: data.subcontractability ?? 'yes',
        commonAssumptions: data.commonAssumptions ?? null,
        commonExclusions: data.commonExclusions ?? null,
        measurementRule: data.measurementRule ?? null,
        approvalState: 'draft',
      },
    })
  },

  /**
   * Approve a draft version within a transaction.
   * Sets approvalState='approved', approvedAt, approvedById.
   * Verifies ownership chain and that the version is currently a draft.
   *
   * Returns the approved version info, or null if:
   * - the WorkDefinition doesn't belong to this org
   * - the version doesn't exist
   * - the version is already approved (idempotent — return null to signal "no change")
   *
   * INVARIANT 4: Once approved, the version is IMMUTABLE. No update method
   * exists for approved versions.
   */
  async approveInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    wdId: string,
    versionId: string,
    approvedById: string,
  ) {
    // Verify ownership + that the version is a draft
    const version = await tx.workDefinitionVersion.findFirst({
      where: {
        id: versionId,
        workDefinitionId: wdId,
        workDefinition: { organizationId: orgId },
        approvalState: 'draft',
      },
      select: { id: true, version: true },
    })
    if (!version) return null

    const approvedAt = new Date()
    await tx.workDefinitionVersion.update({
      where: { id: versionId },
      data: {
        approvalState: 'approved',
        approvedAt,
        approvedById,
      },
    })

    return { id: versionId, version: version.version, approvedAt }
  },

  /**
   * Get a single version by ID, tenant-scoped via workDefinition → org.
   */
  async getForOrganization(orgId: string, versionId: string) {
    return db.workDefinitionVersion.findFirst({
      where: {
        id: versionId,
        workDefinition: { organizationId: orgId },
      },
    })
  },

  /**
   * Get the current approved version for a WorkDefinition.
   * Tenant-scoped. Returns null if no approved version exists.
   */
  async getCurrentApprovedForOrganization(orgId: string, wdId: string) {
    return db.workDefinitionVersion.findFirst({
      where: {
        workDefinitionId: wdId,
        workDefinition: { organizationId: orgId },
        approvalState: 'approved',
      },
      orderBy: { version: 'desc' },
    })
  },
}

// ─── Resource Repository ────────────────────────────────────────────────────

export const resourceRepository = {
  /**
   * List all Resources for an organization.
   */
  async listForOrganization(orgId: string) {
    return db.resource.findMany({
      where: { organizationId: orgId },
      orderBy: { code: 'asc' },
    })
  },

  /**
   * Get a single Resource by ID, tenant-scoped.
   */
  async getForOrganization(orgId: string, resourceId: string) {
    return db.resource.findFirst({
      where: { id: resourceId, organizationId: orgId },
    })
  },

  /**
   * Create a Resource within a transaction. Tenant-scoped by construction.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      code: string
      name: string
      unit: string
      kind: string // labour | material | plant | subcontract | fee
      currency?: string
      region?: string | null
    },
  ) {
    return tx.resource.create({
      data: {
        organizationId: orgId,
        code: data.code,
        name: data.name,
        unit: data.unit,
        kind: data.kind,
        currency: data.currency ?? 'GHS',
        region: data.region ?? null,
      },
    })
  },
}

// ─── Resource Price Observation Repository ──────────────────────────────────
//
// ResourcePriceObservation ownership flows through resource → organization.
// These are APPEND-ONLY — no update or delete methods exist.
// INVARIANT 3: Every important price has provenance.

export const resourcePriceObservationRepository = {
  /**
   * Create a price observation within a transaction.
   * Verifies the resource belongs to this org.
   * Optionally links to a WorkDefinitionVersion (also verified).
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      resourceId: string
      workDefinitionVersionId?: string | null
      price: number
      currency?: string
      provenance: string
      sourceReference?: string | null
      recordedById?: string | null
    },
  ) {
    // Verify resource ownership
    const resource = await tx.resource.findFirst({
      where: { id: data.resourceId, organizationId: orgId },
      select: { id: true },
    })
    if (!resource) return null

    // If WDV is specified, verify it belongs to this org too
    if (data.workDefinitionVersionId) {
      const wdv = await tx.workDefinitionVersion.findFirst({
        where: {
          id: data.workDefinitionVersionId,
          workDefinition: { organizationId: orgId },
        },
        select: { id: true },
      })
      if (!wdv) return null
    }

    return tx.resourcePriceObservation.create({
      data: {
        resourceId: data.resourceId,
        workDefinitionVersionId: data.workDefinitionVersionId ?? null,
        price: data.price,
        currency: data.currency ?? 'GHS',
        provenance: data.provenance,
        sourceReference: data.sourceReference ?? null,
        recordedById: data.recordedById ?? null,
      },
    })
  },

  /**
   * Get the latest price observation for a resource, tenant-scoped.
   */
  async getLatestForResource(orgId: string, resourceId: string) {
    return db.resourcePriceObservation.findFirst({
      where: {
        resourceId,
        resource: { organizationId: orgId },
      },
      orderBy: { observedAt: 'desc' },
    })
  },

  /**
   * List all price observations for a resource, tenant-scoped.
   */
  async listForResource(orgId: string, resourceId: string) {
    return db.resourcePriceObservation.findMany({
      where: {
        resourceId,
        resource: { organizationId: orgId },
      },
      orderBy: { observedAt: 'desc' },
    })
  },
}

// ─── Knowledge Alert Repository ──────────────────────────────────────────────

export const knowledgeAlertRepository = {
  /**
   * List all KnowledgeAlerts for an organization.
   */
  async listForOrganization(orgId: string) {
    return db.knowledgeAlert.findMany({
      where: { organizationId: orgId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    })
  },

  /**
   * Create a KnowledgeAlert within a transaction. Tenant-scoped by construction.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      type: string // stale-price | productivity-variance | unapproved-rate | scope-gap | subcontract-exclusion
      severity?: string // info | warning | blocker
      title: string
      detail?: string | null
      entityId?: string | null
      entityType?: string | null
    },
  ) {
    return tx.knowledgeAlert.create({
      data: {
        organizationId: orgId,
        type: data.type,
        severity: data.severity ?? 'warning',
        title: data.title,
        detail: data.detail ?? null,
        entityId: data.entityId ?? null,
        entityType: data.entityType ?? null,
        acknowledged: false,
      },
    })
  },

  /**
   * Acknowledge a KnowledgeAlert within a transaction. Tenant-scoped.
   */
  async acknowledgeInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    alertId: string,
  ) {
    const updated = await tx.knowledgeAlert.updateMany({
      where: { id: alertId, organizationId: orgId },
      data: { acknowledged: true },
    })
    return updated.count > 0
  },
}

// ─── Productivity Observation Repository ────────────────────────────────────
//
// ProductivityObservation ownership is direct (organizationId) AND via
// workDefinitionVersion → workDefinition → organization.
// These are APPEND-ONLY — no update or delete methods exist.

export const productivityObservationRepository = {
  /**
   * Create a productivity observation within a transaction.
   * Verifies the WorkDefinitionVersion belongs to this org.
   * Computes actualProductivity and variancePct from the inputs.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      workDefinitionVersionId: string
      quantityCompleted: number
      daysTaken: number
      crewSize: number
      plannedProductivity: number
      sourceReference?: string | null
      recordedById?: string | null
    },
  ) {
    // Verify the WDV belongs to this org
    const wdv = await tx.workDefinitionVersion.findFirst({
      where: {
        id: data.workDefinitionVersionId,
        workDefinition: { organizationId: orgId },
      },
      select: { id: true, productivityRule: true },
    })
    if (!wdv) return null

    // Compute actual productivity and variance
    const actualProductivity = data.daysTaken > 0
      ? data.quantityCompleted / data.daysTaken
      : 0
    const variancePct = data.plannedProductivity > 0
      ? (actualProductivity - data.plannedProductivity) / data.plannedProductivity
      : 0

    return tx.productivityObservation.create({
      data: {
        organizationId: orgId,
        workDefinitionVersionId: data.workDefinitionVersionId,
        quantityCompleted: data.quantityCompleted,
        daysTaken: data.daysTaken,
        crewSize: data.crewSize,
        actualProductivity,
        plannedProductivity: data.plannedProductivity,
        variancePct,
        sourceReference: data.sourceReference ?? null,
        recordedById: data.recordedById ?? null,
      },
    })
  },

  /**
   * List productivity observations for a WorkDefinitionVersion.
   * Tenant-scoped.
   */
  async listForVersion(orgId: string, wdvId: string) {
    return db.productivityObservation.findMany({
      where: {
        organizationId: orgId,
        workDefinitionVersionId: wdvId,
      },
      orderBy: { observedAt: 'desc' },
    })
  },

  /**
   * List all productivity observations for an organization.
   */
  async listForOrganization(orgId: string) {
    return db.productivityObservation.findMany({
      where: { organizationId: orgId },
      orderBy: { observedAt: 'desc' },
    })
  },
}

// ─── Calibration Proposal Repository ────────────────────────────────────────
//
// CalibrationProposal ownership is direct (organizationId).
// These represent proposed amendments to approved knowledge — they do NOT
// auto-mutate the WorkDefinitionVersion. A human must review and apply.

export const calibrationProposalRepository = {
  /**
   * List all CalibrationProposals for an organization.
   */
  async listForOrganization(orgId: string) {
    return db.calibrationProposal.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * Get a single CalibrationProposal by ID, tenant-scoped.
   */
  async getForOrganization(orgId: string, proposalId: string) {
    return db.calibrationProposal.findFirst({
      where: { id: proposalId, organizationId: orgId },
    })
  },

  /**
   * Create a CalibrationProposal within a transaction.
   * Tenant-scoped by construction.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      workDefinitionId: string
      projectActualId?: string | null
      type: string // productivity-update | price-update | method-update
      currentValue: string
      proposedValue: string
      rationale: string
    },
  ) {
    // Verify the WorkDefinition belongs to this org
    const wd = await tx.workDefinition.findFirst({
      where: { id: data.workDefinitionId, organizationId: orgId },
      select: { id: true },
    })
    if (!wd) return null

    return tx.calibrationProposal.create({
      data: {
        organizationId: orgId,
        workDefinitionId: data.workDefinitionId,
        projectActualId: data.projectActualId ?? null,
        type: data.type,
        currentValue: data.currentValue,
        proposedValue: data.proposedValue,
        rationale: data.rationale,
        status: 'pending',
      },
    })
  },

  /**
   * Update a CalibrationProposal status within a transaction.
   * Tenant-scoped via organizationId in updateMany.
   */
  async updateStatusInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    proposalId: string,
    data: {
      status: string // pending | approved | rejected | applied
      reviewedById: string
      reviewedAt: Date
    },
  ) {
    const updated = await tx.calibrationProposal.updateMany({
      where: { id: proposalId, organizationId: orgId },
      data,
    })
    return updated.count > 0
  },
}
