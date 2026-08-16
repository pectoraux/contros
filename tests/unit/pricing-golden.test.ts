/**
 * Pricing Engine Golden Fixtures + Property Tests
 *
 * Run: bun test tests/unit/pricing-golden.test.ts
 *
 * These tests verify:
 * - Golden fixtures A-H (authoritative pricing scenarios with exact expected output)
 * - Property tests (deterministic invariants that must always hold)
 * - Replay determinism (same inputs → same output)
 * - Margin vs markup semantics
 * - Wastage semantics (material-only)
 * - Fee handling (no silent drop)
 * - Undecided strategy (blocker, not false precision)
 */

import { test, expect, describe } from 'bun:test'
import { priceLine, type PricingInput, type CostRecipeLine } from '../../src/lib/engines/pricing-engine'
import { round2 } from '../../src/lib/engines/money'

// ─── Helpers ────────────────────────────────────────────────────────────────

const WD = (recipe: CostRecipeLine[], wastage = 0.05) => ({
  id: 'wdv-1', name: 'Test WD', version: 1, unit: 'm2', wastage, productivityRule: 12,
  costRecipeJson: JSON.stringify(recipe),
})

const pricedLine = (overrides: Partial<CostRecipeLine> = {}): CostRecipeLine => ({
  resourceKind: 'material',
  resourceCode: 'RES-1',
  resourceName: 'Cement',
  unit: 'ton',
  quantityPerUnit: 0.035,
  priceObservation: { price: 95, provenance: 'supplier-quote', sourceReference: 'Q1', observedAt: '2025-01-01' },
  ...overrides,
})

const baseInput = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  workDefinitionVersion: WD([pricedLine()]),
  quantity: 100,
  executionStrategy: 'self-perform',
  overheadPct: 0.10,
  profitPct: 0.12,
  contingencyPct: 0.05,
  ...overrides,
})

// ─── Golden Fixtures ────────────────────────────────────────────────────────

describe('Golden Fixture A — simple material/labour', () => {
  test('exact expected output for known inputs', () => {
    // quantity=100, material=20/unit (0.1 qpu × 200 price), labour=10/unit (0.05 qpu × 200 price)
    // wastage=5% (material only), overhead=10%, profit=10%, contingency=5%
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 200, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
      { resourceKind: 'labour', resourceCode: 'RES-L', resourceName: 'Labour', unit: 'day', quantityPerUnit: 0.05, priceObservation: { price: 200, provenance: 'policy', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0.05),
      quantity: 100,
      overheadPct: 0.10, profitPct: 0.10, contingencyPct: 0.05,
    }))

    expect(result.calculationStatus).toBe('complete')
    // Material: 0.1 × 100 × 1.05 (wastage) × 200 = 2100
    expect(result.material).toBe(2100)
    // Labour: 0.05 × 100 × 1 (no wastage) × 200 = 1000
    expect(result.labour).toBe(1000)
    expect(result.plant).toBe(0)
    expect(result.subcontract).toBe(0)
    expect(result.fee).toBe(0)
    // directCost = 2100 + 1000 = 3100
    expect(result.directCost).toBe(3100)
    // risk = 3100 × 0.05 = 155
    expect(result.riskCost).toBe(155)
    // overhead = (3100 + 155) × 0.10 = 325.50
    expect(result.overhead).toBe(325.50)
    // estimatedTotalCost = 3100 + 155 + 325.50 = 3580.50
    expect(result.estimatedTotalCost).toBe(3580.50)
    // profit = 3580.50 × 0.10 = 358.05
    expect(result.profit).toBe(358.05)
    // sellPrice = 3580.50 + 358.05 = 3938.55
    expect(result.sellPrice).toBe(3938.55)
    // expectedProfit = sellPrice - estimatedTotalCost = 358.05
    expect(result.expectedProfit).toBe(358.05)
    // expectedMarginPct = 358.05 / 3938.55 = 0.09 → 0.09
    expect(result.expectedMarginPct).toBe(round2(358.05 / 3938.55))
    // unitRate = 3938.55 / 100 = 39.39
    expect(result.unitRate).toBe(39.39)
    // Provenance has 2 entries
    expect(result.provenance.length).toBe(2)
    expect(result.unsourced).toBe(false)
  })
})

