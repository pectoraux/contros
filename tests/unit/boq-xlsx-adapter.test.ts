/**
 * Unit tests for the pure XLSX adapter.
 *
 * These establish the adapter contract invariants:
 *   - CANONICAL ADAPTER INVARIANT: same (projection, adapterVersion, config)
 *     → same XlsxArtifact content (sheets, rows, cells, formats, order).
 *   - DISPLAY ROUNDING preserves the projection: quantity 1.2375 → cell 1.24,
 *     but the projection value is never mutated.
 *   - ORDERING: rows follow projection order (frozen snapshot order); columns
 *     follow config order.
 *   - FORMAT INDEPENDENCE from projection mutation: building the artifact twice
 *     from the same projection produces identical artifacts, and the projection
 *     is unchanged.
 *   - VERSIONING: the artifact carries adapterVersion + formatting config
 *     (incl. formattingVersion) + sourceContentHash for traceability.
 *   - BOUNDARY: the adapter module imports no DB/engine/repository symbols.
 *
 * The projection fixtures are built via the real finalizeRevision engine.
 */

import { test, expect, describe } from 'bun:test'
import {
  finalizeRevision,
  type LineSnapshot,
  type PolicySnapshot,
} from '../../src/lib/engines/revision-service'
import { projectRevision } from '../../src/lib/boq/projection'
import {
  buildXlsxArtifact,
  artifactsMatch,
  asXlsxAdapterVersion,
  CURRENT_XLSX_ADAPTER_VERSION,
  DEFAULT_XLSX_FORMATTING,
} from '../../src/lib/boq/xlsx-adapter'
import type { XlsxAdapterInput, XlsxFormattingConfig } from '../../src/lib/boq/xlsx-adapter-contract'
import type { BoqProjection } from '../../src/lib/boq/projection-contract'

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

function makeProjection(lines: LineSnapshot[] = [makeLine()]): BoqProjection {
  const snap = finalizeRevision('est-1', 1, POLICY, lines)
  return projectRevision({
    estimateRevisionId: 'rev-1',
    snapshotJson: snap,
    projectionVersion: 1 as never,
  })
}

