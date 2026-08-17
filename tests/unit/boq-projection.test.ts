/**
 * Unit tests for the deterministic BOQ projection.
 *
 * These establish the projection contract invariants:
 *   - HISTORICAL RULE: same revision + same projectionVersion → byte-identical
 *     projection (rows + contentHash), regardless of who/when generates it.
 *   - DETERMINISM: no wall-clock time, no randomness, no external state.
 *   - FIELD COVERAGE: every contracted field is present and correctly sourced
 *     from the snapshot (NOT from mutable state).
 *   - ORDERING: rowNumber is 1-based and follows the snapshot's line order.
 *   - PROVENANCE: source identity, projectionVersion, contentHash, rowCount.
 *   - PROJECTION-ONLY: the output is read-only; there is no write-back path.
 *   - ERROR HANDLING: invalid snapshot / unsupported version are rejected.
 *
 * The snapshot is built via the real `finalizeRevision` engine so the tests
 * exercise actual engine output, not hand-constructed fixtures.
 */

import { test, expect, describe } from 'bun:test'
import {
  finalizeRevision,
  type LineSnapshot,
  type PolicySnapshot,
} from '../../src/lib/engines/revision-service'
import {
  projectRevision,
  projectionsMatch,
  asProjectionVersion,
  CURRENT_PROJECTION_VERSION,
  type BoqProjection,
  type ProjectionInput,
} from '../../src/lib/boq/projection'
import type { ExecutionSegmentInput, PricingInput } from '../../src/lib/engines/pricing-engine'

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A minimal self-perform line snapshot with a WorkDefinitionVersion. */
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

const POLICY: PolicySnapshot = {
  overheadPct: 0.1,
  profitPct: 0.1,
  contingencyPct: 0.02,
}

/** Build a valid snapshotJson from lines, via the real finalizeRevision. */
function makeSnapshot(lines: LineSnapshot[], estimateId = 'est-1', revisionNo = 1): string {
  return finalizeRevision(estimateId, revisionNo, POLICY, lines)
}

function makeInput(
  snapshotJson: string,
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    estimateRevisionId: 'rev-1',
    snapshotJson,
    projectionVersion: CURRENT_PROJECTION_VERSION,
    generatedBy: 'test',
    generationContext: 'unit-test',
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BOQ projection — basic shape', () => {
  test('projects a single-line revision with all contracted fields', () => {
    const snap = makeSnapshot([makeLine()])
    const proj = projectRevision(makeInput(snap))
    expect(proj.rows).toHaveLength(1)
    const row = proj.rows[0]
    // Identity
    expect(row.identity.lineId).toBe('line-1')
    expect(row.identity.rowNumber).toBe(1)
    // Fields from the snapshot
    expect(row.description).toBe('PVC conduit 25mm')
    expect(row.quantity).toBe(100)
    expect(row.unit).toBe('m')
    // WorkDefinition projected from the snapshot WDV
    expect(row.workDefinition).not.toBeNull()
    expect(row.workDefinition!.versionId).toBe('wdv-1')
    expect(row.workDefinition!.name).toBe('PVC Conduit')
    expect(row.workDefinition!.version).toBe(1)
    expect(row.workDefinition!.wastage).toBe(0.05)
    // Commercial from the replayed breakdown
    expect(row.commercial.executionStrategy).toBe('self-perform')
    expect(typeof row.commercial.unitRate).toBe('number')
    expect(typeof row.commercial.sellPrice).toBe('number')
    expect(typeof row.commercial.directCost).toBe('number')
    expect(typeof row.commercial.expectedProfit).toBe('number')
    expect(typeof row.commercial.expectedMarginPct).toBe('number')
    // Totals (numbers — correctness proven by the "projected == replayed" test;
    // the fixture's hand-constructed recipe may yield zero, which is valid).
    expect(typeof proj.totals.totalSellPrice).toBe('number')
    expect(typeof proj.totals.totalDirectCost).toBe('number')
  })

  test('workDefinition is null when the snapshot line has no WDV', () => {
    const snap = makeSnapshot([makeLine({ workDefinitionVersion: null })])
    const proj = projectRevision(makeInput(snap))
    expect(proj.rows[0].workDefinition).toBeNull()
  })
})