describe('Golden Fixture B — subcontract full coverage', () => {
  test('subcontract with 100% coverage → complete, quote replaces recipe costs', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 },
    }))

    expect(result.calculationStatus).toBe('complete')
    expect(result.subcontract).toBe(5000)
    // Recipe costs are zeroed when strategy is 'subcontract'
    expect(result.material).toBe(0)
    expect(result.labour).toBe(0)
    expect(result.plant).toBe(0)
    expect(result.directCost).toBe(5000)
    expect(result.uncoveredSubcontractExposure).toBe(0)
    expect(result.exposureUnknown).toBe(false)
  })
})

describe('Golden Fixture C — partial subcontract coverage → blocker', () => {
  test('coverage < 100% with uncoveredScopeValue → incomplete + exposure', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 3000, coveragePct: 0.4, uncoveredScopeValue: 2000 },
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.uncoveredSubcontractExposure).toBe(2000)
    expect(result.exposureUnknown).toBe(false)
    expect(result.blockingInputs.some(b => b.kind === 'partial-subcontract-coverage')).toBe(true)
  })

  test('coverage < 100% without uncoveredScopeValue → incomplete + unknown exposure', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 3000, coveragePct: 0.4 },
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.exposureUnknown).toBe(true)
    expect(result.blockingInputs.some(b => b.kind === 'uncovered-exposure-unknown')).toBe(true)
  })
})

describe('Golden Fixture D — hybrid 50/50', () => {
  test('50% self + 50% subcontract → complete, no double-count', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 200, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
      { resourceKind: 'labour', resourceCode: 'RES-L', resourceName: 'Labour', unit: 'day', quantityPerUnit: 0.05, priceObservation: { price: 200, provenance: 'policy', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0.05),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.5 },
        { strategy: 'subcontract', quantityPct: 0.5, subcontractQuote: { totalAmount: 2000, coveragePct: 1.0 }, quoteCoversSegmentScope: true, pricingBasis: 'proportional-from-package' },
      ],
    }))

    expect(result.calculationStatus).toBe('complete')
    // Material: 0.1 × 100 × 1.05 × 200 = 2100, × 50% = 1050
    expect(result.material).toBe(1050)
    // Labour: 0.05 × 100 × 1 × 200 = 1000, × 50% = 500
    expect(result.labour).toBe(500)
    // Subcontract: 2000 × 0.5 = 1000
    expect(result.subcontract).toBe(1000)
    // directCost = 1050 + 500 + 1000 = 2550 (no double-count)
    expect(result.directCost).toBe(2550)
  })
})

describe('Golden Fixture E — unsourced resource → blocker', () => {
  test('missing price observation → incomplete + unsourced', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: null },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.unsourced).toBe(true)
    expect(result.unsourcedResources).toContain('Material')
    expect(result.blockingInputs.some(b => b.kind === 'missing-price')).toBe(true)
  })
})

describe('Golden Fixture F — invalid price → blocker', () => {
  test('negative price → incomplete + invalid-price-observation', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: -50, provenance: 'manual', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-price-observation')).toBe(true)
  })

  test('NaN price → incomplete', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: NaN, provenance: 'manual', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-price-observation')).toBe(true)
  })

  test('Infinity price → incomplete', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: Infinity, provenance: 'manual', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-price-observation')).toBe(true)
  })
})

describe('Golden Fixture G — fee is visibly represented', () => {
  test('fee resource contributes to directCost and provenance', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 200, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
      { resourceKind: 'fee', resourceCode: 'RES-F', resourceName: 'Building Permit', unit: 'nr', quantityPerUnit: 0.01, priceObservation: { price: 5000, provenance: 'manual', sourceReference: 'Permit-2025', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0.05),
      quantity: 100,
    }))

    expect(result.calculationStatus).toBe('complete')
    // Material: 0.1 × 100 × 1.05 × 200 = 2100
    expect(result.material).toBe(2100)
    // Fee: 0.01 × 100 × 1 (no wastage) × 5000 = 5000
    expect(result.fee).toBe(5000)
    // directCost includes fee
    expect(result.directCost).toBe(2100 + 5000)
    // Provenance includes the fee
    const feeProv = result.provenance.find(p => p.resourceName === 'Building Permit')
    expect(feeProv).toBeDefined()
    expect(feeProv?.price).toBe(5000)
    expect(feeProv?.provenance).toBe('manual')
  })

  test('fee with no price observation → blocker (not silently dropped)', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'fee', resourceCode: 'RES-F', resourceName: 'Permit', unit: 'nr', quantityPerUnit: 0.01, priceObservation: null },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.unsourced).toBe(true)
    expect(result.unsourcedResources).toContain('Permit')
    expect(result.blockingInputs.some(b => b.kind === 'missing-price')).toBe(true)
  })
})

