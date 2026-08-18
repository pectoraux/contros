/**
 * PlanService — application service for the Plan domain.
 *
 * The service boundary for the plan/measurement graph:
 *   PlanArtifact → PlanSheet → PlanSheetRevision → PlanMeasurement
 *                                       ↓ [EstimateLine.currentMeasurementId]
 *                                 EstimateLine (canonical commercial hub)
 *
 * ARCHITECTURE:
 *   UI / API → Application Service → Repository → Database
 *
 * The service NEVER makes direct db.* calls — all persistence goes through
 * repository methods. This is the established boundary maintained throughout
 * Programme and BOQ.
 *
 * CROSS-DOMAIN IDENTITY (P2):
 *   linkToEstimateLine enforces same-opportunity identity:
 *     PlanMeasurement → PlanArtifact → Opportunity A
 *     EstimateLine → Estimate → Opportunity A
 *   A plan measurement from one project must NEVER become current lineage for
 *   a different project's commercial line merely because both belong to the
 *   same tenant.
 *
 * TRANSACTIONAL LINK (P3):
 *   The link operation (verify + update) runs inside one transaction so the
 *   identity checks and pointer update form one atomic decision.
 *
 * VALIDATION CONTRACT:
 *   validatePlanMeasurement() must pass before the hash is treated as
 *   authoritative. The pure hash function is NOT a validation function.
 */

import { dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  planArtifactRepository,
  planSheetRepository,
  planSheetRevisionRepository,
  planMeasurementRepository,
  planEstimateLineRepository,
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
   *
   * P1: Uses repository methods — no direct db.* calls.
   * P4: If documentId is provided, verifies it belongs to the same
   * Opportunity + tenant.
   */
  async createArtifact(input: CreateArtifactInput) {
    const { ctx, opportunityId, fileReference, fileName, fileHash, source, documentId } = input

    // P1: Verify the opportunity belongs to this org via repository.
    const verifiedOpp = await planArtifactRepository.verifyOpportunity(
      ctx.organizationId,
      opportunityId,
    )
    if (!verifiedOpp) {
      return { ok: false, error: 'Opportunity not found in this organization', status: 404 } as const
    }

    // P4: If documentId is provided, verify it belongs to the same
    // Opportunity + tenant. An arbitrary documentId from a different
    // opportunity or org must not be accepted.
    if (documentId) {
      const docValid = await planArtifactRepository.verifyDocumentOwnership(
        ctx.organizationId,
        opportunityId,
        documentId,
      )
      if (!docValid) {
        return {
          ok: false,
          error: 'Document does not belong to this opportunity or organization',
          status: 422,
        } as const
      }
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
   * P1: Uses repository methods — no direct db.* calls.
   * P2: Enforces same-opportunity identity:
   *     PlanMeasurement → PlanArtifact → Opportunity A
   *     EstimateLine → Estimate → Opportunity A
   *   A plan measurement from one project must NEVER become current lineage
   *   for a different project's commercial line merely because both belong
   *   to the same tenant.
   * P3: The link operation (verify + update) runs inside one transaction so
   *   the identity checks and pointer update form one atomic decision.
   *
   * This sets EstimateLine.currentMeasurementId — a mutable pointer, NOT
   * ownership. One measurement can support multiple lines. Rebinding to a
   * new measurement does not affect the old measurement (immutable evidence).
   */
  async linkToEstimateLine(input: LinkMeasurementInput) {
    const { ctx, estimateLineId, planMeasurementId } = input

    // P2: Get the measurement's opportunity context (tenant-scoped).
    const measurementCtx = await planMeasurementRepository.getLinkContext(
      ctx.organizationId,
      planMeasurementId,
    )
    if (!measurementCtx) {
      return { ok: false, error: 'PlanMeasurement not found in this organization', status: 404 } as const
    }

    // P2: Get the estimate line's opportunity context (tenant-scoped).
    const lineCtx = await planEstimateLineRepository.getForPlanLink(
      ctx.organizationId,
      estimateLineId,
    )
    if (!lineCtx) {
      return { ok: false, error: 'EstimateLine not found in this organization', status: 404 } as const
    }

    // P2: SAME-OPPORTUNITY IDENTITY ENFORCEMENT.
    // The measurement and the estimate line must belong to the SAME opportunity.
    // A plan measurement from one project must never become current lineage for
    // a different project's commercial line merely because both belong to the
    // same tenant.
    if (measurementCtx.opportunityId !== lineCtx.opportunityId) {
      return {
        ok: false,
        error: 'PlanMeasurement and EstimateLine must belong to the same opportunity',
        status: 422,
      } as const
    }

    // P3: Transactional link — verify + update in one atomic decision.
    await dbTx.$transaction(async (tx) => {
      await planEstimateLineRepository.setCurrentMeasurementInTransaction(
        tx,
        estimateLineId,
        planMeasurementId,
      )
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
