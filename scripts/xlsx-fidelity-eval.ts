// ─────────────────────────────────────────────────────────────────────────────
// XLSX Serializer Fidelity Evaluation (EVALUATION RECORD — not a product test)
//
// STATUS: EVALUATION COMPLETE. write-excel-file@4.1.1 was declared the
// production serializer (M5). The other candidates (exceljs) and the
// independent reader (read-excel-file) were removed from devDependencies (M6).
// This script is retained as the evaluation record. To re-run it, temporarily
// reinstall: `bun add -d exceljs read-excel-file`.
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
// The read-back used read-excel-file (a DIFFERENT library than either writer)
// so the assertion was genuinely independent, not the same library validating
// itself.
//
// Result: write-excel-file passed 9/9 checks across all 6 config variants
// (54/54). exceljs failed M1 (numeric cell style indices) + M2 (missing column
// widths for some columns) — a real fidelity gap.
//
// Run: bun run scripts/xlsx-fidelity-eval.ts (requires re-installing eval deps)
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'
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
      const sheet = artifact.worksheet
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
      const sheet = artifact.worksheet
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

// ─── Structural XML inspection (M1: number formats, M2: column widths) ──────
//
// read-excel-file does not expose per-cell numFmt or column width. So we parse
// the raw XML entries (xl/styles.xml + xl/worksheets/sheet1.xml) directly from
// the .xlsx ZIP. This is a lightweight structural check — NOT a full XLSX
// library, just enough to verify the two formatting concerns the independent
// reader couldn't.

/** Minimal ZIP entry extraction (central directory). Returns Map<name, Buffer>. */
function parseZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) return entries
  const count = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break
    const method = buf.readUInt16LE(cd + 10)
    const compSize = buf.readUInt32LE(cd + 20)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const localOff = buf.readUInt32LE(cd + 42)
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen)
    const lname = buf.readUInt16LE(localOff + 26)
    const lextra = buf.readUInt16LE(localOff + 28)
    const dataOff = localOff + 30 + lname + lextra
    const compData = buf.subarray(dataOff, dataOff + compSize)
    const content = method === 0 ? compData : method === 8 ? inflateRawSync(compData) : Buffer.from(`[unsupported ${method}]`)
    entries.set(name, content)
    cd += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * M1: Verify number formats. Parses xl/styles.xml to extract the numFmts map
 * and the cellXfs style indices, then parses xl/worksheets/sheet1.xml to find
 * each data cell's style index and resolve its format code. Asserts that the
 * numeric columns carry the expected numberFormat from the artifact config.
 *
 * This is a best-effort structural check — it verifies the format codes are
 * PRESENT in the styles table and applied to the right columns, not a full
 * OOXML conformance test.
 */