describe('Golden Fixture H — zero quantity', () => {
  test('zero quantity → deterministic, no NaN/Infinity', () => {
    const result = priceLine(baseInput({ quantity: 0 }))

    expect(result.calculationStatus).toBe('complete')
    expect(result.material).toBe(0)
    expect(result.directCost).toBe(0)
    expect(result.sellPrice).toBe(0)
    expect(result.unitRate).toBe(0) // NOT Infinity or NaN
    expect(result.expectedMarginPct).toBe(0) // NOT NaN
    expect(result.marginPct).toBe(0)
  })
})

// ─── Wastage Semantics ──────────────────────────────────────────────────────

describe('Wastage semantics — material only', () => {
  test('wastage applies to material but NOT to labour', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'ton', quantityPerUnit: 1, priceObservation: { price: 100, provenance: 'quote', observedAt: '2025-01-01' } },
      { resourceKind: 'labour', resourceCode: 'RES-L', resourceName: 'Labour', unit: 'day', quantityPerUnit: 1, priceObservation: { price: 100, provenance: 'policy', observedAt: '2025-01-01' } },
    ]
    // wastage = 10%
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0.10),
      quantity: 10,
    }))

    // Material: 1 × 10 × 1.10 × 100 = 1100 (includes wastage)
    expect(result.material).toBe(1100)
    // Labour: 1 × 10 × 1 × 100 = 1000 (NO wastage)
    expect(result.labour).toBe(1000)
  })

  test('wastage does not apply to plant or fee', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'plant', resourceCode: 'RES-P', resourceName: 'Plant', unit: 'day', quantityPerUnit: 1, priceObservation: { price: 100, provenance: 'quote', observedAt: '2025-01-01' } },
      { resourceKind: 'fee', resourceCode: 'RES-F', resourceName: 'Fee', unit: 'nr', quantityPerUnit: 1, priceObservation: { price: 100, provenance: 'manual', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0.10),
      quantity: 10,
    }))

    // Plant: 1 × 10 × 1 × 100 = 1000 (no wastage)
    expect(result.plant).toBe(1000)
    // Fee: 1 × 10 × 1 × 100 = 1000 (no wastage)
    expect(result.fee).toBe(1000)
  })
})

// ─── Margin vs Markup ───────────────────────────────────────────────────────

describe('Margin vs Markup semantics', () => {
  test('cost=100, profit markup=10% → sell=110, profit=10, margin≈9.09%', () => {
    // Simple recipe: 1 unit material at 100, no wastage, quantity=1
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Material', unit: 'nr', quantityPerUnit: 1, priceObservation: { price: 100, provenance: 'quote', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0), // no wastage
      quantity: 1,
      overheadPct: 0, // no overhead
      profitPct: 0.10, // 10% markup
      contingencyPct: 0, // no contingency
    }))

    // directCost = 100
    expect(result.directCost).toBe(100)
    // estimatedTotalCost = 100 (no risk, no overhead)
    expect(result.estimatedTotalCost).toBe(100)
    // profit = 100 × 0.10 = 10
    expect(result.profit).toBe(10)
    // sellPrice = 100 + 10 = 110
    expect(result.sellPrice).toBe(110)
    // expectedProfit = 110 - 100 = 10
    expect(result.expectedProfit).toBe(10)
    // expectedMarginPct = 10 / 110 = 0.0909... → round2 = 0.09
    expect(result.expectedMarginPct).toBe(0.09)
    // marginPct (spread) = (110 - 100) / 110 = 0.0909... → 0.09
    // (When no overhead/risk, spread margin = true margin)
    expect(result.marginPct).toBe(0.09)
  })

  test('marginPct (spread) > expectedMarginPct (true) when overhead+risk exist', () => {
    const result = priceLine(baseInput({
      overheadPct: 0.10, profitPct: 0.10, contingencyPct: 0.05,
    }))

    // The spread margin includes overhead+risk in the numerator, so it's larger
    expect(result.marginPct).toBeGreaterThan(result.expectedMarginPct)
  })
})

// ─── Undecided Execution Strategy ───────────────────────────────────────────

describe('Undecided execution strategy', () => {
  test('undecided → incomplete with blocker, NOT complete', () => {
    const result = priceLine(baseInput({ executionStrategy: 'undecided' }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'undecided-execution-strategy')).toBe(true)
  })

  test('undecided still computes indicative costs (but blocks commit)', () => {
    const result = priceLine(baseInput({ executionStrategy: 'undecided' }))

    // The price is indicative — costs are still computed
    expect(result.material).toBeGreaterThan(0)
    expect(result.sellPrice).toBeGreaterThan(0)
    // But it cannot be committed
    expect(result.calculationStatus).toBe('incomplete')
  })
})

