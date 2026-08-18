/**
 * Plan repositories — tenant-aware persistence for the Plan domain.
 *
 * Every method requires the authenticated organization context (INVARIANT 12).
 * PlanArtifact is the org-owned root; PlanSheet, PlanSheetRevision, and
 * PlanMeasurement are reached via PlanArtifact, so cross-tenant access is
 * impossible.
 *
 * ARCHITECTURE:
 *   PlanArtifact → PlanSheet → PlanSheetRevision → PlanMeasurement
 *
 * All four are append-only/immutable except PlanArtifact (which can have its
 * sheets listed). PlanSheetRevision and PlanMeasurement are never updated or
 * deleted — they are historical evidence.
 */

import { db, dbTx } from '@/lib/db'

type Tx = Parameters<Parameters<typeof dbTx.$transaction>[0]>[0]

// ─── PlanArtifact Repository ────────────────────────────────────────────────

export const planArtifactRepository = {
  /**
   * Create a PlanArtifact (uploaded source file).
   * Tenant-scoped: organizationId is required.
   */
  async create(
    orgId: string,
    data: {
      opportunityId: string
      fileReference: string
      fileName: string
      fileHash: string
      source: string
      documentId?: string | null
      createdById: string
    },
  ) {
    return db.planArtifact.create({
      data: {
        organizationId: orgId,
        opportunityId: data.opportunityId,
        fileReference: data.fileReference,
        fileName: data.fileName,
        fileHash: data.fileHash,
        source: data.source,
        documentId: data.documentId ?? null,
        createdById: data.createdById,
      },
    })
  },

  /**
   * Get a PlanArtifact by ID (tenant-scoped).
   */
  async getForOrganization(orgId: string, artifactId: string) {
    return db.planArtifact.findFirst({
      where: { id: artifactId, organizationId: orgId },
      include: {
        sheets: {
          orderBy: { sheetNumber: 'asc' },
          include: {
            revisions: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    })
  },

  /**
   * List PlanArtifacts for an opportunity (tenant-scoped).
   */
  async listForOpportunity(orgId: string, opportunityId: string) {
    return db.planArtifact.findMany({
      where: { organizationId: orgId, opportunityId },
      orderBy: { createdAt: 'desc' },
      include: {
        sheets: {
          orderBy: { sheetNumber: 'asc' },
        },
      },
    })
  },

  /**
   * P1: Verify that an Opportunity belongs to this organization.
   * Returns the opportunityId if it exists, null otherwise.
   * Replaces the direct db.opportunity.findFirst in the service.
   */
  async verifyOpportunity(orgId: string, opportunityId: string) {
    const opp = await db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: orgId },
      select: { id: true },
    })
    return opp ? opp.id : null
  },

  /**
   * P4: Verify that a Document belongs to the same opportunity + tenant.
   * Returns true if the document exists and belongs to this org + opportunity.
   */
  async verifyDocumentOwnership(
    orgId: string,
    opportunityId: string,
    documentId: string,
  ) {
    const doc = await db.document.findFirst({
      where: {
        id: documentId,
        organizationId: orgId,
        opportunityId,
      },
      select: { id: true },
    })
    return doc !== null
  },
}

// ─── PlanSheet Repository ───────────────────────────────────────────────────