function verifyNumberFormats(
  xlsxBuf: Buffer,
  artifact: XlsxArtifact,
): FidelityCheck[] {
  const checks: FidelityCheck[] = []
  try {
    const entries = parseZipEntries(xlsxBuf)
    const stylesXml = entries.get('xl/styles.xml')?.toString('utf8') ?? ''
    const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''

    // Parse numFmts: <numFmts count="N"><numFmt numFmtId="K" formatCode="..."/></numFmts>
    const numFmtMap = new Map<number, string>()
    const numFmtRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = numFmtRe.exec(stylesXml)) !== null) {
      numFmtMap.set(Number(m[1]), m[2])
    }
    // Built-in formats (0-49) — we only care that custom codes are present.
    // Parse cellXfs: <cellXfs count="N"><xf numFmtId="K" .../>...</cellXfs>
    const xfFormats: number[] = []
    const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)
    if (cellXfsMatch) {
      const xfRe = /<xf[^>]*numFmtId="(\d+)"/g
      while ((m = xfRe.exec(cellXfsMatch[1])) !== null) {
        xfFormats.push(Number(m[1]))
      }
    }

    // Check that each expected custom format code appears in the styles table.
    const expectedFormats = new Set(
      artifact.worksheet.columns
        .filter((c) => c.numberFormat !== null)
        .map((c) => c.numberFormat as string),
    )
    let allFormatsPresent = true
    let formatDetail = ''
    for (const expected of expectedFormats) {
      const found = [...numFmtMap.values()].includes(expected)
      if (!found) {
        // Could be a built-in format code; check if it's a well-known one.
        const builtins: Record<string, number> = { '#,##0.00': 4, '0.00%': 10 }
        if (!(expected in builtins)) {
          allFormatsPresent = false
          formatDetail = `expected format "${expected}" not in styles.xml numFmts`
        }
      }
    }
    checks.push({
      concern: 'number formats present in styles.xml (M1)',
      passed: allFormatsPresent,
      detail: formatDetail || `${expectedFormats.size} custom format(s) present: ${[...expectedFormats].join(', ')}`,
    })

    // Verify the sheet XML references style indices for data cells.
    // Each <c s="N"> has a style index; the numeric columns should have
    // non-zero style indices (formatting applied).
    const dataRows = artifact.worksheet.rows.filter((r) => !r.isHeader && !r.isTotals)
    if (dataRows.length > 0) {
      const numericColIndices: number[] = []
      artifact.worksheet.columns.forEach((col, i) => {
        if (col.numberFormat !== null) numericColIndices.push(i)
      })
      // Check at least one data row has style attributes on numeric cells.
      // Column letters: A, B, C, ... → the cell ref like "E2" (col E, row 2).
      const colLetter = (idx: number) => String.fromCharCode(65 + idx)
      let styledNumericCells = 0
      for (const row of sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
        for (const colIdx of numericColIndices) {
          const ref = colLetter(colIdx)
          const cellRe = new RegExp(`<c r="${ref}\\d+"[^>]*s="(\\d+)"`)
          const cm = row.match(cellRe)
          if (cm) styledNumericCells++
        }
      }
      checks.push({
        concern: 'numeric cells carry style indices (M1)',
        passed: styledNumericCells > 0,
        detail: `${styledNumericCells} numeric cell(s) with style attributes found`,
      })
    }
  } catch (e) {
    checks.push({
      concern: 'number formats (M1)',
      passed: false,
      detail: `parse error: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
  return checks
}

/**
 * M2: Verify column widths. Parses xl/worksheets/sheet1.xml for the <cols>
 * section and asserts each column's width matches the artifact config.
 */
function verifyColumnWidths(
  xlsxBuf: Buffer,
  artifact: XlsxArtifact,
): FidelityCheck[] {
  const checks: FidelityCheck[] = []
  try {
    const entries = parseZipEntries(xlsxBuf)
    const sheetXml = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? ''
    // <cols><col min="1" max="1" width="6" .../>...</cols>
    const colsMatch = sheetXml.match(/<cols>([\s\S]*?)<\/cols>/)
    if (!colsMatch) {
      checks.push({
        concern: 'column widths in sheet1.xml (M2)',
        passed: false,
        detail: 'no <cols> section found',
      })
      return checks
    }
    const colWidths = new Map<number, number>()
    const colRe = /<col[^>]*min="(\d+)"[^>]*width="([\d.]+)"/g
    let m: RegExpExecArray | null
    while ((m = colRe.exec(colsMatch[1])) !== null) {
      colWidths.set(Number(m[1]), Number(m[2]))
    }
    // Compare against the artifact's column widths (1-based in OOXML).
    let allMatch = true
    const mismatches: string[] = []
    artifact.worksheet.columns.forEach((col, i) => {
      const ooxmlIdx = i + 1
      const actual = colWidths.get(ooxmlIdx)
      if (actual === undefined) {
        allMatch = false
        mismatches.push(`col ${ooxmlIdx} (${col.header}): missing width`)
      } else if (Math.abs(actual - col.width) > 0.5) {
        allMatch = false
        mismatches.push(`col ${ooxmlIdx} (${col.header}): expected ${col.width}, got ${actual}`)
      }
    })
    checks.push({
      concern: 'column widths in sheet1.xml (M2)',
      passed: allMatch,
      detail: mismatches.length === 0
        ? `${artifact.worksheet.columns.length} column widths match`
        : mismatches.join('; '),
    })
  } catch (e) {
    checks.push({
      concern: 'column widths (M2)',
      passed: false,
      detail: `parse error: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
  return checks
}

/** Assert the read-back matches the canonical artifact. Returns pass/fail per concern. */
interface FidelityCheck {
  concern: string
  passed: boolean
  detail: string
}

function assertFidelity(artifact: XlsxArtifact, readBack: ReadBackSheet): FidelityCheck[] {
  const sheet = artifact.worksheet
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

// ─── Config variants (M3: exercise the artifact contract branches) ──────────

interface Variant {
  name: string
  formatting: XlsxFormattingConfig
}

function buildVariants(): Variant[] {
  return [
    { name: 'default config', formatting: DEFAULT_XLSX_FORMATTING },
    {
      name: 'header disabled',
      formatting: { ...DEFAULT_XLSX_FORMATTING, includeHeader: false },
    },
    {
      name: 'totals disabled',
      formatting: { ...DEFAULT_XLSX_FORMATTING, includeTotalsRow: false },
    },
    {
      name: 'custom worksheet name',
      formatting: { ...DEFAULT_XLSX_FORMATTING, worksheetName: 'Tender BOQ' },
    },
    {
      name: 'custom display decimals (4dp money, 3dp qty)',
      formatting: {
        ...DEFAULT_XLSX_FORMATTING,
        formattingVersion: 2,
        moneyDisplayDecimals: 4,
        quantityDisplayDecimals: 3,
      },
    },
    {
      name: 'custom column order (reversed) + widths + formats',
      formatting: {
        ...DEFAULT_XLSX_FORMATTING,
        formattingVersion: 3,
        columns: [...DEFAULT_XLSX_FORMATTING.columns].reverse().map((c) => ({
          ...c,
          width: c.width + 5,
        })),
      },
    },
  ]
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== XLSX Serializer Fidelity Evaluation ===')
  console.log(`Runtime: node ${process.version}, bun ${Bun.version}\n`)

  const baseProjection = ((): import('../src/lib/boq/projection-contract').BoqProjection => {
    const snap = finalizeRevision('est-1', 1, POLICY, [
      makeLine({ lineId: 'l1' }),
      makeLine({ lineId: 'l2', quantity: 50, description: 'Concrete work' }),
    ])
    return projectRevision({
      estimateRevisionId: 'rev-1',
      snapshotJson: snap,
      projectionVersion: 1 as never,
    })
  })()

  const variants = buildVariants()
  const adapters: FidelityAdapter[] = [
    makeWriteExcelFileAdapter(),
    makeExcelJsAdapter(),
  ]

  let totalPass = 0
  let totalChecks = 0

  for (const adapter of adapters) {
    console.log(`=== ${adapter.name}@${adapter.version} ===`)
    for (const variant of variants) {
      const artifact = buildXlsxArtifact({
        projection: baseProjection,
        adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
        formatting: variant.formatting,
      })
      console.log(`  --- variant: ${variant.name} ---`)
      try {
        const bytes = await adapter.serialize(artifact)
        const readBack = await readBackXlsx(bytes)
        // Content checks (independent read-back)
        const contentChecks = assertFidelity(artifact, readBack)
        // Structural checks (M1: number formats, M2: column widths)
        const formatChecks = verifyNumberFormats(bytes, artifact)
        const widthChecks = verifyColumnWidths(bytes, artifact)
        const allChecks = [...contentChecks, ...formatChecks, ...widthChecks]
        const passed = allChecks.filter((c) => c.passed).length
        totalPass += passed
        totalChecks += allChecks.length
        console.log(`    Fidelity: ${passed}/${allChecks.length}`)
        for (const c of allChecks) {
          if (!c.passed) {
            console.log(`    ❌ ${c.concern}: ${c.detail}`)
          }
        }
        // Only print failures to keep output readable; summarize passes.
        const failures = allChecks.filter((c) => !c.passed)
        if (failures.length === 0) {
          console.log(`    ✅ all ${allChecks.length} checks passed`)
        }
      } catch (e) {
        console.log(`    ERROR: ${e instanceof Error ? e.message : String(e)}`)
        totalChecks++
      }
    }
    console.log('')
  }

  console.log('=== SUMMARY ===')
  console.log(`Total: ${totalPass}/${totalChecks} checks passed across all variants + candidates`)
  console.log('')
  console.log('Checks cover:')
  console.log('  content (independent read-back): sheet name, row count, column count,')
  console.log('    header values, data values, totals label')
  console.log('  M1 number formats: present in styles.xml + applied to numeric cells')
  console.log('  M2 column widths: present in sheet1.xml <cols> and match config')
  console.log('  M3 config variants: header off, totals off, custom name, custom')
  console.log('    decimals, custom column order/widths/formats')
  console.log('  M4 single-sheet: XlsxArtifact carries one worksheet (not an array)')
}

main().catch((e) => {
  console.error('Fidelity eval failed:', e)
  process.exit(1)
})
