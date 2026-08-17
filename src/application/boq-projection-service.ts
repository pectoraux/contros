/**
 * BoqProjectionService — the application-layer bridge between authenticated
 * tenant context and the pure office pipeline.
 *
 *   RequestContext + estimateRevisionId
 *       ↓ tenant-scoped EstimateRevision lookup (repository)
 *   authoritative snapshotJson
 *       ↓ projectRevision() (pure)
 *   BoqProjection (lossless, SHA-256 content-addressed)
 *       ↓ buildXlsxArtifact() (pure, frozen)
 *   XlsxArtifact (immutable, display-rounded)
 *       ↓ serializeXlsxArtifact() (thin production serializer)
 *   .xlsx bytes
 *
 * This is the ONLY place that establishes the relationship between an
 * authenticated request and an authoritative revision. The serializer never
 * receives estimateId/revisionId for lookup — it gets the already-built
 * XlsxArtifact. The service NEVER accepts snapshotJson from the caller; the
 * authoritative revision comes from the repository using ctx.organizationId.
 *
 * AUDIT SEMANTICS: this is a READ/EXPORT, not a commercial mutation. The
 * BOQ_XLSX_EXPORTED event records export provenance (who exported what
 * revision + projection) but does NOT imply the XLSX became authoritative.
 * The sourceContentHash is the authoritative identity; the XLSX is a
 * presentation artifact.
 *
 * INVARIANT: the export leaves Estimate / EstimateLine / EstimateRevision
 * unchanged. No canonical mutation occurs. The projection derives from the
 * IMMUTABLE revision snapshot, NOT from mutable current EstimateLine state —
 * so a contractor may export a revision, later edit the estimate, and the
 * exported XLSX still reflects the revision's frozen commercial truth.
 */

import type { RequestContext } from '@/lib/context'
import { estimateRevisionRepository, auditLogRepository } from '@/repositories'
import {
  projectRevision,
  buildXlsxArtifact,
  serializeXlsxArtifact,
  CURRENT_PROJECTION_VERSION,
  CURRENT_XLSX_ADAPTER_VERSION,
  DEFAULT_XLSX_FORMATTING,
  type XlsxFormattingConfig,
} from '@/lib/boq'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExportXlsxInput {
  ctx: RequestContext
  /** The immutable EstimateRevision to export. This is the historical anchor. */
  estimateRevisionId: string
  /**
   * Optional formatting override. If omitted, DEFAULT_XLSX_FORMATTING is used.
   * The formatting config is a presentation concern — changing it does NOT
   * change the projection's sourceContentHash (the canonical commercial
   * identity). Different formatting → same projection, different display.
   */
  formattingConfig?: XlsxFormattingConfig
}

export type ExportXlsxResult =
  | {
      ok: true
      revisionId: string
      revisionNo: number
      projectionVersion: number
      sourceContentHash: string
      /** Deterministic: BOQ-{revisionId}-v{revisionNo}.xlsx (no timestamp). */
      fileName: string
      bytes: Buffer
    }
  | {
      ok: false
      error: string
      status: number
    }

// ─── Service ────────────────────────────────────────────────────────────────

export const boqProjectionService = {
  /**
   * Export an immutable EstimateRevision as an XLSX workbook.
   *
   * The revision is looked up tenant-scoped (ctx.organizationId). The
   * snapshotJson comes from the repository — NEVER from the caller. The
   * projection is built from the snapshot (not mutable EstimateLine state),
   * so the export reflects the revision's frozen commercial truth.
   *
   * Audit: records BOQ_XLSX_EXPORTED with full provenance. This is a read/
   * export event, NOT a commercial mutation.
   */
  async exportXlsx(input: ExportXlsxInput): Promise<ExportXlsxResult> {
    const { ctx, estimateRevisionId } = input
    const formatting = input.formattingConfig ?? DEFAULT_XLSX_FORMATTING

    // 1. Tenant-scoped revision lookup. The repository verifies:
    //    revision.id === requested AND revision.estimate.organizationId === ctx.orgId.
    //    Returns null if the revision doesn't exist OR belongs to another org.
    //    There is NO path where revisionId from tenant A + snapshot from tenant B
    //    can reach the projection function.
    const revision = await estimateRevisionRepository.getForOrganization(
      ctx.organizationId,
      estimateRevisionId,
    )
    if (!revision) {
      return {
        ok: false,
        error: 'Estimate revision not found in this organization',
        status: 404,
      }
    }

    // 2. Verify the revision is finalized (immutable). Only finalized revisions
    //    can be exported — a draft revision's snapshot is not yet frozen.
    if (revision.status !== 'finalized') {
      return {
        ok: false,
        error: 'Estimate revision is not finalized — cannot export a non-immutable revision',
        status: 422,
      }
    }

    // 3. Build the projection from the immutable snapshotJson. The snapshot is
    //    the authoritative source — NOT mutable EstimateLine state. This is
    //    the historical-replay guarantee: even if current EstimateLine values
    //    have changed since finalization, the export reflects the revision's
    //    frozen commercial truth.
    const projection = projectRevision({
      estimateRevisionId: revision.id,
      snapshotJson: revision.snapshotJson,
      projectionVersion: CURRENT_PROJECTION_VERSION,
      generatedBy: ctx.userId,
      generationContext: 'boq-xlsx-export',
    })

    // 4. Build the frozen XlsxArtifact (display-rounded, immutable).
    const artifact = buildXlsxArtifact({
      projection,
      adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
      formatting,
    })

    // 5. Serialize to .xlsx bytes (thin production serializer).
    const bytes = await serializeXlsxArtifact(artifact)

    // 6. Deterministic file name: BOQ-{revisionId}-v{revisionNo}.xlsx
    //    No timestamp — reproducibility is from the revision identity, not
    //    wall-clock time.
    const fileName = `BOQ-${revision.id}-v${revision.revisionNo}.xlsx`

    // 7. Audit: BOQ_XLSX_EXPORTED. This is a READ/EXPORT event — it records
    //    provenance but does NOT imply the XLSX became authoritative. The
    //    sourceContentHash is the authoritative identity.
    await auditLogRepository.create(ctx.organizationId, ctx.userId, {
      action: 'boq.xlsx.exported',
      entityType: 'EstimateRevision',
      entityId: revision.id,
      summary: `BOQ XLSX exported: revision ${revision.revisionNo} (${revision.id})`,
      afterJson: JSON.stringify({
        estimateRevisionId: revision.id,
        revisionNo: revision.revisionNo,
        projectionVersion: CURRENT_PROJECTION_VERSION,
        sourceContentHash: projection.provenance.contentHash,
        adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
        formattingVersion: formatting.formattingVersion,
        fileName,
        byteLength: bytes.length,
      }),
    })

    return {
      ok: true,
      revisionId: revision.id,
      revisionNo: revision.revisionNo,
      projectionVersion: CURRENT_PROJECTION_VERSION,
      sourceContentHash: projection.provenance.contentHash,
      fileName,
      bytes,
    }
  },
}
