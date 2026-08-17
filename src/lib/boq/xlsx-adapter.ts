/**
 * Pure XLSX adapter — turns a BoqProjection into an XlsxArtifact (workbook
 * content model), applying display rounding WITHOUT mutating the projection.
 *
 * ARCHITECTURE: this is the office boundary. Pure and deterministic.
 *
 *   BoqProjection (lossless, SHA-256 content-addressed)
 *       ↓
 *   XlsxAdapterVersion + XlsxFormattingConfig
 *       ↓
 *   XlsxArtifact (office representation, display-rounded)
 *
 * CANONICAL ADAPTER INVARIANT (always holds):
 *   same BoqProjection + same adapterVersion + same formatting config
 *       → same XlsxArtifact (same sheets, rows, cell values, formats, order).
 *
 * DISPLAY ROUNDING (critical): the projection carries lossless values
 * (quantity 1.2375). The adapter formats that as 1.24 for DISPLAY by producing
 * a NEW cell value — the projection is never mutated, and its contentHash is
 * carried unchanged in the artifact for traceability.
 *
 * This module does NOT serialize to XLSX bytes. That is a separate final step
 * (xlsx-serializer.ts) where the strong byte-identity invariant is tested.
 *
 * FORBIDDEN: importing @/lib/db, @/lib/engines, repositories; reading mutable
 * EstimateLine; any lookup; any mutation of the projection; wall-clock time;
 * randomness; scattered formatting constants.
 */

import type { BoqProjection, BoqProjectionRow } from './projection-contract'
import type {
  XlsxAdapterInput,
  XlsxAdapterVersion,
  XlsxArtifact,
  XlsxCell,
  XlsxColumn,
  XlsxFormattingConfig,
  XlsxRow,
  XlsxWorksheet,
} from './xlsx-adapter-contract'

// ─── Display rounding (presentation only — never mutates the projection) ────

/**
 * Round a value to `decimals` places for DISPLAY. Returns a NEW number; the
 * source projection value is never touched. This is the presentation-layer
 * precision that keeps the projection lossless.
 */
