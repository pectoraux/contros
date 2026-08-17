// ─────────────────────────────────────────────────────────────────────────────
// XLSX Serializer Fidelity Evaluation (EVALUATION HARNESS — not a product test)
//
// Purpose: verify that candidate serializers faithfully round-trip the COMPLETE
// XlsxArtifact contract — not just cell values, but every concern:
//   worksheet name, header inclusion, totals inclusion, column order, column
//   width, number format, cell value, display rounding.
//
// Method (per reviewer's directive):
//   XlsxArtifact → candidate serializer adapter → .xlsx → independent read-back
//       → canonical workbook assertion.
//
// The read-back uses read-excel-file (a DIFFERENT library than either writer)
// so the assertion is genuinely independent, not the same library validating
// itself.
//
// This is the PRIMARY gate. Byte determinism is a secondary measurement (the
// determinism probe covers that). No timestamp-normalization layer is added.
//
// Run: bun run scripts/xlsx-fidelity-eval.ts
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

import {
  finalizeRevision,
  type LineSnapshot,
  type PolicySnapshot,
} from '../src/lib/engines/revision-service'
import { projectRevision } from '../src/lib/boq/projection'
import {
  buildXlsxArtifact,
  CURRENT_XLSX_ADAPTER_VERSION,
  DEFAULT_XLSX_FORMATTING,
} from '../src/lib/boq/xlsx-adapter'
import type { XlsxArtifact, XlsxFormattingConfig } from '../src/lib/boq/xlsx-adapter-contract'

// ─── Fixed artifact fixture (same as the determinism probe) ─────────────────

function makeLine(overrides: Partial<LineSnapshot> = {}): LineSnapshot {
  return {
    lineId: 'line-1',
    description: 'PVC conduit 25mm',
    quantity: 100,
    unit: 'm',
    executionStrategy: 'self-perform',
    workDefinitionVersion: {
      id: 'wdv-1',
      name: 'PVC Conduit',
      version: 1,
      unit: 'm',
      wastage: 0.05,
      costRecipeJson: JSON.stringify([
        { resource: 'PVC pipe', component: 'material', unitCost: 5, unitQuantity: 1.05 },
      ]),
    },
    executionSegments: [],
    ...overrides,
  }
}

const POLICY: PolicySnapshot = { overheadPct: 0.1, profitPct: 0.1, contingencyPct: 0.02 }

function buildFixedArtifact(): XlsxArtifact {
  const snap = finalizeRevision('est-1', 1, POLICY, [
    makeLine({ lineId: 'l1' }),
    makeLine({ lineId: 'l2', quantity: 50, description: 'Concrete work' }),
  ])
  const projection = projectRevision({
    estimateRevisionId: 'rev-1',
    snapshotJson: snap,
    projectionVersion: 1 as never,
  })
  return buildXlsxArtifact({
    projection,
    adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
    formatting: DEFAULT_XLSX_FORMATTING,
  })
}

// ─── Full-fidelity serializer adapters ──────────────────────────────────────
//
// Each adapter maps EVERY XlsxArtifact concern through the candidate library.
// This is the critical difference from the determinism probe (which only
// mapped values + sheet name). Here we map:
//   - worksheet name
//   - column order (from the artifact's columns[])
//   - column width
//   - number format (per column)
//   - header row (row 0, from config.includeHeader)
//   - data rows (display-rounded values)
//   - totals row (from config.includeTotalsRow)
//
// The adapter returns the .xlsx bytes.

interface FidelityAdapter {
  name: string
  version: string
  serialize(artifact: XlsxArtifact): Promise<Buffer>
}