// ─── Property Tests ─────────────────────────────────────────────────────────

describe('Property tests — deterministic invariants', () => {
  test('same inputs → same output (replay determinism)', () => {
    const input = baseInput()
    const result1 = priceLine(input)
    const result2 = priceLine(input)

    expect(result1).toEqual(result2)
  })

  test('increasing quantity does not reduce direct cost', () => {
    const result1 = priceLine(baseInput({ quantity: 100 }))
    const result2 = priceLine(baseInput({ quantity: 200 }))

    expect(result2.directCost).toBeGreaterThanOrEqual(result1.directCost)
  })

  test('increasing a resource price does not reduce total cost', () => {
    const recipe1: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'M', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 100, provenance: 'q', observedAt: '2025-01-01' } },
    ]
    const recipe2: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'M', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 150, provenance: 'q', observedAt: '2025-01-01' } },
    ]
    const result1 = priceLine(baseInput({ workDefinitionVersion: WD(recipe1) }))
    const result2 = priceLine(baseInput({ workDefinitionVersion: WD(recipe2) }))

    expect(result2.sellPrice).toBeGreaterThanOrEqual(result1.sellPrice)
  })

  test('increasing contingency does not reduce total cost', () => {
    const result1 = priceLine(baseInput({ contingencyPct: 0.05 }))
    const result2 = priceLine(baseInput({ contingencyPct: 0.10 }))

    expect(result2.sellPrice).toBeGreaterThanOrEqual(result1.sellPrice)
  })

  test('increasing overhead does not reduce sell price', () => {
    const result1 = priceLine(baseInput({ overheadPct: 0.10 }))
    const result2 = priceLine(baseInput({ overheadPct: 0.15 }))

    expect(result2.sellPrice).toBeGreaterThanOrEqual(result1.sellPrice)
  })

  test('increasing profit policy does not reduce sell price', () => {
    const result1 = priceLine(baseInput({ profitPct: 0.10 }))
    const result2 = priceLine(baseInput({ profitPct: 0.15 }))

    expect(result2.sellPrice).toBeGreaterThanOrEqual(result1.sellPrice)
  })

  test('100% subcontract coverage leaves no uncovered exposure', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 },
    }))

    expect(result.uncoveredSubcontractExposure).toBe(0)
    expect(result.exposureUnknown).toBe(false)
    expect(result.calculationStatus).toBe('complete')
  })

  test('0% subcontract coverage with quote → blocker (not full coverage)', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 0, coveragePct: 0 },
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.exposureUnknown).toBe(true) // no uncoveredScopeValue
  })

  test('non-negative valid inputs → no negative costs', () => {
    const result = priceLine(baseInput())

    expect(result.material).toBeGreaterThanOrEqual(0)
    expect(result.labour).toBeGreaterThanOrEqual(0)
    expect(result.plant).toBeGreaterThanOrEqual(0)
    expect(result.subcontract).toBeGreaterThanOrEqual(0)
    expect(result.fee).toBeGreaterThanOrEqual(0)
    expect(result.directCost).toBeGreaterThanOrEqual(0)
    expect(result.sellPrice).toBeGreaterThanOrEqual(0)
  })
})

// ─── Hybrid Double-Count Prevention ─────────────────────────────────────────