describe('BOQ projection — ordering (deterministic)', () => {
  test('rowNumber is 1-based and follows snapshot line order', () => {
    const snap = makeSnapshot([
      makeLine({ lineId: 'a' }),
      makeLine({ lineId: 'b' }),
      makeLine({ lineId: 'c' }),
    ])
    const proj = projectRevision(makeInput(snap))
    expect(proj.rows.map((r) => r.identity.lineId)).toEqual(['a', 'b', 'c'])
    expect(proj.rows.map((r) => r.identity.rowNumber)).toEqual([1, 2, 3])
  })

  test('same snapshot always produces the same row order', () => {
    const snap = makeSnapshot([
      makeLine({ lineId: 'z' }),
      makeLine({ lineId: 'a' }),
      makeLine({ lineId: 'm' }),
    ])
    const a = projectRevision(makeInput(snap))
    const b = projectRevision(makeInput(snap))
    expect(a.rows.map((r) => r.identity.lineId)).toEqual(b.rows.map((r) => r.identity.lineId))
  })
})

describe('BOQ projection — HISTORICAL RULE (the core invariant)', () => {
  test('same revision + same projectionVersion → canonical-content-identical (rows + contentHash)', () => {
    const snap = makeSnapshot([
      makeLine({ lineId: 'l1' }),
      makeLine({ lineId: 'l2', quantity: 50 }),
    ])
    const a = projectRevision(makeInput(snap))
    const b = projectRevision(makeInput(snap))
    // contentHash identical
    expect(a.provenance.contentHash).toBe(b.provenance.contentHash)
    // rows identical (canonical content)
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows))
    // totals identical (canonical content)
    expect(JSON.stringify(a.totals)).toBe(JSON.stringify(b.totals))
    // projectionsMatch confirms canonical-content equivalence
    expect(projectionsMatch(a, b)).toBe(true)
  })

  test('two generations by DIFFERENT actors → same rows + same contentHash', () => {
    const snap = makeSnapshot([makeLine()])
    const byEstimator = projectRevision(makeInput(snap, { generatedBy: 'estimator-abena' }))
    const byDirector = projectRevision(makeInput(snap, { generatedBy: 'director-kwesi' }))
    // Audit-only fields differ
    expect(byEstimator.provenance.generatedBy).toBe('estimator-abena')
    expect(byDirector.provenance.generatedBy).toBe('director-kwesi')
    // But rows + contentHash are identical (audit-only fields don't affect them)
    expect(byEstimator.provenance.contentHash).toBe(byDirector.provenance.contentHash)
    expect(JSON.stringify(byEstimator.rows)).toBe(JSON.stringify(byDirector.rows))
    expect(projectionsMatch(byEstimator, byDirector)).toBe(true)
  })

  test('different generation contexts → same rows + same contentHash', () => {
    const snap = makeSnapshot([makeLine()])
    const tenderExport = projectRevision(makeInput(snap, { generationContext: 'tender-pack' }))
    const internalReview = projectRevision(makeInput(snap, { generationContext: 'internal-review' }))
    expect(tenderExport.provenance.generationContext).toBe('tender-pack')
    expect(internalReview.provenance.generationContext).toBe('internal-review')
    expect(tenderExport.provenance.contentHash).toBe(internalReview.provenance.contentHash)
    expect(projectionsMatch(tenderExport, internalReview)).toBe(true)
  })

  test('contentHash changes when the revision content changes', () => {
    const snap1 = makeSnapshot([makeLine({ lineId: 'l1', quantity: 100 })])
    const snap2 = makeSnapshot([makeLine({ lineId: 'l1', quantity: 120 })])
    const a = projectRevision(makeInput(snap1))
    const b = projectRevision(makeInput(snap2))
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash)
    expect(projectionsMatch(a, b)).toBe(false)
  })

  test('F1/F3: contentHash changes when WorkDefinition NAME changes (same versionId/version)', () => {
    // The hash must cover the COMPLETE projection content, including the WD
    // name/unit/wastage — not just versionId/version. Two snapshots with the
    // same versionId/version but different WD names must produce different hashes.
    const baseWdv = makeLine().workDefinitionVersion!
    const snap1 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, name: 'PVC Conduit' },
    })])
    const snap2 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, name: 'PVC Conduit Heavy' }, // same id+version, different name
    })])
    const a = projectRevision(makeInput(snap1))
    const b = projectRevision(makeInput(snap2))
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash)
    expect(projectionsMatch(a, b)).toBe(false)
  })

  test('F1/F3: contentHash changes when WorkDefinition WASTAGE changes (same versionId/version)', () => {
    const baseWdv = makeLine().workDefinitionVersion!
    const snap1 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, wastage: 0.05 },
    })])
    const snap2 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, wastage: 0.10 }, // same id+version, different wastage
    })])
    const a = projectRevision(makeInput(snap1))
    const b = projectRevision(makeInput(snap2))
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash)
    expect(projectionsMatch(a, b)).toBe(false)
  })

  test('F1/F3: contentHash changes when WorkDefinition UNIT changes (same versionId/version)', () => {
    const baseWdv = makeLine().workDefinitionVersion!
    const snap1 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, unit: 'm' },
    })])
    const snap2 = makeSnapshot([makeLine({
      workDefinitionVersion: { ...baseWdv, unit: 'm2' }, // same id+version, different unit
    })])
    const a = projectRevision(makeInput(snap1))
    const b = projectRevision(makeInput(snap2))
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash)
    expect(projectionsMatch(a, b)).toBe(false)
  })

  test('F1/F3: contentHash changes when totals change (e.g. a line is added)', () => {
    // The hash covers totals, so adding a line (which changes totals) must
    // change the hash even if the first line is identical.
    const snap1 = makeSnapshot([makeLine({ lineId: 'l1' })])
    const snap2 = makeSnapshot([makeLine({ lineId: 'l1' }), makeLine({ lineId: 'l2', quantity: 50 })])
    const a = projectRevision(makeInput(snap1))
    const b = projectRevision(makeInput(snap2))
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash)
    expect(projectionsMatch(a, b)).toBe(false)
  })
})