/** write-excel-file full-fidelity adapter. */
function makeWriteExcelFileAdapter(): FidelityAdapter {
  return {
    name: 'write-excel-file',
    version: require('write-excel-file/package.json').version,
    async serialize(artifact: XlsxArtifact): Promise<Buffer> {
      const writeXlsxFile = (await import('write-excel-file/node')).default
      const sheet = artifact.worksheets[0]
      // write-excel-file cell shape: { value, type, align, ... }.
      // Column metadata (width, format) is passed via the `columns` option on
      // the sheet, OR embedded in the data. We use the sheet's `columns` option.
      const data = sheet.rows.map((row) =>
        row.cells.map((cell) => {
          if (cell.value === null) return { value: null }
          if (typeof cell.value === 'number') return { value: cell.value, type: Number }
          return { value: cell.value, type: String }
        }),
      )
      // Map columns: write-excel-file supports a `columns` array on the sheet
      // with { width, align, ... }. Number formats are set per-cell via `format`.
      // We apply the format to each data cell in its column.
      const columns = sheet.columns.map((col) => ({
        width: col.width,
      }))
      // Apply number formats per cell (write-excel-file uses `format` on cells).
      // Only apply `format` to NUMERIC cells — write-excel-file rejects `format`
      // on String cells (only '@' is allowed for strings).
      const dataWithFormats = sheet.rows.map((row) =>
        row.cells.map((cell, colIdx) => {
          const col = sheet.columns[colIdx]
          if (cell.value === null) return { value: null }
          if (typeof cell.value === 'number') {
            const base = { value: cell.value, type: Number }
            return col.numberFormat ? { ...base, format: col.numberFormat } : base
          }
          return { value: cell.value, type: String }
        }),
      )
      // Use the single-sheet form with { sheet: name } — the multi-sheet form
      // [{ data, name }] ignores `name` and writes "Sheet1" (a library quirk).
      // Since the artifact currently has a single worksheet, this is correct.
      const result = await writeXlsxFile(dataWithFormats, {
        sheet: sheet.name,
        columns,
      })
      return await result.toBuffer()
    },
  }
}

/** ExcelJS full-fidelity adapter. */
function makeExcelJsAdapter(): FidelityAdapter {
  return {
    name: 'exceljs',
    version: require('exceljs/package.json').version,
    async serialize(artifact: XlsxArtifact): Promise<Buffer> {
      const ExcelJS = await import('exceljs')
      const wb = new ExcelJS.Workbook()
      const sheet = artifact.worksheets[0]
      const ws = wb.addWorksheet(sheet.name)
      // Column order + width + number format.
      ws.columns = sheet.columns.map((col) => ({
        key: col.field,
        width: col.width,
        numFmt: col.numberFormat ?? undefined,
      }))
      for (const row of sheet.rows) {
        const values: Record<string, string | number | null> = {}
        row.cells.forEach((cell, i) => {
          values[sheet.columns[i].field] = cell.value
        })
        ws.addRow(values)
      }
      const tmpFile = join(tmpdir(), `fidelity-exceljs-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`)
      await wb.xlsx.writeFile(tmpFile)
      const buf = readFileSync(tmpFile)
      try { unlinkSync(tmpFile) } catch { /* best effort */ }
      return buf
    },
  }
}

// ─── Independent read-back (read-excel-file) + canonical assertion ──────────

interface ReadBackRow {
  cells: (string | number | null)[]
}

interface ReadBackSheet {
  name: string
  rows: ReadBackRow[]
  columnCount: number
}

/** Read an .xlsx Buffer with read-excel-file (independent reader). */
async function readBackXlsx(buf: Buffer): Promise<ReadBackSheet> {
  const mod = await import('read-excel-file/node')
  const readXlsxFile = mod.default
  // readXlsxFile on a Buffer returns [{ sheet, data }] — one per sheet.
  const sheets = (await readXlsxFile(buf)) as Array<{
    sheet: string
    data: (string | number | null)[][]
  }>
  const first = sheets[0]
  if (!first) {
    return { name: '(no sheets)', rows: [], columnCount: 0 }
  }
  const rows = first.data
  return {
    name: first.sheet,
    rows: rows.map((r) => ({ cells: r })),
    columnCount: rows[0]?.length ?? 0,
  }
}

/** Assert the read-back matches the canonical artifact. Returns pass/fail per concern. */
interface FidelityCheck {
  concern: string
  passed: boolean
  detail: string
}