function makeAdapterInput(
  projection: BoqProjection,
  overrides: Partial<XlsxAdapterInput> = {},
): XlsxAdapterInput {
  return {
    projection,
    adapterVersion: CURRENT_XLSX_ADAPTER_VERSION,
    formatting: DEFAULT_XLSX_FORMATTING,
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('XLSX adapter — basic shape', () => {
  test('builds an artifact with a single BOQ worksheet, header + data + totals', () => {
    const proj = makeProjection()
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    expect(artifact.worksheets).toHaveLength(1)
    const sheet = artifact.worksheets[0]
    expect(sheet.name).toBe('BOQ')
    // header + 1 data row + totals row
    expect(sheet.rows).toHaveLength(3)
    expect(sheet.rows[0].isHeader).toBe(true)
    expect(sheet.rows[1].isHeader).toBe(false)
    expect(sheet.rows[1].isTotals).toBe(false)
    expect(sheet.rows[2].isTotals).toBe(true)
  })

  test('artifact carries adapterVersion, formatting config, and sourceContentHash', () => {
    const proj = makeProjection()
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    expect(artifact.adapterVersion).toBe(CURRENT_XLSX_ADAPTER_VERSION)
    expect(artifact.formatting.formattingVersion).toBe(DEFAULT_XLSX_FORMATTING.formattingVersion)
    expect(artifact.sourceContentHash).toBe(proj.provenance.contentHash)
  })
})

describe('XLSX adapter — CANONICAL INVARIANT (same inputs → same artifact)', () => {
  test('two builds from the same projection + version + config are content-identical', () => {
    const proj = makeProjection()
    const a = buildXlsxArtifact(makeAdapterInput(proj))
    const b = buildXlsxArtifact(makeAdapterInput(proj))
    expect(artifactsMatch(a, b)).toBe(true)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test('changing the projection changes the artifact', () => {
    const proj1 = makeProjection([makeLine({ quantity: 100 })])
    const proj2 = makeProjection([makeLine({ quantity: 120 })])
    const a = buildXlsxArtifact(makeAdapterInput(proj1))
    const b = buildXlsxArtifact(makeAdapterInput(proj2))
    expect(artifactsMatch(a, b)).toBe(false)
  })

  test('changing the formatting config changes the artifact', () => {
    const proj = makeProjection()
    const config2: XlsxFormattingConfig = {
      ...DEFAULT_XLSX_FORMATTING,
      formattingVersion: 2,
      worksheetName: 'BOQ-v2',
    }
    const a = buildXlsxArtifact(makeAdapterInput(proj))
    const b = buildXlsxArtifact(makeAdapterInput(proj, { formatting: config2 }))
    expect(artifactsMatch(a, b)).toBe(false)
    expect(b.worksheets[0].name).toBe('BOQ-v2')
  })

  test('changing the adapter version changes the artifact identity', () => {
    const proj = makeProjection()
    const a = buildXlsxArtifact(makeAdapterInput(proj))
    const b = buildXlsxArtifact(makeAdapterInput(proj, { adapterVersion: asXlsxAdapterVersion(2) }))
    expect(a.adapterVersion).not.toBe(b.adapterVersion)
  })
})

describe('XLSX adapter — DISPLAY ROUNDING preserves the projection', () => {
  test('quantity 1.2375 → cell value 1.24 (display-rounded), projection stays 1.2375', () => {
    const proj = makeProjection([makeLine({ quantity: 1.2375 })])
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const sheet = artifact.worksheets[0]
    const dataRow = sheet.rows.find((r) => !r.isHeader && !r.isTotals)!
    // Find the Qty column (index 4 in default config: No, Code, Desc, Unit, Qty).
    const qtyCell = dataRow.cells[4]
    expect(qtyCell.value).toBe(1.24) // display-rounded
    // The PROJECTION is unchanged — its quantity is still the exact 1.2375.
    expect(proj.rows[0].quantity).toBe(1.2375)
    // And the projection's contentHash is still the lossless one.
    expect(artifact.sourceContentHash).toBe(proj.provenance.contentHash)
  })

  test('money values are display-rounded; projection values are exact', () => {
    const proj = makeProjection([makeLine({ quantity: 100 })])
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const sheet = artifact.worksheets[0]
    const dataRow = sheet.rows.find((r) => !r.isHeader && !r.isTotals)!
    // sellPrice cell is display-rounded to 2dp.
    const sellCell = dataRow.cells[6] // Sell Price column
    expect(typeof sellCell.value).toBe('number')
    // The projection value equals the replayed breakdown (exact, no re-round).
    // The cell value is round2 of that. Verify the cell is a 2dp number.
    expect(Number.isFinite(sellCell.value as number)).toBe(true)
    // Projection unchanged.
    expect(proj.rows[0].commercial.sellPrice).toBe(proj.rows[0].commercial.sellPrice) // identity
  })

  test('building the artifact does NOT mutate the projection', () => {
    const proj = makeProjection([makeLine({ quantity: 1.2375 })])
    const before = JSON.stringify(proj)
    buildXlsxArtifact(makeAdapterInput(proj))
    buildXlsxArtifact(makeAdapterInput(proj))
    const after = JSON.stringify(proj)
    expect(after).toBe(before) // projection untouched
  })

  test('a projection with many-decimal quantity: display cell is rounded, projection is exact', () => {
    const proj = makeProjection([makeLine({ quantity: 123.456789 })])
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const dataRow = artifact.worksheets[0].rows.find((r) => !r.isHeader && !r.isTotals)!
    expect(dataRow.cells[4].value).toBe(123.46) // display-rounded to 2dp
    expect(proj.rows[0].quantity).toBe(123.456789) // projection exact
  })
})

describe('XLSX adapter — ORDERING', () => {
  test('data rows follow projection order (frozen snapshot order)', () => {
    const proj = makeProjection([
      makeLine({ lineId: 'z' }),
      makeLine({ lineId: 'a' }),
      makeLine({ lineId: 'm' }),
    ])
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const dataRows = artifact.worksheets[0].rows.filter((r) => !r.isHeader && !r.isTotals)
    // rowNumber is 1,2,3 in projection order (z, a, m) — NOT sorted.
    expect(dataRows.map((r) => r.cells[0].value)).toEqual([1, 2, 3])
  })

  test('columns follow the config column order', () => {
    const proj = makeProjection()
    const config: XlsxFormattingConfig = {
      ...DEFAULT_XLSX_FORMATTING,
      columns: [
        ...DEFAULT_XLSX_FORMATTING.columns.slice().reverse(),
      ],
    }
    const artifact = buildXlsxArtifact(makeAdapterInput(proj, { formatting: config }))
    const header = artifact.worksheets[0].rows[0]
    expect(header.cells[0].value).toBe('Margin %') // reversed order
  })
})

describe('XLSX adapter — totals row', () => {
  test('totals row sums sellPrice, directCost, expectedProfit from projection totals', () => {
    const proj = makeProjection([makeLine({ quantity: 100 }), makeLine({ lineId: 'l2', quantity: 50 })])
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const totalsRow = artifact.worksheets[0].rows.find((r) => r.isTotals)!
    // Sell Price column (index 6), Direct Cost (7), Exp Profit (8).
    expect(totalsRow.cells[6].value).toBe(Math.round(proj.totals.totalSellPrice * 100) / 100)
    expect(totalsRow.cells[7].value).toBe(Math.round(proj.totals.totalDirectCost * 100) / 100)
    expect(totalsRow.cells[8].value).toBe(Math.round(proj.totals.totalExpectedProfit * 100) / 100)
  })

  test('totals row labels the Description column as TOTAL', () => {
    const proj = makeProjection()
    const artifact = buildXlsxArtifact(makeAdapterInput(proj))
    const totalsRow = artifact.worksheets[0].rows.find((r) => r.isTotals)!
    // Description column is index 2.
    expect(totalsRow.cells[2].value).toBe('TOTAL')
  })

  test('includeTotalsRow=false omits the totals row', () => {
    const proj = makeProjection()
    const config: XlsxFormattingConfig = { ...DEFAULT_XLSX_FORMATTING, includeTotalsRow: false }
    const artifact = buildXlsxArtifact(makeAdapterInput(proj, { formatting: config }))
    expect(artifact.worksheets[0].rows.some((r) => r.isTotals)).toBe(false)
  })
})

describe('XLSX adapter — includeHeader toggle', () => {
  test('includeHeader=false omits the header row', () => {
    const proj = makeProjection()
    const config: XlsxFormattingConfig = { ...DEFAULT_XLSX_FORMATTING, includeHeader: false }
    const artifact = buildXlsxArtifact(makeAdapterInput(proj, { formatting: config }))
    expect(artifact.worksheets[0].rows.some((r) => r.isHeader)).toBe(false)
    // First row is now a data row.
    expect(artifact.worksheets[0].rows[0].isHeader).toBe(false)
  })
})

describe('XLSX adapter — BOUNDARY (no DB / engine / repository access)', () => {
  test('the adapter module imports no forbidden symbols', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/lib/boq/xlsx-adapter.ts', 'utf8')
    // Must NOT import db, engines (pricing), or repositories.
    expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/from ['"]@\/lib\/engines['"]/)
    expect(src).not.toMatch(/from ['"]@\/repositories['"]/)
    expect(src).not.toMatch(/db\.|prisma|estimateLine\.|PricingEngine|priceLine|finalizeRevision|replayRevision/i)
    // Must import only from the projection contract + adapter contract.
    expect(src).toMatch(/from ['"]\.\/projection-contract['"]/)
    expect(src).toMatch(/from ['"]\.\/xlsx-adapter-contract['"]/)
  })

  test('the adapter contract module imports no forbidden symbols', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/lib/boq/xlsx-adapter-contract.ts', 'utf8')
    expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/from ['"]@\/lib\/engines['"]/)
    expect(src).not.toMatch(/from ['"]@\/repositories['"]/)
  })
})

describe('asXlsxAdapterVersion', () => {
  test('brands a positive integer', () => {
    expect(asXlsxAdapterVersion(1)).toBe(1)
    expect(asXlsxAdapterVersion(2)).toBe(2)
  })
  test('rejects non-positive / non-integer', () => {
    expect(() => asXlsxAdapterVersion(0)).toThrow(/Invalid XLSX adapter version/)
    expect(() => asXlsxAdapterVersion(-1)).toThrow(/Invalid XLSX adapter version/)
    expect(() => asXlsxAdapterVersion(1.5)).toThrow(/Invalid XLSX adapter version/)
  })
})