describe('BOQ projection — provenance', () => {
  test('provenance carries source identity, version, hash, rowCount', () => {
    const snap = makeSnapshot([makeLine(), makeLine({ lineId: 'l2' })])
    const proj = projectRevision(makeInput(snap, { estimateRevisionId: 'rev-xyz' }))
    const p = proj.provenance
    expect(p.source.estimateRevisionId).toBe('rev-xyz')
    expect(p.source.estimateId).toBe('est-1')
    expect(p.source.revisionNo).toBe(1)
    expect(p.source.snapshotVersion).toBe(2) // v2 snapshot format
    expect(p.projectionVersion).toBe(CURRENT_PROJECTION_VERSION)
    expect(p.contentHash).toHaveLength(16) // 8+8 hex
    expect(p.rowCount).toBe(2)
    expect(p.generatedBy).toBe('test')
    expect(p.generationContext).toBe('unit-test')
  })
})

describe('BOQ projection — error handling', () => {
  test('invalid snapshot JSON → throws', () => {
    expect(() => projectRevision(makeInput('not-json'))).toThrow(/Cannot project/)
  })

  test('snapshot missing lines array → throws', () => {
    const badSnap = JSON.stringify({ estimateId: 'e', revisionNo: 1, policy: POLICY, finalizedAt: 'x', snapshotVersion: 2 })
    expect(() => projectRevision(makeInput(badSnap))).toThrow(/Cannot project/)
  })

  test('unsupported projection version → throws', () => {
    const snap = makeSnapshot([makeLine()])
    expect(() =>
      projectRevision(makeInput(snap, { projectionVersion: asProjectionVersion(999) })),
    ).toThrow(/Unsupported projection version/)
  })

  test('non-integer / negative projection version → throws', () => {
    const snap = makeSnapshot([makeLine()])
    expect(() =>
      projectRevision(makeInput(snap, { projectionVersion: 0 as never })),
    ).toThrow(/Invalid projection version/)
  })
})