function assertFidelity(artifact: XlsxArtifact, readBack: ReadBackSheet): FidelityCheck[] {
  const sheet = artifact.worksheets[0]
  const checks: FidelityCheck[] = []

  // 1. Sheet name
  checks.push({
    concern: 'worksheet name',
    passed: readBack.name === sheet.name,
    detail: `expected "${sheet.name}", got "${readBack.name}"`,
  })

  // 2. Row count (header + data + totals, per config)
  const expectedRows = sheet.rows.length
  checks.push({
    concern: 'row count (header + data + totals)',
    passed: readBack.rows.length === expectedRows,
    detail: `expected ${expectedRows}, got ${readBack.rows.length}`,
  })

  // 3. Column count / order
  const expectedCols = sheet.columns.length
  checks.push({
    concern: 'column count',
    passed: readBack.columnCount === expectedCols,
    detail: `expected ${expectedCols}, got ${readBack.columnCount}`,
  })

  // 4. Header row values (if includeHeader)
  if (artifact.formatting.includeHeader) {
    const expectedHeaders = sheet.columns.map((c) => c.header)
    const actualHeaders = readBack.rows[0]?.cells.map((c) => c) ?? []
    const headersMatch =
      actualHeaders.length === expectedHeaders.length &&
      actualHeaders.every((h, i) => String(h) === expectedHeaders[i])
    checks.push({
      concern: 'header row values',
      passed: headersMatch,
      detail: `expected [${expectedHeaders.join(', ')}], got [${actualHeaders.join(', ')}]`,
    })
  }

  // 5. Data row values (display-rounded, in projection order)
  const dataStartIdx = artifact.formatting.includeHeader ? 1 : 0
  const dataEndIdx = artifact.formatting.includeTotalsRow
    ? readBack.rows.length - 1
    : readBack.rows.length
  let dataValuesMatch = true
  let dataDetail = ''
  for (let r = dataStartIdx; r < dataEndIdx; r++) {
    const projRow = sheet.rows[r]
    for (let c = 0; c < sheet.columns.length; c++) {
      const expected = projRow.cells[c].value
      const actual = readBack.rows[r]?.cells[c] ?? null
      // Numbers compare with tolerance; strings exactly.
      if (typeof expected === 'number' && typeof actual === 'number') {
        if (Math.abs(expected - actual) > 0.001) {
          dataValuesMatch = false
          dataDetail = `row ${r} col ${c}: expected ${expected}, got ${actual}`
          break
        }
      } else if (String(expected) !== String(actual)) {
        dataValuesMatch = false
        dataDetail = `row ${r} col ${c}: expected "${expected}", got "${actual}"`
        break
      }
    }
    if (!dataValuesMatch) break
  }
  checks.push({
    concern: 'data row values (display-rounded, projection order)',
    passed: dataValuesMatch,
    detail: dataDetail || 'all data cells match',
  })

  // 6. Totals row label (if includeTotalsRow)
  if (artifact.formatting.includeTotalsRow) {
    const totalsRow = readBack.rows[readBack.rows.length - 1]
    // The Description column (index 1 in v1: No, Desc, ...) should be "TOTAL".
    const descColIdx = sheet.columns.findIndex((c) => c.field === 'description')
    if (descColIdx >= 0) {
      const label = totalsRow?.cells[descColIdx] ?? null
      checks.push({
        concern: 'totals row "TOTAL" label',
        passed: String(label) === 'TOTAL',
        detail: `expected "TOTAL", got "${label}"`,
      })
    }
  }

  return checks
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== XLSX Serializer Fidelity Evaluation ===')
  console.log(`Runtime: node ${process.version}, bun ${Bun.version}\n`)

  const artifact = buildFixedArtifact()
  console.log(`Fixed XlsxArtifact: ${artifact.worksheets[0].rows.length} rows, ${artifact.worksheets[0].columns.length} columns`)
  console.log(`  columns: ${artifact.worksheets[0].columns.map((c) => c.header).join(', ')}\n`)

  const adapters: FidelityAdapter[] = [
    makeWriteExcelFileAdapter(),
    makeExcelJsAdapter(),
  ]

  for (const adapter of adapters) {
    console.log(`=== ${adapter.name}@${adapter.version} ===`)
    try {
      const bytes = await adapter.serialize(artifact)
      // Write to temp file for read-back (read-excel-file reads from file/buffer).
      const tmpFile = join(tmpdir(), `fidelity-${adapter.name}-${Date.now()}.xlsx`)
      writeFileSync(tmpFile, bytes)
      const readBuf = readFileSync(tmpFile)
      try { unlinkSync(tmpFile) } catch { /* best effort */ }

      const readBack = await readBackXlsx(readBuf)
      const checks = assertFidelity(artifact, readBack)

      const passed = checks.filter((c) => c.passed).length
      const total = checks.length
      console.log(`  Fidelity: ${passed}/${total} concerns passed`)
      for (const c of checks) {
        console.log(`  ${c.passed ? '✅' : '❌'} ${c.concern}: ${c.detail}`)
      }
      console.log(`  Bytes: ${bytes.length}\n`)
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  console.log('=== NOTE ===')
  console.log('Number formats and column widths are NOT asserted by read-excel-file')
  console.log('(it does not expose per-cell numFmt or column width via its buffer API).')
  console.log('Those concerns require a richer reader or a format-inspection step.')
  console.log('The assertions above cover: sheet name, row count, column count,')
  console.log('header values, data values, totals label.')
}

main().catch((e) => {
  console.error('Fidelity eval failed:', e)
  process.exit(1)
})
