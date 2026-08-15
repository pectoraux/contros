/**
 * Final mini-pass adversarial tests — Fixes #1, #2, #3, #4.
 *
 * Run: bun test tests/unit/mini-pass.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { priceLine, type PricingInput, type CostRecipeLine } from '../../src/lib/engines/pricing-engine'

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

// ── Fix #1: No subcontract exposure extrapolation ───────────────────────────
describe('Fix #1: subcontract exposure from actual uncovered scope, not extrapolation', () => {
  test('partial quote WITH uncoveredScopeValue → uses actual value, not extrapolation', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 40000, coveragePct: 0.4, uncoveredScopeValue: 60000 },
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.uncoveredSubcontractExposure).toBe(60000)
    expect(result.exposureUnknown).toBe(false)
    expect(result.blockingInputs.some((b) => b.kind === 'partial-subcontract-coverage')).toBe(true)
    // The detail message references the actual value, not extrapolated
    const blocker = result.blockingInputs.find((b) => b.kind === 'partial-subcontract-coverage')!
    expect(blocker.detail).toContain('GHS 60000.00')
  })

  test('partial quote WITHOUT uncoveredScopeValue → exposure unknown, NOT extrapolated', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 40000, coveragePct: 0.4 },
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.exposureUnknown).toBe(true)
    expect(result.uncoveredSubcontractExposure).toBe(0)
    expect(result.blockingInputs.some((b) => b.kind === 'uncovered-exposure-unknown')).toBe(true)
    // The old extrapolation (40000/0.4 * 0.6 = 60000) must NOT appear
    expect(result.uncoveredSubcontractExposure).not.toBe(60000)
  })

  test('full coverage quote → no exposure, complete', () => {
    const result = priceLine(baseInput({
      executionStrategy: 'subcontract',
      subcontractQuote: { totalAmount: 100000, coveragePct: 1.0 },
    }))
    expect(result.calculationStatus).toBe('complete')
    expect(result.uncoveredSubcontractExposure).toBe(0)
    expect(result.exposureUnknown).toBe(false)
  })

  test('hybrid segment partial quote WITH uncoveredScopeValue → uses actual value', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7, scopeDefinition: 'External walls' },
        {
          strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'Specialist level 3',
          subcontractQuote: { totalAmount: 10000, coveragePct: 0.5, uncoveredScopeValue: 8000 },
          quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' as const,
        },
      ],
    }))
    expect(result.uncoveredSubcontractExposure).toBe(8000)
    expect(result.exposureUnknown).toBe(false)
  })

  test('hybrid segment partial quote WITHOUT uncoveredScopeValue → unknown', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3,
          subcontractQuote: { totalAmount: 10000, coveragePct: 0.5 },
          quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' as const,
        },
      ],
    }))
    expect(result.exposureUnknown).toBe(true)
    // Old extrapolation: 10000/0.5 * 0.5 * 0.3 = 3000 — must NOT appear
    expect(result.uncoveredSubcontractExposure).toBe(0)
  })
})

// ── Fix #2: Segment scope must be verified against quote ────────────────────
describe('Fix #2: subcontract segment scope verification', () => {
  test('hybrid segment without quoteCoversSegmentScope → blocker', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'Specialist blockwork',
          subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 },
          // quoteCoversSegmentScope omitted → should be a blocker
        },
      ],
    }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'segment-scope-not-covered')).toBe(true)
    const blocker = result.blockingInputs.find((b) => b.kind === 'segment-scope-not-covered')!
    expect(blocker.detail).toContain('Specialist blockwork')
  })

  test('hybrid segment with quoteCoversSegmentScope=true → no scope blocker', () => {
    const recipe = [pricedLine({ resourceKind: 'material', resourceName: 'Blocks', quantityPerUnit: 12.5, priceObservation: { price: 6.5, provenance: 'q', observedAt: '2025-01-01' } })]
    const result = priceLine(baseInput({
      workDefinitionVersion: WD(recipe),
      executionStrategy: 'hybrid',
      executionSegments: [
        { strategy: 'self-perform', quantityPct: 0.7 },
        {
          strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'Specialist blockwork',
          subcontractQuote: { totalAmount: 5000, coveragePct: 1.0 },
          quoteCoversSegmentScope: true, pricingBasis: 'direct-segment-quote' as const,
        },
      ],
    }))
    expect(result.calculationStatus).toBe('complete')
    expect(result.blockingInputs.some((b) => b.kind === 'segment-scope-not-covered')).toBe(false)
  })
})

// ── Fix #3: Fail closed on invalid roles ────────────────────────────────────
describe('Fix #3: fail closed on invalid roles', () => {
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
    expect(isValidRole('ESTIMATOR')).toBe(false)
    expect(isValidRole('root')).toBe(false)
  })

  test('auth.ts authorize returns null for invalid role (fail closed)', async () => {
    // We can't easily call authorize directly without a DB, but we can verify
    // the logic: if isValidRole returns false, the function returns null.
    // This is verified by reading the source — the code explicitly checks
    // `if (!isValidRole(user.role)) { return null }` before returning a user.
    const authSource = await Bun.file('src/lib/auth.ts').text()
    expect(authSource).toContain("if (!isValidRole(user.role))")
    expect(authSource).toContain('return null')
    // Verify the old normalization pattern is GONE
    expect(authSource).not.toContain("? user.role : 'estimator'")
  })

  test('context.ts requireAuth throws 403 for invalid role', async () => {
    // Verify the source contains the fail-closed check
    const ctxSource = await Bun.file('src/lib/context.ts').text()
    expect(ctxSource).toContain("if (!isValidRole(u.role))")
    expect(ctxSource).toContain('status: 403')
    // Verify the old normalization is GONE
    expect(ctxSource).not.toContain("? u.role : 'estimator'")
  })
})

// ── Fix #4: Commercial percentages bounded to 0..1 ──────────────────────────
describe('Fix #4: commercial percentages bounded to 0..1', () => {
  test('overheadPct > 1 (e.g. 4.0 = 400%) → blocker', () => {
    const result = priceLine(baseInput({ overheadPct: 4.0 }))
    expect(result.calculationStatus).toBe('incomplete')
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage' && b.detail.includes('Overhead'))).toBe(true)
  })

  test('profitPct > 1 → blocker', () => {
    const result = priceLine(baseInput({ profitPct: 1.5 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage' && b.detail.includes('Profit'))).toBe(true)
  })

  test('contingencyPct > 1 → blocker', () => {
    const result = priceLine(baseInput({ contingencyPct: 2.0 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage' && b.detail.includes('Contingency'))).toBe(true)
  })

  test('negative overheadPct → blocker', () => {
    const result = priceLine(baseInput({ overheadPct: -0.1 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(true)
  })

  test('overheadPct = 0 → valid (zero overhead allowed)', () => {
    const result = priceLine(baseInput({ overheadPct: 0 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(false)
  })

  test('overheadPct = 1 (100%) → valid (edge case)', () => {
    const result = priceLine(baseInput({ overheadPct: 1.0, profitPct: 0, contingencyPct: 0 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(false)
  })

  test('overheadPct = 1.01 → blocker (just over edge)', () => {
    const result = priceLine(baseInput({ overheadPct: 1.01 }))
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(true)
  })

  test('all percentages at typical values → complete', () => {
    const result = priceLine(baseInput({ overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05 }))
    expect(result.calculationStatus).toBe('complete')
    expect(result.blockingInputs.some((b) => b.kind === 'invalid-percentage')).toBe(false)
  })
})
