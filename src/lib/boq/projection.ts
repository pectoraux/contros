/**
 * Deterministic BOQ projection — the pure function that turns an immutable
 * EstimateRevision snapshot into a read-only BoqProjection.
 *
 * ARCHITECTURE: this is the canonical → office projection. It is a PURE
 * function of (snapshotJson, projectionVersion). No DB, no wall-clock time,
 * no randomness, no external state.
 *
 * HISTORICAL RULE (canonical-content-identical): same revision + same
 * projectionVersion → identical CANONICAL CONTENT (rows + order + totals +
 * contentHash). The full BoqProjection object is NOT byte-identical — the
 * audit-only `generatedBy`/`generationContext` fields may differ between two
 * generations by different actors, but they do not affect rows, totals, or
 * contentHash. Enforced by:
 *   - reading ONLY the snapshot (never mutable EstimateLine)
 *   - deriving the contentHash from the complete canonical payload (not a
 *     timestamp) — a durable SHA-256 digest
 *   - making `generatedBy`/`generationContext` audit-only (excluded from hash)
 *
 * LOSSLESS PROJECTION (G3): the projection carries the EXACT snapshot values
 * — quantity and commercial fields are NOT rounded here. Rounding is a
 * presentation concern that belongs in the office-formatting layer (e.g. the
 * XLSX adapter), not in the canonical domain projection. This keeps the
 * projection a lossless representation of the revision; different office
 * formats can apply presentation-specific precision without changing
 * canonical content or the contentHash.
 *
 * COMMERCIAL SEMANTICS: the commercial fields come from the REPLAYED snapshot
 * (via replayRevision), not from mutable EstimateLine. The projection is
 * read-only — there is no write-back path. An XLSX adapter may lay these out
 * as cells, but editing a cell can NEVER mutate EstimateLine (INVARIANT 5/9).
 *
 * This module does NOT know about Excel. Another implementation (CSV, PDF, a
 * different XLSX lib) can reproduce exactly the same rows from the same
 * revision + projection version.
 */

import {
  replayRevision,
  type RevisionSnapshot,
  type LineSnapshot,
} from '@/lib/engines/revision-service'
import { createHash } from 'node:crypto'
import { stableJsonStringify } from '@/lib/canonical-json'
import type {
  BoqProjection,
  BoqProjectionRow,
  ProjectionCommercial,
  ProjectionInput,
  ProjectionProvenance,
  ProjectionRowIdentity,
  ProjectionSource,
  ProjectionWorkDefinition,
  ProjectionVersion,
} from './projection-contract'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * A durable, deterministic SHA-256 digest of the COMPLETE canonical projection
 * content.
 *
 * G2: upgraded from a non-cryptographic FNV-1a 16-hex digest to a standard
 * SHA-256 hex digest (64 hex chars). The semantic contract — "everything
 * needed to prove WHAT was exported" / "sufficient to prove same canonical
 * content" — calls for a cryptographic content digest, not merely a structural
 * equality shortcut. A 64-bit-ish FNV digest has a materially higher collision
 * risk than a standard cryptographic digest, which is unacceptable for a value
 * whose purpose is durable provenance / artifact identity.
 *
 * Scope: SHA-256 here provides INTEGRITY / CONTENT IDENTITY (any content
 * change produces a different hash). It does NOT establish authorship,
 * authorization, or authenticity of the artifact — that is the job of the
 * audit-only `generatedBy`/`generationContext` fields and the eventual audit
 * record. Content identity ≠ authorship.
 *
 * The hash input is the full projection payload — every field of every
 * BoqProjectionRow (identity, description, quantity, unit, workDefinition
 * INCLUDING name/unit/wastage/versionId/version, commercial breakdown) PLUS the
 * totals PLUS the projectionVersion. Excluded are ONLY the explicitly
 * audit-only fields: generatedBy, generationContext (and the contentHash itself).
 *
 * Hashed via stableJsonStringify (sorted keys at every depth) so the digest is
 * independent of object key enumeration order. If the row type gains a field in
 * the future, the hash automatically covers it — there is no manual
 * field-selection list that could drift from the type.
 */
