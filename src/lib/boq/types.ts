/**
 * BOQ Domain Contract — the authoritative type definitions for the BOQ
 * application domain.
 *
 * ARCHITECTURE (approved — see worklog Task boq-architecture):
 *
 *   External workbook → Import → BoqItems → Binding candidates
 *                                          → Explicit binding
 *                                          → Reconciliation
 *                                          → Canonical Estimate
 *
 *   And separately (the reverse, projection — NOT in this milestone):
 *     Canonical EstimateRevision → BOQ projection → XLSX
 *
 * The same BOQ-looking row must NEVER simultaneously represent "the
 * spreadsheet row" and "the canonical estimate line." BoqItem is an
 * OBSERVATION; EstimateLine is the canonical commercial object. They are
 * linked only by an explicit, audited BoqBinding.
 *
 * INVARIANTS preserved:
 *   1  — domain model is the source of truth, not the spreadsheet
 *   2  — Estimate is canonical; BOQ is a projection / import artifact
 *   3  — every external rate has provenance
 *   5  — an import/BOQ rate can NEVER silently commit a price
 *   9  — the XLSX is a working copy, not canonical state
 *   12 — every organization is isolated (enforced in services/repos)
 *
 * This file contains ONLY types. Pure algorithms live in normalize.ts,
 * match.ts, reconcile.ts. Application orchestration lives in the services.
 */

// ─── BoqImport: the uploaded external artifact ──────────────────────────────

/** Provenance source of an imported BOQ. */
export type BoqImportSource =
  | 'client'
  | 'consultant'
  | 'tender-portal'
  | 'internal'
  | 'other'

/** Lifecycle of an import. */
export type BoqImportStatus =
  | 'pending' // upload accepted, parsing not started
  | 'parsed' // rows extracted into BoqItems
  | 'failed' // parse failed (corrupt file, unsupported format)

/**
 * A BoqImport represents ONE uploaded external workbook.
 *
 * `fileHash` makes the same client workbook identifiable across re-uploads
 * even if the filename changes — an audit requirement.
 */
export interface BoqImportRecord {
  id: string
  organizationId: string
  opportunityId: string | null
  documentId: string | null
  fileReference: string
  fileName: string
  fileHash: string
  status: BoqImportStatus
  source: BoqImportSource
  createdAt: Date
  createdById: string | null
}

// ─── BoqItem: an observation, not a canonical line ──────────────────────────

/**
 * A BoqItem is a single row parsed from an external workbook.
 *
 * CRITICAL: `raw*` fields preserve EXACTLY what the client spreadsheet said.
 * `normalized*` fields are our deterministic normalization. Both must exist
 * so we can always answer "what exactly did the client spreadsheet say?"
 * without reconstructing it from normalization logic. This is an audit
 * requirement.
 *
 * A BoqItem NEVER carries canonical commercial truth. Its `rawRate` is an
 * observation with provenance, never a committed price (INVARIANT 5).
 */
export interface BoqItemRecord {
  id: string
  boqImportId: string
  worksheet: string
  rowNumber: number

  // Semantic raw content (coerced for queryability — see rawCellJson for verbatim).
  rawDescription: string
  rawCode: string | null
  rawQuantity: number | null
  rawUnit: string | null
  rawRate: number | null
  rawAmount: number | null

  // H4: the EXACT original cell representation, as a JSON object mapping
  // column → { value: <original>, formatted?: <display string>, formula?: <formula string> }.
  // Preserves "0012" vs 12 vs "12.00" vs formula cells — audit-grade fidelity.
  rawCellJson: string

  // Our deterministic normalization (may be null if unparseable).
  normalizedDescription: string | null
  normalizedCode: string | null
  normalizedUnit: string | null
  normalizedQuantity: number | null
  normalizedRate: number | null

  currency: string | null
  provenanceJson: string // structured provenance (source, row, import, timestamp)
  createdAt: Date
}

// ─── BoqBinding: identity link, NOT commercial truth ────────────────────────

/**
 * A BoqBinding links a BoqItem to a canonical EstimateLine.
 *
 * Binding answers: "which canonical line does this external row refer to?"
 * It does NOT answer: "do the values match?" (that is reconciliation).
 *
 * A binding is an explicit, audited human decision (or a deterministic
 * machine match that a human confirms). It is never the result of an AI
 * auto-binding (INVARIANT: AI may generate candidates, never bind).
 */
export type BindingStatus =
  | 'MATCHED' // deterministically or manually bound to one EstimateLine
  | 'AMBIGUOUS' // multiple candidates; human must disambiguate
  | 'UNMATCHED' // no candidate found; human may bind manually
  | 'REJECTED' // human explicitly rejected the binding

