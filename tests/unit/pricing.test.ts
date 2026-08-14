/**
 * Pricing Engine Tests — P0-4, P0-5, P0-6 correctness.
 *
 * Run: bun test tests/unit/pricing.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { priceLine, type PricingInput, type CostRecipeLine } from '../../src/lib/engines/pricing-engine'

const WD = (recipe: CostRecipeLine[], wastage = 0.05) => ({
  id: 'wdv-1',
  name: 'Test WD',
  version: 1,
  unit: 'm2',
  wastage,
  productivityRule: 12,
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

describe('P0-4: missing price → incomplete, NOT zero cost', () => {
  test('a missing price observation makes the calculation incomplete', () => {
    const recipe = [pricedLine({ resourceName: 'Cement', priceObservation: { price: 95, provenance: 'invoice', observedAt: '2025-01-01' } }), pricedLine({ resourceKind: 'labour', resourceName: 'Mason', resourceCode: 'RES-2', priceObservation: null })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.length).toBe(1)
    expect(result.blockingInputs[0].kind).toBe('missing-price')
    expect(result.blockingInputs[0].resourceName).toBe('Mason')
    expect(result.unsourced).toBe(true)
    expect(result.unsourcedResources).toContain('Mason')
  })

  test('all prices present → complete', () => {
    const result = priceLine(baseInput())
    expect(result.calculationStatus).toBe('complete')
    expect(result.blockingInputs.length).toBe(0)
  })

  test('no work definition → incomplete with missing-work-definition', () => {
    const result = priceLine(baseInput({ workDefinitionVersion: null }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs[0].kind).toBe('missing-work-definition')
  })

  test('invalid recipe JSON → incomplete with invalid-recipe', () => {
    const result = priceLine(baseInput({
      workDefinitionVersion: { id: 'wdv-1', name: 'Test', version: 1, unit: 'm2', wastage: 0.05, costRecipeJson: 'not json' },
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs[0].kind).toBe('invalid-recipe')
  })

  test('the sellPrice of an incomplete line is provisional (still computed from available inputs)', () => {
    const recipe = [pricedLine({ priceObservation: { price: 95, provenance: 'invoice', observedAt: '2025-01-01' } }), pricedLine({ resourceKind: 'labour', resourceName: 'Mason', resourceCode: 'RES-2', priceObservation: null })]
    const result = priceLine(baseInput({ workDefinitionVersion: WD(recipe) }))
    // Cement is priced, so there IS a non-zero material cost
    expect(result.material).toBeGreaterThan(0)
    expect(result.labour).toBe(0)
    expect(result.sellPrice).toBeGreaterThan(0)
    // But it must NOT be commit-ready
    expect(result.calculationStatus).toBe('incomplete')
  })
})

describe('P0-5: hybrid requires explicit allocation, NO 50% heuristic', () => {
  test('hybrid without executionSegments → incomplete', () => {
    const result = priceLine(baseInput({ executionStrategy: 'hybrid' }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'missing-hybrid-allocation')).toBe(true)
  })

  test('hybrid with segments summing to != 100% → incomplete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.5 },
        { strategy: 'subcontract', quantityPct: 0.3 },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'missing-hybrid-allocation')).toBe(true)
  })

  test('hybrid with explicit 70/30 allocation → complete, no 50% heuristic', () => {
    const recipe = [
      pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'quote', observedAt: '2025-01-01' } }),
      pricedLine({ resourceKind: 'labour', resourceName: 'Mason', quantityPerUnit: 0.083, priceObservation: { price: 120, provenance: 'policy', observedAt: '2025-01-01' } }),
    ]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 } },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    // Material should be 70% of the full-recipe material (not 50%)
    const fullMaterial = 12.5 * 100 * 1.05 * 6.5 // = 8531.25
    expect(result.material).toBeCloseTo(fullMaterial * 0.7, 1)
    // Subcontract should be 5000 * 0.3 = 1500
    expect(result.subcontract).toBe(1500)
  })

  test('hybrid subcontract segment without quote → incomplete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        { strategy: 'subcontract', quantityPct: 0.3, subcontractQuote: null },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'missing-subcontract-quote')).toBe(true)
  })
})

describe('P0-6: margin semantics', () => {
  test('estimatedTotalCost excludes profit', () => {
    const result = priceLine(baseInput())
    expect(result.estimatedTotalCost).toBe(result.projectCost + result.riskCost + result.overhead)
    expect(result.estimatedTotalCost).not.toBe(result.sellPrice)
  })

  test('expectedProfit = sellPrice - estimatedTotalCost', () => {
    const result = priceLine(baseInput())
    // Allow for round2 (2-decimal) rounding on both sides
    expect(Math.abs(result.expectedProfit - (result.sellPrice - result.estimatedTotalCost))).toBeLessThan(0.02)
  })

  test('expectedMarginPct = expectedProfit / sellPrice', () => {
    const result = priceLine(baseInput())
    // expectedMarginPct is round2'd; compare with tolerance for rounding
    const rawMargin = result.expectedProfit / result.sellPrice
    expect(Math.abs(result.expectedMarginPct - rawMargin)).toBeLessThan(0.005)
  })

  test('expectedMarginPct with 12% profit policy is ~10.7% (not the legacy ~23%)', () => {
    const result = priceLine(baseInput({ profitPct: 0.12 }))
    // expectedMargin = profitPct / (1 + profitPct) = 0.12/1.12 ≈ 0.1071
    // round2 → 0.11, so check within 0.005 tolerance
    const expected = 0.12 / 1.12
    expect(Math.abs(result.expectedMarginPct - expected)).toBeLessThan(0.005)
    // The legacy marginPct (direct-cost spread) should be LARGER (includes overhead+risk in the spread)
    expect(result.marginPct).toBeGreaterThan(result.expectedMarginPct)
  })

  test('subcontract without quote → incomplete', () => {
    const result = priceLine(baseInput({ executionStrategy: 'subcontract', subcontractQuote: null }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'missing-subcontract-quote')).toBe(true)
  })
})