describe('BOQ projection — projection-only semantics (no write-back)', () => {
  test('the projection type is read-only: mutating a row does not affect the source', () => {
    const snap = makeSnapshot([makeLine()])
    const proj = projectRevision(makeInput(snap))
    // Attempt to mutate a projected commercial value (this would be what a
    // rogue XLSX adapter might try). The projection is a plain object, so JS
    // allows the mutation, but it has NO effect on the source snapshot or any
    // EstimateLine — the projection is a derived read-only view.
    const originalRate = proj.rows[0].commercial.unitRate
    proj.rows[0].commercial.unitRate = 999999
    // Re-project: the value is unchanged (the source snapshot was never touched).
    const proj2 = projectRevision(makeInput(snap))
    expect(proj2.rows[0].commercial.unitRate).toBe(originalRate)
    // The EstimateRevision snapshotJson itself is untouched (it's a string).
    expect(snap).toBe(makeSnapshot([makeLine()])) // same input → same string
  })

  test('there is no "apply projection back to estimate" function exported', async () => {
    // The projection module exports projectRevision + projectionsMatch + version
    // helpers. It does NOT export any write-back / apply / sync function.
    // This is a structural guarantee: the type system + module surface enforce
    // projection-only semantics. We assert no write-back symbol is exported.
    const mod = await import('../../src/lib/boq/projection')
    const exportedKeys = Object.keys(mod)
    const writeBackPatterns = ['apply', 'sync', 'update', 'mutate', 'write', 'persist']
    const writeBackExports = exportedKeys.filter((k) =>
      writeBackPatterns.some((p) => k.toLowerCase().includes(p)),
    )
    expect(writeBackExports).toEqual([])
  })
})

describe('BOQ projection — commercial fields come from the replayed snapshot', () => {
  test('the projected sellPrice equals the replay total for a single line', () => {
    const snap = makeSnapshot([makeLine({ quantity: 100 })])
    const proj = projectRevision(makeInput(snap))
    // For a single line, the row sellPrice == total sellPrice.
    expect(proj.rows[0].commercial.sellPrice).toBe(proj.totals.totalSellPrice)
  })

  test('projected commercial values equal the replayed breakdown (direct comparison)', async () => {
    // The projection's commercial fields must come from the REPLAYED snapshot,
    // not from mutable state. We prove this by calling replayRevision directly
    // and comparing the projected values to the replayed breakdown.
    const { replayRevision } = await import('../../src/lib/engines/revision-service')
    const snap = makeSnapshot([makeLine({ lineId: 'l1' }), makeLine({ lineId: 'l2', quantity: 50 })])
    const replay = replayRevision(snap)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    const proj = projectRevision(makeInput(snap))
    // Each projected row's commercial must match the corresponding replayed line.
    expect(proj.rows[0].commercial.sellPrice).toBe(replay.lines[0].breakdown.sellPrice)
    expect(proj.rows[0].commercial.directCost).toBe(replay.lines[0].breakdown.directCost)
    expect(proj.rows[0].commercial.unitRate).toBe(replay.lines[0].breakdown.unitRate)
    // Totals must match the replay totals.
    expect(proj.totals.totalSellPrice).toBe(replay.totalSellPrice)
    expect(proj.totals.totalDirectCost).toBe(replay.totalDirectCost)
  })
})

describe('BOQ projection — format independence', () => {
  test('the projection contains no Excel/XLSX-specific concepts', () => {
    const snap = makeSnapshot([makeLine()])
    const proj = projectRevision(makeInput(snap))
    const serialized = JSON.stringify(proj)
    // The domain projection must be format-free — no Excel-specific terms.
    // (rowCount/rowNumber/rows are legitimate domain terms, not Excel concepts.)
    // Another implementation (CSV, PDF) can consume exactly this shape.
    expect(serialized).not.toMatch(/xlsx|spreadsheet|worksheet|cellRef|columnLetter|sheetName|workbook/i)
  })
})

describe('asProjectionVersion', () => {
  test('brands a positive integer as a ProjectionVersion', () => {
    expect(asProjectionVersion(1)).toBe(1)
    expect(asProjectionVersion(2)).toBe(2)
  })
  test('rejects non-positive / non-integer', () => {
    expect(() => asProjectionVersion(0)).toThrow(/Invalid projection version/)
    expect(() => asProjectionVersion(-1)).toThrow(/Invalid projection version/)
    expect(() => asProjectionVersion(1.5)).toThrow(/Invalid projection version/)
  })
})
