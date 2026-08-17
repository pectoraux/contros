/**
 * XLSX Adapter Contract — the authoritative type definitions for the
 * canonical → office XLSX serialization boundary.
 *
 * ARCHITECTURE (approved milestone):
 *
 *   BoqProjection (canonical, lossless, SHA-256 content-addressed)
 *       ↓
 *   XlsxAdapterVersion + XlsxFormattingConfig
 *       ↓
 *   XlsxArtifact (office representation)
 *       ↓
 *   XLSX bytes (ZIP container — deterministic only if the serializer is)
 *
 * The adapter is a PURE, DETERMINISTIC function. It consumes a BoqProjection
 * and produces an XlsxArtifact (a workbook content model). It does NOT touch
 * the database, Prisma, EstimateLine, EstimateRevision lookup, Opportunity,
 * PricingEngine, BidService, Binding, Reconciliation, or any canonical state.
 *
 * TWO-LEVEL REPRODUCIBILITY INVARIANT (the key refinement):
 *
 *   Canonical adapter invariant (ALWAYS holds — this is what we guarantee):
 *     same BoqProjection + same XlsxAdapterVersion + same XlsxFormattingConfig
 *         → same workbook CONTENT (same sheets, same rows, same cell values,
 *           same formats, same order).
 *
 *   Strong reproducibility invariant (TESTED, not assumed — depends on the
 *   serializer being deterministic):
 *     same inputs → byte-identical XLSX bytes.
 *
 *   XLSX is a ZIP-based container; workbook generators can introduce incidental
 *   metadata (timestamps, relationship ordering, ZIP entry ordering, library
 *   ids). "Same logical workbook" does not automatically imply "same bytes."
 *   The strong invariant is therefore tested explicitly: repeated serialization
 *   of the same artifact must produce byte-identical output. If it ever does
 *   not, the serializer is non-deterministic and the strong invariant is
 *   documented as NOT holding (the canonical invariant still holds).
 *
 * DISPLAY ROUNDING (critical):
 *   The projection is LOSSLESS (quantity 1.2375 stays 1.2375). The adapter may
 *   format that as "1.24" for DISPLAY, but the underlying projection value
 *   and its contentHash are NEVER mutated. Display rounding is a presentation
 *   concern captured in XlsxFormattingConfig; it produces a formatted cell
 *   string/number for the office artifact without touching canonical content.
 *
 * VERSIONING:
 *   Formatting rules live in an EXPLICIT, VERSIONED XlsxFormattingConfig — not
 *   scattered constants. If formatting rules change, the adapter version or
 *   formatting config version must change. We never silently produce a
 *   materially different office artifact under the same adapter identity.
 *
 * This file contains ONLY types. The pure adapter lives in xlsx-adapter.ts.
 */

// ─── Adapter version ────────────────────────────────────────────────────────

/**
 * A branded, deterministic identifier for the adapter implementation.
 *
 * `adapterVersion` identifies WHICH adapter code produced the artifact. If the
 * adapter logic changes (a column is added, ordering changes, a format string
 * changes), the version MUST bump. This is separate from
 * XlsxFormattingConfig.formattingVersion (which covers the configuration, not
 * the code).
 */
export type XlsxAdapterVersion = number & { readonly __brand: 'XlsxAdapterVersion' }

/**
 * The current adapter version. Bump when adapter code changes (column set,
 * ordering, format strings, sheet structure). Document the change in worklog.
 *
 * v1 — initial: single "BOQ" sheet, columns [No, Description, Unit, Qty,
 * Unit Rate, Sell Price, Direct Cost, Expected Profit, Margin %], header row,
 * data rows in projection order, totals row. Display rounding per config.
 * (J2: the invented "Code" column was removed — the projection carries no
 * canonical business code, only the WDV versionId which is a DB identifier.)
 */
export const CURRENT_XLSX_ADAPTER_VERSION = 1 as XlsxAdapterVersion

