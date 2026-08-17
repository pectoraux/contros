/**
 * Production XLSX serializer — the thin office boundary.
 *
 *   XlsxArtifact → write-excel-file → Buffer
 *
 * This is the ONLY production code that touches an XLSX library. It maps the
 * already-built, frozen, content-addressed XlsxArtifact to .xlsx bytes via
 * write-excel-file@4.1.1 (the selected serializer, per the fidelity evaluation).
 *
 * BOUNDARY (strict):
 *   - No DB, no Prisma, no repositories.
 *   - No @/lib/engines (PricingEngine), no EstimateLine/EstimateRevision lookup.
 *   - No application services, no opportunity/binding/reconciliation logic.
 *   - No mutation of the XlsxArtifact (it is frozen; this only reads it).
 *   - No ZIP manipulation, no timestamp normalization.
 *
 * The serializer is BORING: it maps the artifact's worksheet/rows/columns to
 * write-excel-file's data shape and returns the bytes. The artifact already
 * carries display-rounded values and the sourceContentHash for provenance; this
 * module adds no commercial or presentation logic.
 *
 * Reproducibility:
 *   - Canonical invariant (same XlsxArtifact → same workbook content): holds,
 *     proven by the fidelity evaluation (54/54 checks).
 *   - Strong byte invariant (byte-identical XLSX): NOT a product guarantee.
 *     The XlsxArtifact's sourceContentHash is the authoritative identity; the
 *     XLSX file is a presentation artifact.
 */

import type { XlsxArtifact, XlsxColumn, XlsxRow } from './xlsx-adapter-contract'

// write-excel-file is a production dependency (moved from devDependencies in
// this commit). Its node entry is the server-side build.
import writeXlsxFile from 'write-excel-file/node'

/**
 * Serialize a frozen XlsxArtifact to .xlsx bytes.
 *
 * Maps the artifact's single worksheet to write-excel-file's single-sheet API:
 *   - sheet name: from the artifact's worksheet.name
 *   - column widths: from the artifact's columns[].width
 *   - number formats: applied to numeric cells only (write-excel-file rejects
 *     `format` on String cells)
 *   - rows: header (if present) + data rows + totals row (if present), in
 *     projection order
 *
 * Pure with respect to the artifact (reads only; never mutates). The output
 * bytes are NOT guaranteed byte-identical across processes (ZIP container
 * timestamps), but the workbook CONTENT is reproducible.
 *
 * @throws if write-excel-file fails (e.g. invalid cell data).
 */
export async function serializeXlsxArtifact(artifact: XlsxArtifact): Promise<Buffer> {
  const sheet = artifact.worksheet
  const data = sheet.rows.map((row) => mapRow(row, sheet.columns))
  const columns = sheet.columns.map((col) => ({ width: col.width }))

  // Single-sheet form with { sheet: name } — the multi-sheet form
  // [{ data, name }] ignores `name` and writes "Sheet1" (library quirk,
  // discovered during the fidelity evaluation).
  const result = await writeXlsxFile(data, {
    sheet: sheet.name,
    columns,
  })
  return result.toBuffer()
}

/**
 * Map an XlsxRow to write-excel-file's cell-array shape.
 * Applies number formats to numeric cells only (String cells reject `format`).
 */
function mapRow(row: XlsxRow, columns: XlsxColumn[]): Array<Record<string, unknown>> {
  return row.cells.map((cell, colIdx) => {
    const col = columns[colIdx]
    if (cell.value === null) {
      return { value: null }
    }
    if (typeof cell.value === 'number') {
      const base: Record<string, unknown> = { value: cell.value, type: Number }
      if (col.numberFormat) {
        base.format = col.numberFormat
      }
      return base
    }
    return { value: cell.value, type: String }
  })
}