function computeContentHash(
  rows: BoqProjectionRow[],
  totals: { totalDirectCost: number; totalSellPrice: number; totalExpectedProfit: number },
  projectionVersion: ProjectionVersion,
): string {
  // The complete canonical payload (everything that defines the projection's
  // commercial/content identity). Audit-only fields are intentionally absent.
  const payload = {
    projectionVersion,
    rows,
    totals,
  }
  const json = stableJsonStringify(payload)
  // SHA-256 over the stable JSON. node:crypto is a runtime standard; no deps.
  return createHash('sha256').update(json, 'utf8').digest('hex')
}

/** Project a WorkDefinition from the snapshot's WDV (or null). */
function projectWorkDefinition(
  line: LineSnapshot,
): ProjectionWorkDefinition | null {
  if (!line.workDefinitionVersion) return null
  const wdv = line.workDefinitionVersion
  return {
    versionId: wdv.id,
    name: wdv.name,
    version: wdv.version,
    unit: wdv.unit,
    wastage: wdv.wastage,
  }
}

/**
 * Project the commercial breakdown from the REPLAYED line (not mutable state).
 *
 * G3: values are carried EXACTLY as the replayed breakdown produced them —
 * NO rounding. Rounding is a presentation concern for the office-formatting
 * layer (XLSX adapter), not the canonical domain projection. This keeps the
 * projection lossless: snapshot quantity 1.2375 → projection quantity 1.2375,
 * not 1.24. The contentHash therefore reflects the exact commercial state.
 *
 * Money semantics: the PricingEngine already produces money values at the
 * precision it deems canonical (the engine's round2 happens at computation
 * time, establishing the commercial truth). The projection carries those
 * exact values — it does not re-round. Quantity, by contrast, is NOT a money
 * field and is carried verbatim from the snapshot with no transformation.
 */
function projectCommercial(
  line: LineSnapshot & { breakdown: import('@/lib/engines/pricing-engine').PricingBreakdown },
): ProjectionCommercial {
  return {
    unitRate: line.breakdown.unitRate,
    sellPrice: line.breakdown.sellPrice,
    directCost: line.breakdown.directCost,
    expectedProfit: line.breakdown.expectedProfit,
    expectedMarginPct: line.breakdown.expectedMarginPct,
    executionStrategy: line.executionStrategy,
  }
}

/** Build the read-only source identity from the snapshot + revision id. */
function buildSource(
  estimateRevisionId: string,
  snapshot: RevisionSnapshot,
): ProjectionSource {
  return {
    estimateRevisionId,
    estimateId: snapshot.estimateId,
    revisionNo: snapshot.revisionNo,
    snapshotVersion: snapshot.snapshotVersion,
  }
}

/** Build the deterministic row identity from the snapshot line + its index. */
function buildIdentity(line: LineSnapshot, index: number): ProjectionRowIdentity {
  return {
    lineId: line.lineId,
    rowNumber: index + 1, // 1-based, deterministic from snapshot order
  }
}

// ─── The pure projection function ───────────────────────────────────────────

/**
 * Project a finalized EstimateRevision into a read-only BoqProjection.
 *
 * Pure: same (snapshotJson, projectionVersion) → canonical-content-identical
 * output (rows + totals + contentHash). The full object is NOT byte-identical
 * — audit-only `generatedBy`/`generationContext` may differ. Throws if the
 * snapshot is invalid or the projection version is unsupported.
 *
 * The commercial fields come from the REPLAYED snapshot (via replayRevision),
 * NOT from mutable EstimateLine. The projection is read-only.
 *
 * G3: quantity and commercial values are carried EXACTLY as the replayed
 * snapshot produced them — NO rounding here. Rounding is a presentation
 * concern for the office-formatting layer (XLSX adapter), not the canonical
 * domain projection. This keeps the projection lossless.
 *
 * `generatedBy` and `generationContext` are audit-only — they appear in
 * provenance but do NOT affect `rows`, `totals`, or `contentHash`. This
 * preserves the canonical-content-equivalence rule: two generations of the
 * same revision+version by different actors produce the same rows, totals,
 * and contentHash.
 *
 * Currently supports only CURRENT_PROJECTION_VERSION (1). Future versions will
 * branch here; each version is deterministic within itself.
 */
