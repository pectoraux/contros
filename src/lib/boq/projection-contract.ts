/**
 * BOQ Projection Contract — the authoritative type definitions for the
 * canonical → office projection flow.
 *
 * ARCHITECTURE (approved milestone):
 *
 *   EstimateRevision (immutable snapshot)
 *       ↓
 *   Projection contract (THIS FILE)
 *       ↓
 *   Deterministic BOQ projection (pure function in projection.ts)
 *       ↓
 *   XLSX adapter (future milestone — not yet)
 *
 * The projection is a READ-ONLY, DETERMINISTIC view of a finalized
 * EstimateRevision. It exists independently of Excel — another implementation
 * (CSV, PDF, a different XLSX lib) must be able to reproduce EXACTLY the same
 * rows from the same revision + projection version.
 *
 * SOURCE OF TRUTH: the immutable EstimateRevision.snapshotJson. The projection
 * NEVER reads mutable EstimateLine rows — only the frozen snapshot. This
 * preserves reproducibility: a contractor may export a tender BOQ, later edit
 * the estimate, and still prove exactly what was exported.
 *
 * COMMERCIAL SEMANTICS: projection-only. The commercial fields (unitRate,
 * sellPrice, directCost, marginPct) are READ from the replayed snapshot. There
 * is NO write-back path — the projection type has no setters, no update method,
 * and the projection function is pure. An XLSX adapter may lay these out as
 * cells, but editing a cell can NEVER mutate EstimateLine. (INVARIANT 5/9.)
 *
 * HISTORICAL RULE (the core invariant of this contract):
 *   same EstimateRevision + same projectionVersion
 *       → byte-identical projection (same rows, same order, same provenance).
 *   This is enforced by making the projection a PURE function of
 *   (snapshotJson, projectionVersion) — no wall-clock time, no randomness,
 *   no external state. Provenance carries a content hash, not a timestamp.
 *
 * This file contains ONLY types. The pure algorithm lives in projection.ts.
 */

// ─── Source identity ────────────────────────────────────────────────────────

/**
 * Identifies the immutable source the projection was derived from.
 * `estimateRevisionId` is the DB row id of the EstimateRevision.
 * `revisionNo` and `estimateId` come from the snapshot itself (cross-check).
 */
export interface ProjectionSource {
  /** DB id of the EstimateRevision row this projection was built from. */
  estimateRevisionId: string
  /** The estimate id, as recorded in the snapshot (cross-check against the revision row). */
  estimateId: string
  /** The revision number, as recorded in the snapshot. */
  revisionNo: number
  /** The snapshot format version (forward-compat marker from the revision). */
  snapshotVersion: number
}

// ─── Projection version ─────────────────────────────────────────────────────

/**
 * An explicit, deterministic identifier for the projection FORMAT.
 *
 * `projectionVersion` is NOT a generation counter (every generation produces
 * the same output). It identifies WHICH set of fields/ordering rules the
 * projection uses. Bumping it means the projection format changed (a field was
 * added, ordering changed, etc.) — at which point the same revision produces a
 * DIFFERENT projection under the new version, but deterministically so.
 *
 * This is the "schema version" of the projection contract, not a run id.
 */
export type ProjectionVersion = number & { readonly __brand: 'ProjectionVersion' }

/**
 * The current projection version. Increment when the projection format changes
 * (field set, ordering, provenance shape). Document the change in the worklog.
 *
 * v1 — initial: lineId, description, quantity, unit, workDefinition, execution
 * strategy, commercial breakdown (unitRate, sellPrice, directCost, marginPct),
 * deterministic row ordering by snapshot line index.
 */
export const CURRENT_PROJECTION_VERSION = 1 as ProjectionVersion

/**
 * Brand a number as a ProjectionVersion. Use this when constructing a version
 * explicitly (e.g., from an API parameter).
 */
