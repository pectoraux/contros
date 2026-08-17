/**
 * Deterministic BOQ projection — the pure function that turns an immutable
 * EstimateRevision snapshot into a read-only BoqProjection.
 *
 * ARCHITECTURE: this is the canonical → office projection. It is a PURE
 * function of (snapshotJson, projectionVersion). No DB, no wall-clock time,
 * no randomness, no external state.
 *
 * HISTORICAL RULE (the core invariant): same revision + same projectionVersion
 * → byte-identical projection. Enforced by:
 *   - reading ONLY the snapshot (never mutable EstimateLine)
 *   - deriving a content hash from the rows (not a timestamp)
 *   - making `generatedBy`/`generationContext` audit-only (excluded from hash)
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
import { round2 } from '@/lib/engines/money'
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
 * A stable, deterministic digest of the projected rows. NOT cryptographic —
 * a simple structural hash sufficient to prove "same rows" across regenerations.
 * Uses the row lineId + commercial fields, JSON-stringified deterministically
 * (sorted keys) so the hash is order-independent of object key enumeration.
 */
function computeContentHash(rows: BoqProjectionRow[]): string {
  // Deterministic JSON: sort keys at every level. We build a minimal
  // representation (only the fields that define identity + commercial state)
  // so the hash is stable even if the row type gains audit-only fields later.
  const compact = rows.map((r) => ({
    i: r.identity.lineId,
    n: r.identity.rowNumber,
    d: r.description,
    q: r.quantity,
    u: r.unit,
    wd: r.workDefinition
      ? `${r.workDefinition.versionId}|${r.workDefinition.version}`
      : null,
    c: {
      ur: r.commercial.unitRate,
      sp: r.commercial.sellPrice,
      dc: r.commercial.directCost,
      ep: r.commercial.expectedProfit,
      em: r.commercial.expectedMarginPct,
      es: r.commercial.executionStrategy,
    },
  }))
  const json = stableJsonStringify(compact)
  // FNV-1a 64-bit-ish hash (deterministic, no deps). Sufficient for equality
  // proof; not a security primitive.
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x1000193) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** Deterministic JSON stringify: object keys sorted lexicographically at every depth. */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJsonStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k])).join(',') + '}'
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

/** Project the commercial breakdown from the REPLAYED line (not mutable state). */
function projectCommercial(
  line: LineSnapshot & { breakdown: import('@/lib/engines/pricing-engine').PricingBreakdown },
): ProjectionCommercial {
  return {
    unitRate: round2(line.breakdown.unitRate),
    sellPrice: round2(line.breakdown.sellPrice),
    directCost: round2(line.breakdown.directCost),
    expectedProfit: round2(line.breakdown.expectedProfit),
    expectedMarginPct: round2(line.breakdown.expectedMarginPct),
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
 * Pure: same (snapshotJson, projectionVersion) → byte-identical output, always.
 * Throws if the snapshot is invalid or the projection version is unsupported.
 *
 * The commercial fields come from the REPLAYED snapshot (via replayRevision),
 * NOT from mutable EstimateLine. The projection is read-only.
 *
 * `generatedBy` and `generationContext` are audit-only — they appear in
 * provenance but do NOT affect `rows` or `contentHash`. This preserves the
 * historical rule: two generations of the same revision+version by different
 * actors produce the same rows and the same hash.
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
    quantity: round2(line.quantity),
    unit: line.unit,
    workDefinition: projectWorkDefinition(line),
    commercial: projectCommercial(line),
  }))

  // Deterministic content hash (audit-only fields excluded).
  const contentHash = computeContentHash(rows)

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
    totals: {
      totalDirectCost: replay.totalDirectCost,
      totalSellPrice: replay.totalSellPrice,
      totalExpectedProfit: replay.totalExpectedProfit,
    },
  }
}

// ─── Determinism verification (exported for tests / audit) ──────────────────

/**
 * Verify the historical rule: two projections of the same revision+version
 * are byte-identical in their rows + contentHash (audit-only fields ignored).
 *
 * Returns true iff the projections are equivalent under the historical rule.
 * This is the function an audit/log would call to prove reproducibility.
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
  // Deep equality on rows (deterministic shape).
  return JSON.stringify(a.rows) === JSON.stringify(b.rows)
}

/** Re-export the version helpers for consumers. */
export { asProjectionVersion, CURRENT_PROJECTION_VERSION } from './projection-contract'
export type { ProjectionVersion } from './projection-contract'