export function projectRevision(input: ProjectionInput): BoqProjection {
  const {
    estimateRevisionId,
    snapshotJson,
    projectionVersion,
    generatedBy = null,
    generationContext = null,
  } = input

  // Validate the projection version (must be a known version).
  if (!Number.isInteger(projectionVersion) || projectionVersion < 1) {
    throw new Error(`Invalid projection version: ${projectionVersion}`)
  }
  // Future: support multiple versions. For now, only v1 is implemented.
  if (projectionVersion !== 1) {
    throw new Error(
      `Unsupported projection version: ${projectionVersion} (only version 1 is implemented)`,
    )
  }

  // Replay the snapshot — this reconstructs the exact commercial result from
  // the immutable snapshot, independent of current mutable state.
  const replay = replayRevision(snapshotJson)
  if (!replay.ok) {
    throw new Error(`Cannot project: ${replay.error}`)
  }

  // Build the rows: deterministic ordering by the snapshot's line index.
  // The snapshot's lines[] array order IS the canonical order (frozen at
  // finalization). We do NOT re-sort.
  const rows: BoqProjectionRow[] = replay.lines.map((line, index) => ({
    identity: buildIdentity(line, index),
    description: line.description,
    quantity: line.quantity, // G3: lossless — exact snapshot value, no rounding
    unit: line.unit,
    workDefinition: projectWorkDefinition(line),
    commercial: projectCommercial(line),
  }))

  const totals = {
    totalDirectCost: replay.totalDirectCost,
    totalSellPrice: replay.totalSellPrice,
    totalExpectedProfit: replay.totalExpectedProfit,
  }

  // Deterministic content hash over the COMPLETE canonical payload (rows +
  // totals + projectionVersion). Audit-only fields (generatedBy,
  // generationContext) are intentionally excluded so two generations by
  // different actors produce the same hash.
  const contentHash = computeContentHash(rows, totals, projectionVersion)

  const source = buildSource(estimateRevisionId, replay.snapshot)
  const provenance: ProjectionProvenance = {
    source,
    projectionVersion,
    contentHash,
    generatedBy,
    generationContext,
    rowCount: rows.length,
  }

  return {
    provenance,
    rows,
    totals,
  }
}

// ─── Determinism verification (exported for tests / audit) ──────────────────

/**
 * Verify the canonical-content-equivalence rule: two projections of the same
 * revision+version have the same canonical CONTENT (rows + totals + contentHash).
 *
 * F2: this is NOT "byte-identical projection" — the full BoqProjection object
 * includes audit-only metadata (generatedBy, generationContext, rowCount) that
 * may legitimately differ between two generations by different actors. The
 * historical rule is about CANONICAL CONTENT equivalence, not byte equality of
 * the whole object.
 *
 * Two projections match iff:
 *   - same source (estimateRevisionId)
 *   - same projectionVersion
 *   - same contentHash (the deterministic digest of rows+totals+version)
 *   - same rows (deep equality — belt-and-braces alongside the hash)
 *
 * Audit-only fields (generatedBy, generationContext) are intentionally NOT
 * compared. This is the function an audit/log would call to prove that two
 * generations produced the same canonical commercial content.
 */
export function projectionsMatch(
  a: BoqProjection,
  b: BoqProjection,
): boolean {
  if (a.provenance.source.estimateRevisionId !== b.provenance.source.estimateRevisionId)
    return false
  if (a.provenance.projectionVersion !== b.provenance.projectionVersion) return false
  if (a.provenance.contentHash !== b.provenance.contentHash) return false
  if (a.rows.length !== b.rows.length) return false
  // Deep equality on rows (deterministic shape). The contentHash already
  // covers rows+totals+version, but we compare rows directly as a belt-and-
  // braces check (and to surface exactly which field differs on failure).
  if (JSON.stringify(a.rows) !== JSON.stringify(b.rows)) return false
  // Also compare totals — the hash covers them, but compare explicitly for
  // audit clarity (the totals are part of canonical content).
  if (JSON.stringify(a.totals) !== JSON.stringify(b.totals)) return false
  return true
}

/** Re-export the version helpers for consumers. */
export { asProjectionVersion, CURRENT_PROJECTION_VERSION } from './projection-contract'
export type { ProjectionVersion } from './projection-contract'
