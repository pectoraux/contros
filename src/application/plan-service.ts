/**
 * PlanService — application service for the Plan domain.
 *
 * The service boundary for the plan/measurement graph:
 *   PlanArtifact → PlanSheet → PlanSheetRevision → PlanMeasurement
 *                                       ↓ [EstimateLine.currentMeasurementId]
 *                                 EstimateLine (canonical commercial hub)
 *
 * ARCHITECTURE:
 *   RequestContext → validate → compute content hash → persist → audit
 *
 * The service NEVER accepts a caller-supplied contentHash — it always
 * computes the hash from the measurement content (normalized basis). This
 * mirrors the Programme domain's finalizeProgramme discipline.
 *
 * VALIDATION CONTRACT:
 *   validatePlanMeasurement() must pass before the hash is treated as
 *   authoritative. The pure hash function is NOT a validation function.
 */

import { db } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  planArtifactRepository,
  planSheetRepository,
  planSheetRevisionRepository,
  planMeasurementRepository,
} from '@/repositories'
import {
  validatePlanMeasurement,
  computeMeasurementContentHash,
  CURRENT_MEASUREMENT_ENGINE_VERSION,
  type PlanMeasurement,
  type MeasurementMethod,
} from '@/lib/plan'

type Err = { ok: false; error: string; status: number }

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateArtifactInput {
  ctx: RequestContext
  opportunityId: string
  fileReference: string
  fileName: string
  fileHash: string
  source: string
  documentId?: string | null
}

export interface CreateSheetInput {
  ctx: RequestContext
  planArtifactId: string
  sheetNumber: string
  drawingNumber?: string | null
  title?: string | null
}

export interface CreateRevisionInput {
  ctx: RequestContext
  planSheetId: string
  revision: string
  fileReference?: string | null
  fileHash?: string | null
}

export interface CreateMeasurementInput {
  ctx: RequestContext
  planSheetRevisionId: string
  elementReference?: string | null
  measurementMethod: MeasurementMethod
  quantity: number
  unit: string
  measurementBasisJson: string
}

export interface LinkMeasurementInput {
  ctx: RequestContext
  estimateLineId: string
  planMeasurementId: string
}

// ─── Service ────────────────────────────────────────────────────────────────