describe('Hybrid double-count prevention', () => {
  test('10% self + 90% subcontract → correct proportional costs', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'M', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 200, provenance: 'q', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe, 0),
      quantity: 100,
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.1 },
        { strategy: 'subcontract', quantityPct: 0.9, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 }, quoteCoversSegmentScope: true, pricingBasis: 'proportional-from-package' },
      ],
    }))

    // Material: 0.1 × 100 × 1 × 200 = 2000, × 10% = 200
    expect(result.material).toBe(200)
    // Subcontract: 5000 × 0.9 = 4500
    expect(result.subcontract).toBe(4500)
    // directCost = 200 + 4500 = 4700 (no double-count)
    expect(result.directCost).toBe(4700)
  })

  test('segments not summing to 100% → blocker', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.3 },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 }, quoteCoversSegmentScope: true, pricingBasis: 'proportional-from-package' },
      ],
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'missing-hybrid-allocation')).toBe(true)
  })

  test('hybrid missing self-perform segment → blocker', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'subcontract', quantityPct: 1.0, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 }, quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' },
      ],
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'hybrid-missing-strategy')).toBe(true)
  })

  test('hybrid missing subcontract segment → blocker', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 1.0 },
      ],
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'hybrid-missing-strategy')).toBe(true)
  })
})

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('empty recipe → complete with zero costs', () => {
    const result = priceLine(baseInput({
      workDefinitionVersion: WD([]),
    }))

    expect(result.calculationStatus).toBe('complete')
    expect(result.material).toBe(0)
    expect(result.directCost).toBe(0)
    expect(result.sellPrice).toBe(0)
  })

  test('zero overhead, zero profit, zero contingency → sellPrice = directCost', () => {
    const result = priceLine(baseInput({
      overheadPct: 0, profitPct: 0, contingencyPct: 0,
    }))

    expect(result.riskCost).toBe(0)
    expect(result.overhead).toBe(0)
    expect(result.profit).toBe(0)
    expect(result.sellPrice).toBe(result.directCost)
    expect(result.estimatedTotalCost).toBe(result.directCost)
  })

  test('invalid quantity (negative) → blocker', () => {
    const result = priceLine(baseInput({ quantity: -10 }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-quantity')).toBe(true)
  })

  test('invalid quantity (NaN) → blocker', () => {
    const result = priceLine(baseInput({ quantity: NaN }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-quantity')).toBe(true)
  })

  test('invalid percentage (> 1) → blocker', () => {
    const result = priceLine(baseInput({ overheadPct: 4.0 }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-percentage')).toBe(true)
  })

  test('invalid wastage (> 1) → blocker', () => {
    const result = priceLine(baseInput({
      workDefinitionVersion: WD([pricedLine()], 1.5),
    }))

    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some(b => b.kind === 'invalid-wastage')).toBe(true)
  })

  test('provenance has entry for every priced resource', () => {
    const recipe: CostRecipeLine[] = [
      { resourceKind: 'material', resourceCode: 'RES-A', resourceName: 'A', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 100, provenance: 'q', observedAt: '2025-01-01' } },
      { resourceKind: 'labour', resourceCode: 'RES-B', resourceName: 'B', unit: 'day', quantityPerUnit: 0.05, priceObservation: { price: 200, provenance: 'p', observedAt: '2025-01-01' } },
      { resourceKind: 'plant', resourceCode: 'RES-C', resourceName: 'C', unit: 'day', quantityPerUnit: 0.02, priceObservation: { price: 300, provenance: 'q', observedAt: '2025-01-01' } },
      { resourceKind: 'fee', resourceCode: 'RES-D', resourceName: 'D', unit: 'nr', quantityPerUnit: 0.01, priceObservation: { price: 500, provenance: 'm', observedAt: '2025-01-01' } },
    ]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))

    expect(result.provenance.length).toBe(4)
    expect(result.provenance.map(p => p.resourceName).sort()).toEqual(['A', 'B', 'C', 'D'])
  })
})

// ─── Replay Determinism (cross-version) ─────────────────────────────────────

describe('Replay determinism', () => {
  test('calling priceLine twice with identical inputs produces identical output', () => {
    const input: PricingInput = {
      workDefinitionVersion: WD([
        { resourceKind: 'material', resourceCode: 'RES-A', resourceName: 'A', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 100, provenance: 'q', observedAt: '2025-01-01' } },
        { resourceKind: 'labour', resourceCode: 'RES-B', resourceName: 'B', unit: 'day', quantityPerUnit: 0.05, priceObservation: { price: 200, provenance: 'p', observedAt: '2025-01-01' } },
      ], 0.05),
      quantity: 250,
      executionStrategy: 'self-perform',
      overheadPct: 0.10,
      profitPct: 0.12,
      contingencyPct: 0.05,
    }

    const result1 = priceLine(input)
    const result2 = priceLine(input)

    // Deep equality — every field must match
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2))
  })

  test('large quantity → deterministic (no floating-point drift)', () => {
    const result = priceLine(baseInput({ quantity: 1000000 }))

    expect(result.calculationStatus).toBe('complete')
    expect(Number.isFinite(result.sellPrice)).toBe(true)
    expect(Number.isNaN(result.unitRate)).toBe(false)
  })

  test('very small quantity → deterministic (no underflow)', () => {
    const result = priceLine(baseInput({ quantity: 0.001 }))

    expect(result.calculationStatus).toBe('complete')
    expect(Number.isFinite(result.sellPrice)).toBe(true)
  })
})