export function asProjectionVersion(n: number): ProjectionVersion {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid projection version: ${n} (must be a positive integer)`)
  }
  return n as ProjectionVersion
}

// ─── Row identity ───────────────────────────────────────────────────────────

/**
 * Stable identity for a projection row, tied to the revision's EstimateLine
 * snapshot. The `lineId` is the snapshot's line id (frozen at finalization),
 * NOT the mutable EstimateLine row — so the row identity is reproducible even
 * if the mutable line is later edited or deleted.
 *
 * `rowNumber` is a 1-based deterministic position derived from the snapshot's
 * line ordering (NOT a DB autoincrement). Same revision + same projection
 * version → same rowNumber for the same lineId, always.
 */
export interface ProjectionRowIdentity {
  /** The snapshot line id (frozen at finalization). */
  lineId: string
  /** 1-based deterministic position in the projection (from snapshot order). */
  rowNumber: number
}

// ─── Projection row ─────────────────────────────────────────────────────────

/**
 * The WorkDefinition reference projected from the snapshot (may be null if the
 * line had no WD at finalization). Read-only.
 */
export interface ProjectionWorkDefinition {
  /** The WorkDefinitionVersion id frozen in the snapshot. */
  versionId: string
  name: string
  version: number
  unit: string
  wastage: number
}

/**
 * The commercial breakdown projected from the REPLAYED snapshot — NOT from
 * mutable EstimateLine. These are the exact values the PricingEngine produced
 * at finalization time, replayed deterministically.
 *
 * PROJECTION-ONLY: there is no setter. An XLSX adapter may lay these out as
 * cells, but editing a cell can NEVER mutate EstimateLine (INVARIANT 5/9).
 */
export interface ProjectionCommercial {
  /** Per-unit sell price (replayed from the snapshot). */
  unitRate: number
  /** Total sell price for the line (unitRate × quantity, replayed). */
  sellPrice: number
  /** Direct cost per line (replayed). */
  directCost: number
  /** Expected profit (sellPrice - estimatedTotalCost, replayed). */
  expectedProfit: number
  /** Expected margin pct (expectedProfit / sellPrice, replayed). */
  expectedMarginPct: number
  /** Execution strategy frozen in the snapshot. */
  executionStrategy: string
}

/**
 * A single row in the BOQ projection. Read-only. Every field is derived from
 * the immutable snapshot — none from mutable state.
 */
export interface BoqProjectionRow {
  identity: ProjectionRowIdentity
  description: string
  quantity: number
  unit: string
  workDefinition: ProjectionWorkDefinition | null
  commercial: ProjectionCommercial
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/**
 * Full provenance for a projection. Carries everything needed to prove WHAT
 * was exported and to reproduce it.
 *
 * Determinism note: `contentHash` is a deterministic SHA-256-ish hash of the
 * projected rows (not a cryptographic guarantee — a stable string digest). It
 * is NOT a wall-clock timestamp. `generatedBy` / `generationContext` describe
 * the actor/context but do NOT affect the row content. Same revision + same
 * projectionVersion → same contentHash, always.
 */
export interface ProjectionProvenance {
  source: ProjectionSource
  /** The projection format version used (deterministic identifier). */
  projectionVersion: ProjectionVersion
  /** Deterministic digest of the projected rows (stable across regenerations). */
  contentHash: string
  /** Who/what requested the projection (audit only — does not affect rows). */
  generatedBy: string | null
  /** Free-form context (e.g., "tender-pack export") — audit only. */
  generationContext: string | null
  /** Row count (convenience; equals rows.length). */
  rowCount: number
}

// ─── The projection ─────────────────────────────────────────────────────────

/**
 * A complete BOQ projection — the output of the pure projection function.
 *
 * INVARIANT (historical rule): for a given (estimateRevisionId, snapshotJson,
 * projectionVersion), this object is byte-identical across regenerations
 * (modulo the audit-only `generatedBy`/`generationContext` fields, which do
 * not affect `rows` or `contentHash`).
 */
export interface BoqProjection {
  provenance: ProjectionProvenance
  rows: BoqProjectionRow[]
  /** Replayed totals (deterministic from the snapshot). */
  totals: {
    totalDirectCost: number
    totalSellPrice: number
    totalExpectedProfit: number
  }
}

// ─── Input to the projection function ───────────────────────────────────────

/**
 * The input to the pure projection function. Everything needed to produce a
 * deterministic projection — nothing more.
 *
 * `estimateRevisionId` is the DB row id (not in the snapshot itself).
 * `snapshotJson` is the immutable EstimateRevision.snapshotJson.
 * `projectionVersion` selects the projection format.
 * `generatedBy` / `generationContext` are audit-only (do not affect rows).
 */
export interface ProjectionInput {
  estimateRevisionId: string
  snapshotJson: string
  projectionVersion: ProjectionVersion
  generatedBy?: string | null
  generationContext?: string | null
}

// ─── Forbidden patterns (documented, enforced by architecture) ──────────────

/**
 * The projection implementation EXPLICITLY REJECTS these patterns:
 *
 *   reading mutable EstimateLine rows         (only the snapshot is read)
 *   writing back to EstimateLine              (projection is read-only)
 *   wall-clock timestamps in provenance       (breaks determinism)
 *   randomness / external state               (breaks determinism)
 *   XLSX-specific column layout in the domain (the projection is format-free)
 *   a "sync projection → estimate" operation  (would create a second truth)
 *
 * The projection is a pure function of (snapshotJson, projectionVersion).
 * The XLSX adapter (future) consumes BoqProjection but cannot mutate it.
 */
