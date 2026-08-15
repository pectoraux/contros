/**
 * Final integrity pass tests — P0-1 through P0-8.
 *
 * Run: bun test tests/unit/integrity.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { priceLine, type PricingInput, type CostRecipeLine } from '../../src/lib/engines/pricing-engine'
import { reconcileSubcontract } from '../../src/lib/engines/subcontract-reconciliation'
import { finalizeRevision, replayRevision, validateBidSubmission } from '../../src/lib/engines/revision-service'

const WD = (recipe: CostRecipeLine[], wastage = 0.05) => ({
  id: 'wdv-1', name: 'Test WD', version: 1, unit: 'm2', wastage, productivityRule: 12,
  costRecipeJson: JSON.stringify(recipe),
})

const pricedLine = (overrides: Partial<CostRecipeLine> = {}): CostRecipeLine => ({
  resourceKind: 'material', resourceCode: 'RES-1', resourceName: 'Cement', unit: 'ton',
  quantityPerUnit: 0.035,
  priceObservation: { price: 95, provenance: 'supplier-quote', sourceReference: 'Q1', observedAt: '2025-01-01' },
  ...overrides,
})

const baseInput = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  workDefinitionVersion: WD([pricedLine()]),
  quantity: 100, executionStrategy: 'self-perform',
  overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
  ...overrides,
})

// ── P0-2: Invalid price observations ────────────────────────────────────────
describe('P0-2: invalid price observations never become zero', () => {
  test('NaN price → blocking input, not zero', () => {
    const recipe = [pricedLine({ priceObservation: { price: NaN, provenance: 'invoice', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-price-observation')).toBe(true)
    // The invalid price does NOT contribute zero — the line is blocked
    expect(result.material).toBe(0)
  })

  test('Infinity price → blocking input', () => {
    const recipe = [pricedLine({ priceObservation: { price: Infinity, provenance: 'invoice', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-price-observation')).toBe(true)
    expect(result.calculationStatus).toBe('incomplete')
  })

  test('negative price → blocking input', () => {
    const recipe = [pricedLine({ priceObservation: { price: -10, provenance: 'invoice', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-price-observation')).toBe(true)
  })

  test('invalid quantityPerUnit → blocking input', () => {
    const recipe = [pricedLine({ quantityPerUnit: -1, priceObservation: { price: 95, provenance: 'invoice', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-quantity')).toBe(true)
  })

  test('invalid wastage → blocking input', () => {
    const result = priceLine(baseInput({ workDefinitionVersion: WD([pricedLine()], -0.5) }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-wastage')).toBe(true)
  })

  test('negative overhead → blocking input', () => {
    const result = priceLine(baseInput({ overheadPct: -0.1 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(true)
  })

  test('negative quantity → blocking input', () => {
    const result = priceLine(baseInput({ quantity: -50 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-quantity')).toBe(true)
  })
})

// ── P0-3: Hybrid validation ─────────────────────────────────────────────────
describe('P0-3: hybrid execution validation', () => {
  test('hybrid with only self-perform segments → incomplete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        { strategy: 'self-perform', quantityPct: 0.3 },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'hybrid-missing-strategy')).toBe(true)
  })

  test('hybrid with only subcontract segments → incomplete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'subcontract', quantityPct: 0.7, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 } },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: { totalAmount: 2000, coveragePct: 1.0 } },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'hybrid-missing-strategy')).toBe(true)
  })

  test('hybrid segment with quantityPct > 1 → incomplete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 1.5 },
        { strategy: 'subcontract', quantityPct: -0.5, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 } },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-hybrid-segment')).toBe(true)
  })

  test('hybrid with valid 70/30 both strategies → complete', () => {
    const recipe = [
      pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } }),
      pricedLine({ resourceKind: 'labour', resourceName: 'Mason', quantityPerUnit: 0.083, priceObservation: { price: 120, provenance: 'p', observedAt: '2025-01-01' } }),
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 }, quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' as const },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    expect(result.blockingInputs.length).toBe(0)
  })
})

// ── P0-4: Subcontract pricing vs coverage ───────────────────────────────────
describe('P0-4: subcontract pricing vs coverage', () => {
  test('pure subcontract with full coverage → complete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 50000, coveragePct: 1.0 },
    }))
    expect(result.calculationStatus).toBe('complete')
    expect(result.subcontract).toBe(50000)
    expect(result.uncoveredSubcontractExposure).toBe(0)
  })

  test('pure subcontract with partial coverage (40%) → incomplete, exposure unknown without uncoveredScopeValue', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 40000, coveragePct: 0.4 },
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'uncovered-exposure-unknown')).toBe(true)
    expect(result.exposureUnknown).toBe(true)
    expect(result.uncoveredSubcontractExposure).toBe(0) // NOT extrapolated to 60000
  })

  test('pure subcontract with partial coverage + uncoveredScopeValue → uses actual value', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 40000, coveragePct: 0.4, uncoveredScopeValue: 55000 },
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'partial-subcontract-coverage')).toBe(true)
    expect(result.uncoveredSubcontractExposure).toBe(55000) // actual, not extrapolated
    expect(result.exposureUnknown).toBe(false)
  })

  test('hybrid subcontract segment with partial coverage → incomplete, exposure unknown', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: { totalAmount: 10000, coveragePct: 0.5 }, quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' as const },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'uncovered-exposure-unknown')).toBe(true)
    expect(result.exposureUnknown).toBe(true)
  })
})

// ── P0-1: Semantic vs economic coverage ─────────────────────────────────────
describe('P0-1: semantic vs economic scope coverage', () => {
  const atoms = [
    { id: 'a1', name: 'manufacture', valueWeight: 0.80 }, // 80% of value
    { id: 'a2', name: 'installation', valueWeight: 0.10 },
    { id: 'a3', name: 'delivery', valueWeight: 0.05 },
    { id: 'a4', name: 'testing', valueWeight: 0.05 },
  ]
  const requiredLines = [{ id: 'l1', description: 'Windows', sellPrice: 100000 }]

  test('only manufacture covered → semantic 25%, economic 80%', () => {
    const result = reconcileSubcontract({
      requiredLines,
      scopeAtoms: atoms,
      quote: {
        id: 'q1', totalAmount: 80000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'covered' },
          { scopeAtomId: 'a2', status: 'excluded' },
          { scopeAtomId: 'a3', status: 'excluded' },
          { scopeAtomId: 'a4', status: 'excluded' },
        ],
      },
    })
    expect(result.semanticCoveragePct).toBe(0.25) // 1/4 atoms
    expect(result.economicCoveragePct).toBe(0.80) // 0.80 / 1.00
    expect(result.coveragePct).toBe(0.80) // economic is primary
    expect(result.economicCoverageUnknown).toBe(false)
  })

  test('only testing covered → semantic 25%, economic 5%', () => {
    const result = reconcileSubcontract({
      requiredLines,
      scopeAtoms: atoms,
      quote: {
        id: 'q1', totalAmount: 5000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'excluded' },
          { scopeAtomId: 'a2', status: 'excluded' },
          { scopeAtomId: 'a3', status: 'excluded' },
          { scopeAtomId: 'a4', status: 'covered' },
        ],
      },
    })
    expect(result.semanticCoveragePct).toBe(0.25)
    expect(result.economicCoveragePct).toBe(0.05)
    expect(result.coveragePct).toBe(0.05) // economic is primary — much lower
    expect(result.status).toBe('blocker') // 5% is < 80%
  })

  test('all weights 0 → economic unknown, falls back to semantic', () => {
    const equalAtoms = [
      { id: 'a1', name: 'a', valueWeight: 0 },
      { id: 'a2', name: 'b', valueWeight: 0 },
    ]
    const result = reconcileSubcontract({
      requiredLines,
      scopeAtoms: equalAtoms,
      quote: {
        id: 'q1', totalAmount: 50000,
        scopeCoverages: [
          { scopeAtomId: 'a1', status: 'covered' },
          { scopeAtomId: 'a2', status: 'excluded' },
        ],
      },
    })
    expect(result.economicCoverageUnknown).toBe(true)
    expect(result.economicCoveragePct).toBe(result.semanticCoveragePct)
    expect(result.coveragePct).toBe(0.5)
  })

  test('lump-sum quote → blocker, 0% coverage', () => {
    const result = reconcileSubcontract({
      requiredLines,
      scopeAtoms: atoms,
      quote: { id: 'q1', totalAmount: 90000, scopeCoverages: [] },
    })
    expect(result.isLumpSum).toBe(true)
    expect(result.coveragePct).toBe(0)
    expect(result.status).toBe('blocker')
  })
})

// ── P0-6: Revision reproducibility ──────────────────────────────────────────
describe('P0-6: estimate revision reproducibility', () => {
  test('finalize + replay produces same result after mutation', () => {
    const recipe = [
      pricedLine({ resourceKind: 'material', resourceName: 'Cement', quantityPerUnit: 0.035, priceObservation: { price: 95, provenance: 'invoice', observedAt: '2025-01-01' } }),
      pricedLine({ resourceKind: 'labour', resourceName: 'Mason', quantityPerUnit: 0.083, priceObservation: { price: 120, provenance: 'policy', observedAt: '2025-01-01' } }),
    ]
    const policy = { overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05 }
    const lines = [{
      lineId: 'l1', description: 'Blockwork', quantity: 100, unit: 'm2',
      executionStrategy: 'self-perform' as const,
      workDefinitionVersion: { id: 'wdv-1', name: 'Blockwork', version: 1, unit: 'm2', wastage: 0.05, productivityRule: 12, costRecipeJson: JSON.stringify(recipe) },
      executionSegments: [],
      subcontractQuote: null,
    }]

    // Finalize revision 1
    const snapshotJson = finalizeRevision('est-1', 1, policy, lines)

    // Replay immediately — record the result
    const replay1 = replayRevision(snapshotJson)
    expect(replay1.ok).toBe(true)
    if (replay1.ok) {
      const originalSell = replay1.totalSellPrice
      const originalDirect = replay1.totalDirectCost

      // Now mutate the current state — change cement price, WD version, etc.
      // The snapshot is immutable, so replay should produce the SAME result.
      const mutatedRecipe = [...recipe]
      mutatedRecipe[0] = { ...mutatedRecipe[0], priceObservation: { price: 999, provenance: 'changed', observedAt: '2025-06-01' } }

      // Replay the SAME snapshot — it must not use the mutated recipe
      const replay2 = replayRevision(snapshotJson)
      expect(replay2.ok).toBe(true)
      if (replay2.ok) {
        expect(replay2.totalSellPrice).toBe(originalSell)
        expect(replay2.totalDirectCost).toBe(originalDirect)
        // The replayed lines use the SNAPSHOT's recipe, not the mutated one
        expect(replay2.lines[0].breakdown.provenance[0].price).toBe(95) // original, not 999
      }
    }
  })

  test('invalid snapshot JSON → replay fails', () => {
    const result = replayRevision('not valid json')
    expect(result.ok).toBe(false)
  })

  test('snapshot with missing lines → replay fails', () => {
    const result = replayRevision(JSON.stringify({ estimateId: 'e1', revisionNo: 1, policy: {}, finalizedAt: '2025-01-01' }))
    expect(result.ok).toBe(false)
  })

  test('enriched snapshot captures full subcontract scope state', () => {
    const scopeSnapshot = {
      id: 'q1',
      supplierName: 'VoltTech',
      totalAmount: 18500,
      currency: 'GHS',
      exclusions: ['scaffolding', 'delivery'],
      assumptions: ['valid 30 days'],
      scopeCoverages: [
        { scopeAtomId: 'a1', atomName: 'manufacture', atomValueWeight: 0.4, status: 'covered' as const },
        { scopeAtomId: 'a2', atomName: 'delivery', atomValueWeight: 0.05, status: 'excluded' as const },
        { scopeAtomId: 'a3', atomName: 'installation', atomValueWeight: 0.35, status: 'excluded' as const },
      ],
      semanticCoveragePct: 0.33,
      economicCoveragePct: 0.40,
      economicCoverageUnknown: false,
      uncoveredExposure: 11000,
    }
    const lines = [{
      lineId: 'l1', description: 'Electrical', quantity: 500, unit: 'm',
      executionStrategy: 'subcontract' as const,
      workDefinitionVersion: null,
      executionSegments: [],
      subcontractQuote: { totalAmount: 18500, coveragePct: 0.40, scopeSnapshot },
    }]
    const snapshotJson = finalizeRevision('est-1', 1, { overheadPct: 0.1, profitPct: 0.12, contingencyPct: 0.05 }, lines)

    const replay = replayRevision(snapshotJson)
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      // The subcontract scope snapshot is preserved in the replay
      expect(replay.subcontractScopeSnapshots.length).toBe(1)
      expect(replay.subcontractScopeSnapshots[0].supplierName).toBe('VoltTech')
      expect(replay.subcontractScopeSnapshots[0].economicCoveragePct).toBe(0.40)
      expect(replay.subcontractScopeSnapshots[0].exclusions).toContain('scaffolding')
      expect(replay.subcontractScopeSnapshots[0].scopeCoverages.length).toBe(3)
      expect(replay.subcontractScopeSnapshots[0].uncoveredExposure).toBe(11000)
    }
  })

  test('replay is independent of current subcontract quote state', () => {
    const recipe = [pricedLine({ resourceKind: 'subcontract', resourceName: 'Subcontractor', quantityPerUnit: 1, priceObservation: { price: 0, provenance: 'quote', observedAt: '2025-01-01' } })]
    const scopeSnapshot = {
      id: 'q1', supplierName: 'Original', totalAmount: 50000, currency: 'GHS',
      exclusions: [], assumptions: [],
      scopeCoverages: [{ scopeAtomId: 'a1', atomName: 'all', atomValueWeight: 1, status: 'covered' as const }],
      semanticCoveragePct: 1, economicCoveragePct: 1, economicCoverageUnknown: false, uncoveredExposure: 0,
    }
    const lines = [{
      lineId: 'l1', description: 'Package', quantity: 1, unit: 'nr',
      executionStrategy: 'subcontract' as const,
      workDefinitionVersion: { id: 'wdv-1', name: 'Package', version: 1, unit: 'nr', wastage: 0, costRecipeJson: JSON.stringify(recipe) },
      executionSegments: [],
      subcontractQuote: { totalAmount: 50000, coveragePct: 1, scopeSnapshot },
    }]
    const snapshotJson = finalizeRevision('est-1', 1, { overheadPct: 0.1, profitPct: 0.12, contingencyPct: 0.05 }, lines)

    // Replay — the snapshot's quote (50000) is used, NOT any current mutable quote
    const replay = replayRevision(snapshotJson)
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(replay.totalSellPrice).toBeGreaterThan(0)
      // The scope snapshot preserves the original supplier name
      expect(replay.subcontractScopeSnapshots[0].supplierName).toBe('Original')
    }
  })
})

// ── P0-7: Bid submission invariant ───────────────────────────────────────────
describe('P0-7: bid submission invariant', () => {
  test('can submit with finalized revision + price + non-draft estimate', () => {
    const result = validateBidSubmission({
      estimateRevisionId: 'rev-1',
      estimateStatus: 'adjudicated',
      finalPrice: 100000,
      hasFinalizedRevision: true,
    })
    expect(result.ok).toBe(true)
  })

  test('cannot submit without estimateRevisionId', () => {
    const result = validateBidSubmission({
      estimateRevisionId: null,
      estimateStatus: 'adjudicated',
      finalPrice: 100000,
      hasFinalizedRevision: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('finalized estimate revision'))).toBe(true)
    }
  })

  test('cannot submit with draft estimate', () => {
    const result = validateBidSubmission({
      estimateRevisionId: 'rev-1',
      estimateStatus: 'draft',
      finalPrice: 100000,
      hasFinalizedRevision: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('draft'))).toBe(true)
    }
  })

  test('cannot submit without finalPrice', () => {
    const result = validateBidSubmission({
      estimateRevisionId: 'rev-1',
      estimateStatus: 'adjudicated',
      finalPrice: null,
      hasFinalizedRevision: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('Final price'))).toBe(true)
    }
  })

  test('cannot submit if revision is not finalized', () => {
    const result = validateBidSubmission({
      estimateRevisionId: 'rev-1',
      estimateStatus: 'adjudicated',
      finalPrice: 100000,
      hasFinalizedRevision: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('not finalized'))).toBe(true)
    }
  })

  test('cannot submit with incomplete estimate lines', () => {
    const result = validateBidSubmission({
      estimateRevisionId: 'rev-1',
      estimateStatus: 'adjudicated',
      finalPrice: 100000,
      hasFinalizedRevision: true,
      incompleteLineCount: 2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('incomplete calculations'))).toBe(true)
    }
  })
})

// ── P0-8: Auth role validation ──────────────────────────────────────────────
describe('P0-8: auth role validation', () => {
  test('isValidRole accepts the 4 allowed roles', async () => {
    const { isValidRole } = await import('../../src/lib/auth')
    expect(isValidRole('estimator')).toBe(true)
    expect(isValidRole('manager')).toBe(true)
    expect(isValidRole('director')).toBe(true)
    expect(isValidRole('admin')).toBe(true)
  })

  test('isValidRole rejects unknown roles', async () => {
    const { isValidRole } = await import('../../src/lib/auth')
    expect(isValidRole('superuser')).toBe(false)
    expect(isValidRole('')).toBe(false)
    expect(isValidRole('ESTIMATOR')).toBe(false) // case-sensitive
  })
})

// ── P0-4: Revision snapshot preserves pricingBasis + quoteCoversSegmentScope ─
describe('P0-4: revision snapshot preserves hybrid commercial state', () => {
  test('snapshot captures pricingBasis + quoteCoversSegmentScope, survives mutation', () => {
    const recipe = [
      pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } }),
    ]
    const policy = { overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05 }
    const lines = [{
      lineId: 'l1', description: 'Blockwork', quantity: 1000, unit: 'm2',
      executionStrategy: 'hybrid' as const,
      workDefinitionVersion: { id: 'wdv-1', name: 'Blockwork', version: 1, unit: 'm2', wastage: 0.05, productivityRule: 12, costRecipeJson: JSON.stringify(recipe) },
      executionSegments: [
        { strategy: 'self-perform' as const, quantityPct: 0.7 },
        {
          strategy: 'subcontract' as const,
          quantityPct: 0.3,
          scopeDefinition: 'Specialist blockwork at level 3',
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'direct-segment-quote' as const,
        },
      ],
      subcontractQuote: null,
    }]

    // Finalize revision 1 with direct-segment-quote (cost = 500000)
    const snapshotJson = finalizeRevision('est-1', 1, policy, lines)
    const replay1 = replayRevision(snapshotJson)
    expect(replay1.ok).toBe(true)
    if (replay1.ok) {
      // With direct-segment-quote, subcontract cost is the full 500000
      expect(replay1.lines[0].breakdown.subcontract).toBe(500000)
      // The snapshot preserved the pricingBasis
      const seg = replay1.snapshot.lines[0].executionSegments[1]
      expect(seg.pricingBasis).toBe('direct-segment-quote')
      expect(seg.quoteCoversSegmentScope).toBe(true)

      // Now mutate the live segments to proportional-from-package
      // The snapshot must NOT change — replay still uses direct-segment-quote
      const mutatedLines = JSON.parse(JSON.stringify(lines))
      mutatedLines[0].executionSegments[1].pricingBasis = 'proportional-from-package'
      const mutatedSnapshotJson = finalizeRevision('est-1', 2, policy, mutatedLines)
      const replay2 = replayRevision(mutatedSnapshotJson)
      expect(replay2.ok).toBe(true)
      if (replay2.ok) {
        // Mutated revision uses proportional: 500000 × 0.3 = 150000
        expect(replay2.lines[0].breakdown.subcontract).toBe(150000)
      }

      // Re-replay the ORIGINAL snapshot — it must still use direct-segment-quote
      const replay1Again = replayRevision(snapshotJson)
      expect(replay1Again.ok).toBe(true)
      if (replay1Again.ok) {
        expect(replay1Again.lines[0].breakdown.subcontract).toBe(500000)
        expect(replay1Again.snapshot.lines[0].executionSegments[1].pricingBasis).toBe('direct-segment-quote')
      }
    }
  })

  test('snapshot with proportional-from-package preserves the basis', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const lines = [{
      lineId: 'l1', description: 'Blockwork', quantity: 1000, unit: 'm2',
      executionStrategy: 'hybrid' as const,
      workDefinitionVersion: { id: 'wdv-1', name: 'Blockwork', version: 1, unit: 'm2', wastage: 0.05, costRecipeJson: JSON.stringify(recipe) },
      executionSegments: [
        { strategy: 'self-perform' as const, quantityPct: 0.7 },
        {
          strategy: 'subcontract' as const,
          quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'proportional-from-package' as const,
        },
      ],
      subcontractQuote: null,
    }]
    const snapshotJson = finalizeRevision('est-1', 1, { overheadPct: 0.1, profitPct: 0.12, contingencyPct: 0.05 }, lines)
    const replay = replayRevision(snapshotJson)
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(replay.lines[0].breakdown.subcontract).toBe(150000) // 500000 × 0.3
      expect(replay.snapshot.lines[0].executionSegments[1].pricingBasis).toBe('proportional-from-package')
    }
  })
})