export const planSheetRepository = {
  /**
   * Create a PlanSheet (logical sheet within an artifact).
   * Tenant-scoped via PlanArtifact.organizationId.
   */
  async create(
    orgId: string,
    data: {
      planArtifactId: string
      sheetNumber: string
      drawingNumber?: string | null
      title?: string | null
    },
  ) {
    // Verify the artifact belongs to this org.
    const artifact = await db.planArtifact.findFirst({
      where: { id: data.planArtifactId, organizationId: orgId },
      select: { id: true },
    })
    if (!artifact) return null

    return db.planSheet.create({
      data: {
        planArtifactId: data.planArtifactId,
        sheetNumber: data.sheetNumber,
        drawingNumber: data.drawingNumber ?? null,
        title: data.title ?? null,
      },
    })
  },

  /**
   * Get a PlanSheet by ID (tenant-scoped via PlanArtifact).
   */
  async getForOrganization(orgId: string, sheetId: string) {
    return db.planSheet.findFirst({
      where: {
        id: sheetId,
        planArtifact: { organizationId: orgId },
      },
      include: {
        revisions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    })
  },
}

// ─── PlanSheetRevision Repository ───────────────────────────────────────────

export const planSheetRevisionRepository = {
  /**
   * Create a PlanSheetRevision (immutable, append-only).
   * Tenant-scoped via PlanSheet → PlanArtifact.organizationId.
   */
  async create(
    orgId: string,
    data: {
      planSheetId: string
      revision: string
      fileReference?: string | null
      fileHash?: string | null
      createdById: string
    },
  ) {
    // Verify the sheet belongs to this org via its artifact.
    const sheet = await db.planSheet.findFirst({
      where: {
        id: data.planSheetId,
        planArtifact: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!sheet) return null

    return db.planSheetRevision.create({
      data: {
        planSheetId: data.planSheetId,
        revision: data.revision,
        fileReference: data.fileReference ?? null,
        fileHash: data.fileHash ?? null,
        createdById: data.createdById,
      },
    })
  },

  /**
   * Get a PlanSheetRevision by ID (tenant-scoped).
   */
  async getForOrganization(orgId: string, revisionId: string) {
    return db.planSheetRevision.findFirst({
      where: {
        id: revisionId,
        planSheet: {
          planArtifact: { organizationId: orgId },
        },
      },
      include: {
        measurements: {
          orderBy: { createdAt: 'desc' },
        },
      },
    })
  },
}

// ─── PlanMeasurement Repository ─────────────────────────────────────────────

export const planMeasurementRepository = {
  /**
   * Create a PlanMeasurement (immutable, append-only observation).
   * Tenant-scoped via PlanSheetRevision → PlanSheet → PlanArtifact.organizationId.
   */
  async create(
    orgId: string,
    data: {
      planSheetRevisionId: string
      elementReference?: string | null
      measurementMethod: string
      quantity: number
      unit: string
      measurementBasisJson: string
      measurementEngineVersion: number
      contentHash: string
      measuredById: string
    },
  ) {
    // Verify the revision belongs to this org.
    const revision = await db.planSheetRevision.findFirst({
      where: {
        id: data.planSheetRevisionId,
        planSheet: {
          planArtifact: { organizationId: orgId },
        },
      },
      select: { id: true },
    })
    if (!revision) return null

    return db.planMeasurement.create({
      data: {
        planSheetRevisionId: data.planSheetRevisionId,
        elementReference: data.elementReference ?? null,
        measurementMethod: data.measurementMethod,
        quantity: data.quantity,
        unit: data.unit,
        measurementBasisJson: data.measurementBasisJson,
        measurementEngineVersion: data.measurementEngineVersion,
        contentHash: data.contentHash,
        measuredById: data.measuredById,
      },
    })
  },

  /**
   * Get a PlanMeasurement by ID (tenant-scoped) with the full provenance chain.
   */
  async getForOrganization(orgId: string, measurementId: string) {
    return db.planMeasurement.findFirst({
      where: {
        id: measurementId,
        planSheetRevision: {
          planSheet: {
            planArtifact: { organizationId: orgId },
          },
        },
      },
      include: {
        planSheetRevision: {
          include: {
            planSheet: {
              include: {
                planArtifact: true,
              },
            },
          },
        },
        estimateLines: {
          select: { id: true, description: true },
        },
      },
    })
  },

  /**
   * P2: Get the link context for a PlanMeasurement — the measurement ID +
   * its opportunityId (via the chain: measurement → revision → sheet →
   * artifact → opportunityId). Used by the service to enforce the
   * same-opportunity identity rule when linking to an EstimateLine.
   *
   * Returns null if the measurement is not found in this org.
   */
  async getLinkContext(orgId: string, measurementId: string) {
    const measurement = await db.planMeasurement.findFirst({
      where: {
        id: measurementId,
        planSheetRevision: {
          planSheet: {
            planArtifact: { organizationId: orgId },
          },
        },
      },
      select: {
        id: true,
        planSheetRevision: {
          select: {
            planSheet: {
              select: {
                planArtifact: {
                  select: { opportunityId: true },
                },
              },
            },
          },
        },
      },
    })
    if (!measurement) return null
    return {
      id: measurement.id,
      opportunityId: measurement.planSheetRevision.planSheet.planArtifact.opportunityId,
    }
  },
}

// ─── Plan EstimateLine Repository ───────────────────────────────────────────
//
// Cross-domain query methods for EstimateLine, specifically for the Plan
// domain's linking use case. These are NOT general-purpose estimate line
// methods — they exist to support the PlanMeasurement ↔ EstimateLine link
// with proper same-opportunity enforcement.

export const planEstimateLineRepository = {
  /**
   * P2: Get an EstimateLine for plan linking — the line ID + its
   * opportunityId (via estimate → opportunityId). Used by the service
   * to enforce the same-opportunity identity rule.
   *
   * Returns null if the EstimateLine is not found in this org.
   */
  async getForPlanLink(orgId: string, estimateLineId: string) {
    const line = await db.estimateLine.findFirst({
      where: {
        id: estimateLineId,
        estimate: { opportunity: { organizationId: orgId } },
      },
      select: {
        id: true,
        estimate: {
          select: {
            opportunityId: true,
          },
        },
      },
    })
    if (!line) return null
    return {
      id: line.id,
      opportunityId: line.estimate.opportunityId,
    }
  },

  /**
   * P3: Set EstimateLine.currentMeasurementId within a caller-held
   * transaction. The service holds the transaction so the identity
   * checks + pointer update form one atomic decision.
   */
  async setCurrentMeasurementInTransaction(
    tx: Tx,
    estimateLineId: string,
    planMeasurementId: string,
  ) {
    return tx.estimateLine.update({
      where: { id: estimateLineId },
      data: { currentMeasurementId: planMeasurementId },
    })
  },
}