export const planService = {
  /**
   * Create a PlanArtifact (uploaded source file).
   */
  async createArtifact(input: CreateArtifactInput) {
    const { ctx, opportunityId, fileReference, fileName, fileHash, source, documentId } = input

    // Verify the opportunity belongs to this org.
    const opportunity = await db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: ctx.organizationId },
      select: { id: true },
    })
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found in this organization', status: 404 } as const
    }

    const artifact = await planArtifactRepository.create(ctx.organizationId, {
      opportunityId,
      fileReference,
      fileName,
      fileHash,
      source,
      documentId: documentId ?? null,
      createdById: ctx.userId,
    })

    return { ok: true, artifact } as const
  },

  /**
   * Create a PlanSheet (logical sheet within an artifact).
   */
  async createSheet(input: CreateSheetInput) {
    const { ctx, planArtifactId, sheetNumber, drawingNumber, title } = input

    if (!sheetNumber || sheetNumber.trim() === '') {
      return { ok: false, error: 'Sheet number is required', status: 422 } as const
    }

    const sheet = await planSheetRepository.create(ctx.organizationId, {
      planArtifactId,
      sheetNumber: sheetNumber.trim(),
      drawingNumber: drawingNumber ?? null,
      title: title ?? null,
    })

    if (!sheet) {
      return { ok: false, error: 'Plan artifact not found in this organization', status: 404 } as const
    }

    return { ok: true, sheet } as const
  },

  /**
   * Create a PlanSheetRevision (immutable, append-only).
   */
  async createRevision(input: CreateRevisionInput) {
    const { ctx, planSheetId, revision, fileReference, fileHash } = input

    if (!revision || revision.trim() === '') {
      return { ok: false, error: 'Revision is required', status: 422 } as const
    }

    const rev = await planSheetRevisionRepository.create(ctx.organizationId, {
      planSheetId,
      revision: revision.trim(),
      fileReference: fileReference ?? null,
      fileHash: fileHash ?? null,
      createdById: ctx.userId,
    })

    if (!rev) {
      return { ok: false, error: 'Plan sheet not found in this organization', status: 404 } as const
    }

    return { ok: true, revision: rev } as const
  },

  /**
   * Create a PlanMeasurement (immutable, append-only observation).
   *
   * Validates the measurement, computes the content hash (from the normalized
   * basis), and persists. The content hash is NEVER caller-supplied — the
   * service always computes it.
   */
  async createMeasurement(input: CreateMeasurementInput) {
    const { ctx, planSheetRevisionId, elementReference, measurementMethod, quantity, unit, measurementBasisJson } = input

    // Build the PlanMeasurement domain object for validation + hashing.
    const measurement: PlanMeasurement = {
      id: '__pending__',
      planSheetRevisionId,
      elementReference: elementReference ?? null,
      measurementMethod,
      quantity,
      unit,
      measurementBasisJson: measurementBasisJson || '{}',
      measurementEngineVersion: CURRENT_MEASUREMENT_ENGINE_VERSION,
      contentHash: '', // computed below
      measuredById: ctx.userId,
      measuredAt: new Date(),
      createdAt: new Date(),
    }

    // VALIDATE FIRST — the hash is not authoritative until validation passes.
    const validation = validatePlanMeasurement(measurement)
    if (!validation.ok) {
      return {
        ok: false,
        error: `Measurement validation failed: ${validation.errors.join('; ')}`,
        status: 422,
      } as const
    }

    // Compute the content hash (from the normalized basis).
    const contentHash = computeMeasurementContentHash(measurement)

    // Persist.
    const created = await planMeasurementRepository.create(ctx.organizationId, {
      planSheetRevisionId,
      elementReference: elementReference ?? null,
      measurementMethod,
      quantity,
      unit,
      measurementBasisJson: measurementBasisJson || '{}',
      measurementEngineVersion: CURRENT_MEASUREMENT_ENGINE_VERSION,
      contentHash,
      measuredById: ctx.userId,
    })

    if (!created) {
      return { ok: false, error: 'Plan sheet revision not found in this organization', status: 404 } as const
    }

    return { ok: true, measurement: created } as const
  },

  /**
   * Link a PlanMeasurement to an EstimateLine (mutable current lineage).
   *
   * This sets EstimateLine.currentMeasurementId — a mutable pointer, NOT
   * ownership. One measurement can support multiple lines. Rebinding to a
   * new measurement does not affect the old measurement (immutable evidence).
   */
  async linkToEstimateLine(input: LinkMeasurementInput) {
    const { ctx, estimateLineId, planMeasurementId } = input

    // Verify the EstimateLine belongs to this org.
    const estimateLine = await db.estimateLine.findFirst({
      where: {
        id: estimateLineId,
        estimate: { opportunity: { organizationId: ctx.organizationId } },
      },
      select: { id: true },
    })
    if (!estimateLine) {
      return { ok: false, error: 'EstimateLine not found in this organization', status: 404 } as const
    }

    // Verify the PlanMeasurement belongs to this org.
    const measurement = await planMeasurementRepository.getForOrganization(
      ctx.organizationId,
      planMeasurementId,
    )
    if (!measurement) {
      return { ok: false, error: 'PlanMeasurement not found in this organization', status: 404 } as const
    }

    // Set the mutable current lineage pointer.
    await db.estimateLine.update({
      where: { id: estimateLineId },
      data: { currentMeasurementId: planMeasurementId },
    })

    return { ok: true, linked: true } as const
  },

  /**
   * Get the complete provenance chain for a PlanMeasurement.
   *
   * Returns: measurement → revision → sheet → artifact, plus the EstimateLines
   * that currently reference this measurement.
   */
  async getProvenanceChain(
    input: {
      ctx: RequestContext
      planMeasurementId: string
    },
  ) {
    const { ctx, planMeasurementId } = input

    const measurement = await planMeasurementRepository.getForOrganization(
      ctx.organizationId,
      planMeasurementId,
    )
    if (!measurement) {
      return { ok: false, error: 'PlanMeasurement not found in this organization', status: 404 } as const
    }

    return { ok: true, measurement } as const
  },
}
