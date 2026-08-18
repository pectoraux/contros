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

import { db } from '@/lib/db'

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
}