/** Brand a number as an XlsxAdapterVersion. */
export function asXlsxAdapterVersion(n: number): XlsxAdapterVersion {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid XLSX adapter version: ${n} (must be a positive integer)`)
  }
  return n as XlsxAdapterVersion
}

// ─── Formatting configuration (versioned) ───────────────────────────────────

/**
 * The versioned formatting configuration. If ANY formatting rule changes
 * (column set, order, number formats, sheet names, display rounding precision),
 * `formattingVersion` MUST bump. This makes formatting changes auditable and
 * keeps the canonical adapter invariant sound.
 */
export interface XlsxFormattingConfig {
  /** Identifies the formatting rule set. Bump on any formatting change. */
  formattingVersion: number
  /** Worksheet name (e.g., "BOQ"). */
  worksheetName: string
  /** Column definitions — order is the column order in the sheet. */
  columns: XlsxColumn[]
  /** Number of decimal places for display rounding of monetary values. */
  moneyDisplayDecimals: number
  /** Number of decimal places for display rounding of quantity values. */
  quantityDisplayDecimals: number
  /** Whether to include a header row. */
  includeHeader: boolean
  /** Whether to include a totals row at the bottom. */
  includeTotalsRow: boolean
}

/** A single column definition in the worksheet. */
export interface XlsxColumn {
  /** The projection field this column renders. */
  field: XlsxColumnField
  /** The header label shown in the sheet. */
  header: string
  /** Column width in characters (Excel units). */
  width: number
  /** Excel number-format code for numeric cells (e.g., '#,##0.00'). */
  numberFormat: string | null
}

/** The set of projection fields that can be rendered as columns. */
export type XlsxColumnField =
  | 'rowNumber'
  | 'description'
  | 'unit'
  | 'quantity'
  | 'unitRate'
  | 'sellPrice'
  | 'directCost'
  | 'expectedProfit'
  | 'expectedMarginPct'

/**
 * The default v1 formatting configuration. Explicit and versioned.
 * Centralized here so formatting rules are not scattered constants.
 *
 * J2: no "Code" column. The projection contract does not define a canonical
 * business code — workDefinition.versionId is an immutable DB identifier, NOT
 * a contractor-facing code. Exposing it under a "Code" header would manufacture
 * business vocabulary without domain support. The Code column is omitted until
 * the domain projection carries an actual canonical code.
 */
export const DEFAULT_XLSX_FORMATTING: XlsxFormattingConfig = {
  formattingVersion: 1,
  worksheetName: 'BOQ',
  columns: [
    { field: 'rowNumber', header: 'No.', width: 6, numberFormat: null },
    { field: 'description', header: 'Description', width: 40, numberFormat: null },
    { field: 'unit', header: 'Unit', width: 8, numberFormat: null },
    { field: 'quantity', header: 'Qty', width: 10, numberFormat: '#,##0.00' },
    { field: 'unitRate', header: 'Unit Rate', width: 14, numberFormat: '#,##0.00' },
    { field: 'sellPrice', header: 'Sell Price', width: 16, numberFormat: '#,##0.00' },
    { field: 'directCost', header: 'Direct Cost', width: 16, numberFormat: '#,##0.00' },
    { field: 'expectedProfit', header: 'Exp. Profit', width: 16, numberFormat: '#,##0.00' },
    { field: 'expectedMarginPct', header: 'Margin %', width: 10, numberFormat: '0.00%' },
  ],
  moneyDisplayDecimals: 2,
  quantityDisplayDecimals: 2,
  includeHeader: true,
  includeTotalsRow: true,
}

// ─── The workbook content model (XlsxArtifact) ──────────────────────────────

/** A single cell in the worksheet. Carries the formatted value + format code. */
export interface XlsxCell {
  /**
   * The cell value. For numeric cells this is the DISPLAY-rounded number (e.g.,
   * 1.24 for a projection quantity of 1.2375). The RAW projection value is NOT
   * mutated — display rounding produces a new value here, in the office layer.
   */
  value: string | number | null
  /** The Excel number-format code for this cell (null for text). */
  numberFormat: string | null
}

/** A row of cells in the worksheet. */
export interface XlsxRow {
  /** 0-based row index. Row 0 is the header (if includeHeader). */
  rowIndex: number
  /** Whether this is the header row. */
  isHeader: boolean
  /** Whether this is the totals row. */
  isTotals: boolean
  /** The cells, in column order. */
  cells: XlsxCell[]
}

/** A single worksheet in the workbook. */
export interface XlsxWorksheet {
  /** The worksheet name (from config). */
  name: string
  /** The columns (from config), in order. */
  columns: XlsxColumn[]
  /** The rows: header (optional) + data rows + totals row (optional). */
  rows: XlsxRow[]
}

/**
 * The complete workbook content model — the office representation of a
 * BoqProjection. This is the "same workbook content" that the canonical
 * adapter invariant guarantees.
 *
 * This is NOT yet XLSX bytes. A separate, final step serializes the artifact
 * to bytes via an XLSX library. That step is where the strong (byte-identity)
 * invariant is tested.
 */
export interface XlsxArtifact {
  /** The adapter version that produced this artifact. */
  adapterVersion: XlsxAdapterVersion
  /** The formatting config used (carries formattingVersion). */
  formatting: XlsxFormattingConfig
  /** The contentHash of the source BoqProjection (for traceability). */
  sourceContentHash: string
  /**
   * The single worksheet. M4: XLSX adapter v1 is explicitly SINGLE-SHEET —
   * the BOQ projection produces one "BOQ" worksheet. The contract carries a
   * single worksheet object, not an array, so multi-sheet machinery is not
   * silently carried. If a future version needs multiple sheets, the adapter
   * version + formatting version must bump and this field changes shape.
   */
  worksheet: XlsxWorksheet
}

// ─── Input to the adapter ───────────────────────────────────────────────────

/** The input to the pure adapter function. */
export interface XlsxAdapterInput {
  projection: import('./projection-contract').BoqProjection
  adapterVersion: XlsxAdapterVersion
  formatting: XlsxFormattingConfig
}

// ─── Forbidden patterns (documented, enforced by architecture) ──────────────

/**
 * The XLSX adapter EXPLICITLY REJECTS these patterns:
 *
 *   importing @/lib/db or calling Prisma          (no DB)
 *   importing @/lib/engines (PricingEngine)       (no pricing)
 *   importing repositories                        (no repository access)
 *   reading mutable EstimateLine                  (only the projection)
 *   EstimateRevision / Opportunity lookup         (no lookups)
 *   Binding / Reconciliation logic                (not the adapter's concern)
 *   mutating the BoqProjection or its hash        (display rounding is a copy)
 *   wall-clock time / randomness                  (breaks determinism)
 *   scattered formatting constants                (use XlsxFormattingConfig)
 *
 * The adapter is a PURE function of (BoqProjection, adapterVersion, config).
 * Display rounding produces NEW cell values; it never writes back to the
 * projection. The projection's contentHash is carried in the artifact for
 * traceability but is never recomputed or altered here.
 */
