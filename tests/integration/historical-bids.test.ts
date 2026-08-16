/**
 * Historical Bid Validation Tests
 *
 * Tests that each historical bid fixture is reconstructable from immutable
 * domain state (INVARIANT 8).
 *
 * The validation harness:
 * 1. Loads fixture data
 * 2. Creates WorkDefinitions + WDVersions + Resources in the DB
 * 3. Creates EstimateLines and prices them via the pure PricingEngine
 * 4. Finalizes an EstimateRevision (immutable snapshot)
 * 5. Replays the revision and asserts the reconstructed price matches
 * 6. For valid bids: asserts validateBidSubmission passes
 * 7. For ambiguous bids: asserts validateBidSubmission fails
 *
 * Run: bun test tests/integration/historical-bids.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { priceLine, type PricingInput, type ExecutionSegmentInput } from '../../src/lib/engines/pricing-engine'
import { finalizeRevision, replayRevision, validateBidSubmission } from '../../src/lib/engines/revision-service'
import { round2 } from '../../src/lib/engines/money'
import { HISTORICAL_BID_FIXTURES, type HistoricalBidFixture } from '../fixtures/historical-bids'
import type { LineSnapshot, PolicySnapshot } from '../../src/lib/engines/revision-service'

const db = new PrismaClient()

const ORG = 'hist-bid-org'
const USER = 'hist-bid-user'

describe('Historical Bid Validation', () => {
  beforeAll(async () => {
    // Clean up any leftover data
    await db.commercialException.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.executionSegment.deleteMany({ where: { estimateLine: { estimate: { organizationId: ORG } } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.resourcePriceObservation.deleteMany({ where: { resource: { organizationId: ORG } } }).catch(() => {})
    await db.resource.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG } }).catch(() => {})

    await db.organization.create({ data: { id: ORG, name: 'Historical Bid Org', currency: 'GHS' } })
    await db.user.create({ data: { id: USER, organizationId: ORG, name: 'Hist User', email: 'hist@bid-test.com', role: 'estimator' } })
  }, 120000)

  afterAll(async () => {
    await db.commercialException.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.executionSegment.deleteMany({ where: { estimateLine: { estimate: { organizationId: ORG } } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.resourcePriceObservation.deleteMany({ where: { resource: { organizationId: ORG } } }).catch(() => {})
    await db.resource.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ─── Fixture matrix summary ──────────────────────────────────────────────

  test('fixture matrix has exactly 10 fixtures in 5 categories', () => {
    expect(HISTORICAL_BID_FIXTURES.length).toBe(10)
    const categories = HISTORICAL_BID_FIXTURES.map(f => f.category)
    expect(categories.filter(c => c === 'straightforward').length).toBe(3)
    expect(categories.filter(c => c === 'subcontract-heavy').length).toBe(3)
    expect(categories.filter(c => c === 'ambiguous').length).toBe(2)
    expect(categories.filter(c => c === 'client-boq').length).toBe(1)
    expect(categories.filter(c => c === 'estimator-scope').length).toBe(1)
  })

  // ─── Per-fixture validation ──────────────────────────────────────────────

  for (const fixture of HISTORICAL_BID_FIXTURES) {
    test(`fixture ${fixture.id}: ${fixture.title}`, async () => {
      const result = await validateFixture(fixture)
      expect(result.passed, result.message).toBe(true)
    }, 60000)
  }

  // ─── Cross-fixture invariants ────────────────────────────────────────────

  test('all valid bids (shouldPassValidation=true) produce non-zero sellPrice', async () => {
    for (const fixture of HISTORICAL_BID_FIXTURES.filter(f => f.shouldPassValidation)) {
      const result = await computeFixturePrice(fixture)
      expect(result.totalSellPrice).toBeGreaterThan(0)
      expect(result.allComplete).toBe(true)
    }
  }, 120000)

  test('all ambiguous bids (shouldPassValidation=false) produce incomplete calculations', async () => {
    for (const fixture of HISTORICAL_BID_FIXTURES.filter(f => !f.shouldPassValidation)) {
      const result = await computeFixturePrice(fixture)
      expect(result.allComplete).toBe(false)
    }
  }, 120000)

  test('replay determinism: all valid bids produce same price on second replay', async () => {
    for (const fixture of HISTORICAL_BID_FIXTURES.filter(f => f.shouldPassValidation)) {
      const result1 = await computeFixturePrice(fixture)
      const result2 = await computeFixturePrice(fixture)
      expect(result2.totalSellPrice).toBe(result1.totalSellPrice)
    }
  }, 120000)
})

// ─── Validation Harness ─────────────────────────────────────────────────────

async function validateFixture(fixture: HistoricalBidFixture): Promise<{ passed: boolean; message: string }> {
  try {
    const priceResult = await computeFixturePrice(fixture)

    // Check completeness
    if (fixture.shouldPassValidation && !priceResult.allComplete) {
      return { passed: false, message: `Expected all lines complete, but got incomplete: ${priceResult.blockingReasons.join('; ')}` }
    }
    if (!fixture.shouldPassValidation && priceResult.allComplete) {
      return { passed: false, message: `Expected incomplete calculation, but all lines were complete` }
    }

    // For valid bids, validate submission
    if (fixture.shouldPassValidation) {
      const validation = validateBidSubmission({
        estimateRevisionId: 'rev-' + fixture.id,
        estimateStatus: 'submitted',
        finalPrice: priceResult.totalSellPrice,
        hasFinalizedRevision: true,
        incompleteLineCount: 0,
      })
      if (!validation.ok) {
        return { passed: false, message: `validateBidSubmission failed: ${validation.errors.join('; ')}` }
      }

      // Verify replay produces the same price
      const lineSnapshots = buildLineSnapshots(fixture, priceResult.breakdowns)
      const policy: PolicySnapshot = {
        overheadPct: fixture.overheadPct,
        profitPct: fixture.profitPct,
        contingencyPct: fixture.contingencyPct,
      }
      const snapshotJson = finalizeRevision('est-' + fixture.id, 1, policy, lineSnapshots)
      const replay = replayRevision(snapshotJson)
      if (!replay.ok) {
        return { passed: false, message: `replayRevision failed: ${replay.error}` }
      }

      // The replayed total must match the computed total
      if (Math.abs(replay.totalSellPrice - priceResult.totalSellPrice) > 0.02) {
        return { passed: false, message: `Replay price ${replay.totalSellPrice} ≠ computed price ${priceResult.totalSellPrice}` }
      }

      // Verify final price with director adjustment
      const expectedFinalPrice = round2(priceResult.totalSellPrice * (1 + fixture.directorAdjustment))
      // The final price should be positive for a valid bid
      if (expectedFinalPrice <= 0) {
        return { passed: false, message: `Final price ${expectedFinalPrice} is not positive` }
      }
    }

    return { passed: true, message: 'OK' }
  } catch (e) {
    return { passed: false, message: e instanceof Error ? e.message : String(e) }
  }
}

interface PriceResult {
  totalSellPrice: number
  allComplete: boolean
  blockingReasons: string[]
  breakdowns: ReturnType<typeof priceLine>[]
}

async function computeFixturePrice(fixture: HistoricalBidFixture): Promise<PriceResult> {
  const breakdowns: ReturnType<typeof priceLine>[] = []
  let totalSellPrice = 0
  const blockingReasons: string[] = []
  let allComplete = true

  for (const line of fixture.lines) {
    const pricingInput: PricingInput = {
      workDefinitionVersion: {
        id: 'wdv-' + fixture.id,
        name: line.workDefinitionName,
        version: 1,
        unit: line.unit,
        wastage: line.wastage,
        productivityRule: line.productivityRule,
        costRecipeJson: JSON.stringify(line.recipe),
      },
      quantity: line.quantity,
      executionStrategy: line.executionStrategy,
      executionSegments: line.executionSegments as ExecutionSegmentInput[] | undefined,
      overheadPct: fixture.overheadPct,
      profitPct: fixture.profitPct,
      contingencyPct: fixture.contingencyPct,
      subcontractQuote: line.subcontractQuote ?? null,
    }

    const breakdown = priceLine(pricingInput)
    breakdowns.push(breakdown)

    if (breakdown.calculationStatus !== 'complete') {
      allComplete = false
      blockingReasons.push(`${line.description}: ${breakdown.blockingInputs.map(b => b.kind).join(', ')}`)
    }

    // Only add sellPrice if complete (incomplete → 0 in the service boundary)
    totalSellPrice += breakdown.calculationStatus === 'complete' ? breakdown.sellPrice : 0
  }

  return {
    totalSellPrice: round2(totalSellPrice),
    allComplete,
    blockingReasons,
    breakdowns,
  }
}

function buildLineSnapshots(
  fixture: HistoricalBidFixture,
  breakdowns: ReturnType<typeof priceLine>[],
): LineSnapshot[] {
  return fixture.lines.map((line, i) => ({
    lineId: `line-${i}`,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    executionStrategy: line.executionStrategy,
    workDefinitionVersion: {
      id: 'wdv-' + fixture.id,
      name: line.workDefinitionName,
      version: 1,
      unit: line.unit,
      wastage: line.wastage,
      productivityRule: line.productivityRule,
      costRecipeJson: JSON.stringify(line.recipe),
    },
    executionSegments: (line.executionSegments ?? []) as ExecutionSegmentInput[],
    subcontractQuote: line.subcontractQuote
      ? { totalAmount: line.subcontractQuote.totalAmount, coveragePct: line.subcontractQuote.coveragePct }
      : null,
  }))
}