function roundForDisplay(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

/**
 * Format a margin percentage for display. The projection carries
 * expectedMarginPct as a fraction (e.g., 0.0909 for 9.09%). The cell displays
 * it as a percentage, so we keep the fraction and let the number format
 * ('0.00%') handle the ×100 display — Excel interprets 0.0909 with format
 * '0.00%' as "9.09%".
 */
function formatMarginForDisplay(value: number, _decimals: number): number {
  // Keep the fractional value; the '0.00%' number format renders it as a %.
  // Rounding the fraction to more places than the display would show is
  // unnecessary and could distort the display; we round to 4 dp to avoid
  // float noise while preserving the display's 2dp precision.
  return roundForDisplay(value, 4)
}

// ─── Cell rendering per field ───────────────────────────────────────────────

/**
 * Render a single projection row's field as a cell value (display-rounded).
 * The RAW projection value is read but never mutated.
 */
function renderCell(
  row: BoqProjectionRow,
  column: XlsxColumn,
  config: XlsxFormattingConfig,
): XlsxCell {
  const { field, numberFormat } = column
  switch (field) {
    case 'rowNumber':
      return { value: row.identity.rowNumber, numberFormat }
    case 'description':
      return { value: row.description, numberFormat }
    case 'unit':
      return { value: row.unit, numberFormat }
    case 'quantity':
      return {
        value: roundForDisplay(row.quantity, config.quantityDisplayDecimals),
        numberFormat,
      }
    case 'unitRate':
      return {
        value: roundForDisplay(row.commercial.unitRate, config.moneyDisplayDecimals),
        numberFormat,
      }
    case 'sellPrice':
      return {
        value: roundForDisplay(row.commercial.sellPrice, config.moneyDisplayDecimals),
        numberFormat,
      }
    case 'directCost':
      return {
        value: roundForDisplay(row.commercial.directCost, config.moneyDisplayDecimals),
        numberFormat,
      }
    case 'expectedProfit':
      return {
        value: roundForDisplay(row.commercial.expectedProfit, config.moneyDisplayDecimals),
        numberFormat,
      }
    case 'expectedMarginPct':
      return {
        value: formatMarginForDisplay(row.commercial.expectedMarginPct, config.moneyDisplayDecimals),
        numberFormat,
      }
    default: {
      // Exhaustiveness guard — if a new field is added to XlsxColumnField
      // without a render case, this fails loudly at compile time.
      const _exhaustive: never = field
      void _exhaustive
      return { value: null, numberFormat }
    }
  }
}

/** Render the header row from the config's column definitions. */
function renderHeaderRow(columns: XlsxColumn[], rowIndex: number): XlsxRow {
  return {
    rowIndex,
    isHeader: true,
    isTotals: false,
    cells: columns.map((c) => ({ value: c.header, numberFormat: null })),
  }
}

/** Render a data row from a projection row. */
function renderDataRow(
  row: BoqProjectionRow,
  columns: XlsxColumn[],
  config: XlsxFormattingConfig,
  rowIndex: number,
): XlsxRow {
  return {
    rowIndex,
    isHeader: false,
    isTotals: false,
    cells: columns.map((col) => renderCell(row, col, config)),
  }
}

/** Render the totals row (sum of the money columns; quantity not summed). */
function renderTotalsRow(
  projection: BoqProjection,
  columns: XlsxColumn[],
  config: XlsxFormattingConfig,
  rowIndex: number,
): XlsxRow {
  const cells: XlsxCell[] = columns.map((col) => {
    switch (col.field) {
      case 'description':
        return { value: 'TOTAL', numberFormat: null }
      case 'sellPrice':
        return {
          value: roundForDisplay(projection.totals.totalSellPrice, config.moneyDisplayDecimals),
          numberFormat: col.numberFormat,
        }
      case 'directCost':
        return {
          value: roundForDisplay(projection.totals.totalDirectCost, config.moneyDisplayDecimals),
          numberFormat: col.numberFormat,
        }
      case 'expectedProfit':
        return {
          value: roundForDisplay(projection.totals.totalExpectedProfit, config.moneyDisplayDecimals),
          numberFormat: col.numberFormat,
        }
      default:
        // Non-totalable columns (No, Unit, Qty, Unit Rate, Margin %)
        // are blank in the totals row.
        return { value: null, numberFormat: col.numberFormat }
    }
  })
  return { rowIndex, isHeader: false, isTotals: true, cells }
}

// ─── Deep-copy helper (J1: artifact owns immutable data) ────────────────────

/**
 * Deep-copy a formatting config (and its columns array) so the produced
 * XlsxArtifact owns its own data and is insulated from later mutation of the
 * input config. A `Readonly<>` type alone does not prevent runtime mutation;
 * the artifact must own its data.
 *
 * This is a structured clone (not JSON.parse/stringify) to preserve types and
 * avoid edge cases with undefined. The shape is plain data (no functions/Dates).
 */
function deepCopyFormatting(config: XlsxFormattingConfig): XlsxFormattingConfig {
  return {
    formattingVersion: config.formattingVersion,
    worksheetName: config.worksheetName,
    columns: config.columns.map((c) => ({
      field: c.field,
      header: c.header,
      width: c.width,
      numberFormat: c.numberFormat,
    })),
    moneyDisplayDecimals: config.moneyDisplayDecimals,
    quantityDisplayDecimals: config.quantityDisplayDecimals,
    includeHeader: config.includeHeader,
    includeTotalsRow: config.includeTotalsRow,
  }
}

/**
 * Recursively Object.freeze a plain-data structure (objects + arrays).
 * K1: makes the produced XlsxArtifact IMMUTABLE at runtime — not merely owned,
 * but frozen. Any attempt to mutate a frozen property throws in strict mode
 * (or is silently ignored in sloppy mode). This closes the provenance-mismatch
 * gap: an artifact carrying sourceContentHash cannot be mutated after
 * construction, so the serializer's "same artifact → same bytes" contract holds.
 *
 * Primitives (string/number/boolean/null/undefined) are returned as-is.
 * Functions are not frozen (the artifact model has none).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  // Arrays are objects; freeze the array then each element.
  if (Array.isArray(value)) {
    Object.freeze(value)
    for (const item of value) deepFreeze(item)
    return value
  }
  const obj = value as Record<string, unknown>
  // Freeze nested objects first (depth-first), then freeze the container.
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key])
  }
  return Object.freeze(value)
}

// ─── The pure adapter function ──────────────────────────────────────────────

/**
 * Build an XlsxArtifact from a BoqProjection + version + formatting config.
 *
 * Pure: same inputs → identical artifact, always. No DB, no wall-clock, no
 * randomness. Display rounding produces NEW cell values; the projection is
 * never mutated, and its contentHash is carried unchanged.
 *
 * J1: the artifact OWNS its formatting + column structures (deep-copied from
 * the input). Mutating the input config after buildXlsxArtifact returns does
 * NOT affect the already-built artifact.
 *
 * K1: the produced artifact is recursively Object.frozen — it is IMMUTABLE at
 * runtime, not merely owned. This prevents a provenance mismatch where an
 * artifact carrying sourceContentHash (claiming projection P) is mutated
 * after construction and then serialized to a workbook that differs from P's
 * projection. Only the serializer consumes the artifact; it never mutates it.
 */
export function buildXlsxArtifact(input: XlsxAdapterInput): XlsxArtifact {
  const { projection, adapterVersion, formatting } = input

  // J1: deep-copy the formatting so the artifact owns its own data.
  const ownedFormatting = deepCopyFormatting(formatting)

  const rows: XlsxRow[] = []
  let rowIndex = 0

  if (ownedFormatting.includeHeader) {
    rows.push(renderHeaderRow(ownedFormatting.columns, rowIndex))
    rowIndex++
  }

  // Data rows in PROJECTION ORDER (frozen snapshot order). No re-sorting.
  for (const projRow of projection.rows) {
    rows.push(renderDataRow(projRow, ownedFormatting.columns, ownedFormatting, rowIndex))
    rowIndex++
  }

  if (ownedFormatting.includeTotalsRow) {
    rows.push(renderTotalsRow(projection, ownedFormatting.columns, ownedFormatting, rowIndex))
    rowIndex++
  }

  const worksheet: XlsxWorksheet = {
    name: ownedFormatting.worksheetName,
    columns: ownedFormatting.columns,
    rows,
  }

  const artifact: XlsxArtifact = {
    adapterVersion,
    formatting: ownedFormatting,
    sourceContentHash: projection.provenance.contentHash,
    worksheets: [worksheet],
  }

  // K1: recursively freeze the artifact so it is IMMUTABLE at runtime. This
  // closes the provenance-mismatch gap: an artifact carrying sourceContentHash
  // cannot be mutated after construction, so the serializer's "same artifact →
  // same bytes" contract is sound. Object.freeze is shallow per object, so we
  // recurse through arrays + nested objects.
  return deepFreeze(artifact) as XlsxArtifact
}

// ─── Canonical invariant verification (for tests / audit) ───────────────────

/**
 * Verify the canonical adapter invariant: two artifacts built from the same
 * (projection, adapterVersion, formatting) are content-identical.
 *
 * Compares the full artifact structure (worksheets, rows, cells, formats,
 * order). Returns true iff they are identical. This is what an audit would
 * call to prove the canonical invariant holds.
 */
export function artifactsMatch(a: XlsxArtifact, b: XlsxArtifact): boolean {
  // Structural equality via stable JSON (the artifact is plain data).
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Re-export the version helper + default formatting for consumers. */
export { asXlsxAdapterVersion, CURRENT_XLSX_ADAPTER_VERSION, DEFAULT_XLSX_FORMATTING } from './xlsx-adapter-contract'
export type { XlsxAdapterVersion } from './xlsx-adapter-contract'