/** How a match was established — preserved for audit and trust calibration. */
export type MatchMethod =
  | 'CODE_EXACT' // Tier 1: explicit external code ↔ canonical code
  | 'DESCRIPTION_UNIT_EXACT' // Tier 2: normalized description + unit
  | 'WORK_DEFINITION' // Tier 3: work-definition identity
  | 'CANDIDATE_SELECTED' // Tier 4: human selected from scored candidates
  | 'MANUAL' // Tier 5: direct human binding, no machine suggestion

export interface BoqBindingRecord {
  id: string
  boqItemId: string
  estimateLineId: string | null // null when UNMATCHED/REJECTED
  status: BindingStatus
  matchMethod: MatchMethod | null // null for pure UNMATCHED/REJECTED
  candidateIdsJson: string // scored candidate EstimateLine IDs (for AMBIGUOUS)
  confirmedById: string | null
  confirmedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ─── Reconciliation: a deterministic RESULT, never stored as truth ──────────

/**
 * The reconciliation result type. This is a PURE FUNCTION OUTPUT, not a
 * persisted authoritative state.
 *
 * Design rule (Section 3 of the approved architecture): reconciliation is
 * NOT stored as truth. `reconcile(input)` returns a deterministic result
 * that MAY be cached for performance, but the cache must be disposable and
 * recomputable. The canonical commercial state stays in EstimateLine,
 * computed by the PricingEngine — BOQ never mutates it.
 *
 * Classifications are DIMENSIONS, not mutually exclusive statuses. A row
 * can simultaneously be MATCHED + QTY_MISMATCH + RATE_DIVERGENT. We avoid
 * the combinatorial explosion of combined enums (QTY_AND_RATE_DIVERGENT,
 * etc.) by using `bindingStatus` + `differences[]`.
 */
export type BindingDimension = 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED' | 'REJECTED'

export type DifferenceKind =
  | 'QTY_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'RATE_DIVERGENT'

/** A single dimension of difference between external and canonical. */
export interface BoqDifference {
  kind: DifferenceKind
  external: number | string
  canonical: number | string
  /** Asymmetric reminder: the canonical value is authoritative. */
  note?: string
}

/**
 * The per-dimension comparison. Each field is independent.
 */
export interface DimensionComparison<T> {
  status: 'MATCH' | 'MISMATCH' | 'DIVERGENT' | 'UNKNOWN'
  external: T | null
  canonical: T | null
}

/**
 * The full reconciliation result for one BoqItem ↔ EstimateLine pair.
 *
 * `bindingStatus` comes from BoqBinding. `differences[]` comes from comparing
 * the BoqItem's normalized values against the EstimateLine's canonical values.
 * When `bindingStatus` is not MATCHED, `differences` is empty (nothing to
 * compare against).
 */
export interface ReconciliationResult {
  boqItemId: string
  estimateLineId: string | null
  bindingStatus: BindingDimension
  quantity: DimensionComparison<number>
  unit: DimensionComparison<string>
  rate: DimensionComparison<number>
  differences: BoqDifference[]
  /** Human-readable classification list, e.g. ["MATCHED","QTY_MISMATCH"]. */
  classification: string[]
}

// ─── Candidate generation (for AMBIGUOUS / human selection) ─────────────────

/**
 * A scored candidate EstimateLine for a BoqItem. The score is deterministic
 * (0..1) and the method records WHY the candidate was suggested. This is NOT
 * a binding — a human must confirm. AI may later become a candidate generator
 * but never the authority.
 */
export interface BindingCandidate {
  estimateLineId: string
  estimateId: string
  description: string
  unit: string
  quantity: number
  unitRate: number
  score: number // 0..1, deterministic
  matchMethod: MatchMethod
  matchReason: string
}

// ─── Audit actions (reuse the existing AuditLog model) ──────────────────────

export type BoqAuditAction =
  | 'boq.import.created'
  | 'boq.import.parsed'
  | 'boq.import.failed'
  | 'boq.binding.confirmed'
  | 'boq.binding.rejected'
  | 'boq.match.rejected'
  | 'boq.reconciliation.accepted'
  | 'boq.reconciliation.dismissed'

// ─── Forbidden patterns (documented, enforced by architecture) ──────────────

/**
 * The BOQ implementation EXPLICITLY REJECTS these patterns (Section 11):
 *
 *   route → Prisma                       (use service → repository)
 *   route → XLSX parser → EstimateLine   (import never touches EstimateLine)
 *   BOQ rate → EstimateLine rate         (RATE_DIVERGENT is asymmetric)
 *   BOQ quantity → EstimateLine quantity (import never mutates canonical)
 *   import parser → business decision    (parser normalizes; service decides)
 *   AI matcher → automatic binding       (AI suggests; human binds)
 *   reconciliation row → canonical state (reconcile is a result, not truth)
 *   current Estimate → historical export (use EstimateRevision for exports)
 *
 * Especially forbidden: "imported BOQ → replace estimate". That would destroy
 * the architectural distinction Phase 1 established.
 */
