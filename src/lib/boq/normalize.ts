/**
 * Pure BOQ normalization — converts raw spreadsheet observations into
 * deterministic normalized forms for matching and reconciliation.
 *
 * CRITICAL CONTRACT: this function ONLY normalizes. It makes NO business
 * decisions (binding, reconciliation, pricing). It preserves the raw values
 * alongside the normalized ones so the original spreadsheet content is
 * always recoverable (audit requirement).
 *
 * Deterministic: same input → same output, always. No randomness, no
 * external calls, no time-dependent behavior.
 */

export interface RawBoqRow {
  worksheet: string
  rowNumber: number
  description: unknown
  code: unknown
  quantity: unknown
  unit: unknown
  rate: unknown
  amount: unknown
  /**
   * H4: the EXACT original cell representation for audit-grade fidelity.
   * A map of column → { value: <original>, formatted?: <display>, formula?: <formula> }.
   * Preserves "0012" vs 12 vs "12.00" vs formula cells. If the parser does
   * not supply this, it falls back to deriving it from the semantic fields.
   */
  cells?: Record<string, { value: unknown; formatted?: string; formula?: string }>
}

export interface NormalizedBoqItem {
  worksheet: string
  rowNumber: number
  rawDescription: string
  rawCode: string | null
  rawQuantity: number | null
  rawUnit: string | null
  rawRate: number | null
  rawAmount: number | null
  /** H4: verbatim cell-level representation serialized as JSON. */
  rawCellJson: string
  normalizedDescription: string | null
  normalizedCode: string | null
  normalizedUnit: string | null
  normalizedQuantity: number | null
  normalizedRate: number | null
}

/**
 * Coerce a spreadsheet cell to a number, or null if not parseable.
 * Handles: numbers, numeric strings, strings with currency symbols / commas,
 * percentages (treated as their numeric value), empty strings.
 * Returns null for non-numeric content (descriptions, codes, blanks).
 */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'boolean') return null
  const s = String(value).trim()
  if (s === '') return null
  // Strip currency symbols, thousands separators, surrounding whitespace.
  // Keep digits, sign, decimal point, exponent.
  const cleaned = s.replace(/[^\d.\-+eE]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '+') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Normalize a unit string to a canonical form for comparison.
 * Lowercases, trims, collapses internal whitespace, and maps common variants
 * to a canonical token (e.g. "mtrs" → "m", "sq.m" → "m2", "nr." → "nr").
 */
export function normalizeUnit(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().toLowerCase().replace(/\s+/g, '')
  if (s === '') return null
  const map: Record<string, string> = {
    mtrs: 'm',
    meters: 'm',
    metre: 'm',
    metres: 'm',
    lm: 'm',
    'sq.m': 'm2',
    'sqm': 'm2',
    'sq.m.': 'm2',
    m2: 'm2',
    'm^2': 'm2',
    'cu.m': 'm3',
    cum: 'm3',
    m3: 'm3',
    'm^3': 'm3',
    nr: 'nr',
    'nr.': 'nr',
    no: 'nr',
    nos: 'nr',
    each: 'nr',
    ea: 'nr',
    ton: 'ton',
    tons: 'ton',
    tonne: 'ton',
    tonnes: 'ton',
    kg: 'kg',
    set: 'set',
    lot: 'lot',
  }
  // Direct lookup, then strip trailing periods and retry (e.g. "No." → "no").
  if (map[s]) return map[s]
  const stripped = s.replace(/[.]+$/g, '')
  if (stripped !== s && map[stripped]) return map[stripped]
  return stripped === '' ? null : stripped
}

/**
 * Normalize a description for matching: lowercase, trim, collapse whitespace,
 * strip trailing punctuation. Does NOT remove stopwords — that would weaken
 * exact description matching. Returns null for empty/whitespace-only input.
 */
export function normalizeDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().toLowerCase().replace(/\s+/g, ' ')
  // Strip trailing punctuation/periods that don't affect identity.
  const cleaned = s.replace(/[.]+$/g, '').trim()
  return cleaned === '' ? null : cleaned
}

/**
 * Normalize a code: uppercase, trim, strip whitespace and common separators
 * (dashes, slashes, dots) so "WD-014", "wd 014", "WD.014" all match "WD014".
 */
export function normalizeCode(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().toUpperCase().replace(/[\s\-/.]/g, '')
  return s === '' ? null : s
}

/**
 * Build the verbatim cell-level JSON. If the parser supplied a `cells` map
 * (the preferred, audit-grade path), use it verbatim. Otherwise, derive a
 * best-effort cell map from the semantic fields so rawCellJson is never empty.
 */
function buildRawCellJson(row: RawBoqRow): string {
  if (row.cells && Object.keys(row.cells).length > 0) {
    return JSON.stringify(row.cells)
  }
  // Fallback: derive from semantic fields. This still preserves the original
  // value type (number vs string) for audit, just not formula/formatted info.
  const cells: Record<string, { value: unknown }> = {}
  if (row.description !== undefined && row.description !== null)
    cells['description'] = { value: row.description }
  if (row.code !== undefined && row.code !== null) cells['code'] = { value: row.code }
  if (row.quantity !== undefined && row.quantity !== null)
    cells['quantity'] = { value: row.quantity }
  if (row.unit !== undefined && row.unit !== null) cells['unit'] = { value: row.unit }
  if (row.rate !== undefined && row.rate !== null) cells['rate'] = { value: row.rate }
  if (row.amount !== undefined && row.amount !== null)
    cells['amount'] = { value: row.amount }
  return JSON.stringify(cells)
}

/**
 * Normalize one raw spreadsheet row into a NormalizedBoqItem.
 * The raw* fields are preserved verbatim (as strings/numbers); the
 * normalized* fields are the deterministic derivations.
 * rawCellJson (H4) preserves the EXACT original cell representation.
 */
export function normalizeRow(row: RawBoqRow): NormalizedBoqItem {
  const rawDescription =
    row.description === null || row.description === undefined
      ? ''
      : String(row.description)
  return {
    worksheet: String(row.worksheet ?? ''),
    rowNumber: Number(row.rowNumber) || 0,
    rawDescription,
    rawCode: row.code === null || row.code === undefined ? null : String(row.code),
    rawQuantity: parseNumber(row.quantity),
    rawUnit: row.unit === null || row.unit === undefined ? null : String(row.unit),
    rawRate: parseNumber(row.rate),
    rawAmount: parseNumber(row.amount),
    rawCellJson: buildRawCellJson(row),
    normalizedDescription: normalizeDescription(row.description),
    normalizedCode: normalizeCode(row.code),
    normalizedUnit: normalizeUnit(row.unit),
    normalizedQuantity: parseNumber(row.quantity),
    normalizedRate: parseNumber(row.rate),
  }
}

/**
 * Normalize a batch of raw rows. Pure convenience over normalizeRow.
 */
export function normalizeRows(rows: RawBoqRow[]): NormalizedBoqItem[] {
  return rows.map(normalizeRow)
}
