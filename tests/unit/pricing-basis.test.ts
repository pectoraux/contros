/**
 * Pricing basis adversarial tests.
 *
 * Run: bun test tests/unit/pricing-basis.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { priceLine, type PricingInput, type CostRecipeLine } from '../../src/lib/engines/pricing-engine'

const WD = (recipe: CostRecipeLine[], wastage = 0.05) => ({
  id: 'wdv-1', name: 'Test WD', version: 1, unit: 'm2', wastage, productivityRule: 12,
  costRecipeJson: JSON.stringify(recipe),
})

const pricedLine = (overrides: Partial<CostRecipeLine> = {}): CostRecipeLine => ({
  resourceKind: 'material', resourceCode: 'RES-1', resourceName: 'Blocks', unit: 'no',
  quantityPerUnit: 12.5,
  priceObservation: { price: 6.5, provenance: 'supplier-quote', observedAt: '2025-01-01' },
  ...overrides,
})

const baseInput = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  workDefinitionVersion: WD([pricedLine()]),
  quantity: 1000, executionStrategy: 'self-perform',
  overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
  ...overrides,
})

describe('Pricing basis: hybrid subcontract cost calculation', () => {
  test('missing pricingBasis → blocker', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          // pricingBasis omitted
        },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'missing-pricing-basis')).toBe(true)
  })

  test('direct-segment-quote: uses full quote amount, NOT multiplied by pct', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'direct-segment-quote',
        },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    // Subcontract cost should be the FULL 500000, not 500000 × 0.3 = 150000
    expect(result.subcontract).toBe(500000)
    expect(result.subcontract).not.toBe(150000)
  })

  test('proportional-from-package: multiplies quote by quantityPct', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'proportional-from-package',
        },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    // Subcontract cost should be 500000 × 0.3 = 150000
    expect(result.subcontract).toBe(150000)
  })

  test('direct vs proportional produce different costs for the same quote', () => {
    const direct = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'direct-segment-quote',
        },
      ],
    }))
    const proportional = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 500000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'proportional-from-package',
        },
      ],
    }))
    expect(direct.subcontract).toBe(500000)
    expect(proportional.subcontract).toBe(150000)
    expect(direct.subcontract).not.toBe(proportional.subcontract)
    // The sell prices must also differ
    expect(direct.sellPrice).toBeGreaterThan(proportional.sellPrice)
  })

  test('multiple subcontract segments with mixed bases', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.4 },
        {
          strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'West wing',
          subcontractQuote: { totalAmount: 200000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'direct-segment-quote',
        },
        {
          strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'East wing (proportional)',
          subcontractQuote: { totalAmount: 300000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true,
          pricingBasis: 'proportional-from-package',
        },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    // 200000 (direct) + 300000 × 0.3 (proportional) = 200000 + 90000 = 290000
    expect(result.subcontract).toBe(290000)
  })
})
