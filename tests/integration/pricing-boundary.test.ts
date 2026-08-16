/**
 * PricingEngine service-boundary integration tests.
 *
 * These tests prove that EstimateService.recomputeLine() respects the
 * PricingEngine's completeness status at the persistence boundary:
 *
 *   complete → authoritative financial fields persisted
 *   incomplete → authoritative fields ZEROED (no stale/indicative price)
 *
 * Run: bun test tests/integration/pricing-boundary.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { estimateService } from '../../src/application/estimate-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-pb-org-a'
const USER_A = 'test-pb-user-a'
const CLIENT_A = 'test-pb-client-a'
const OPP_A = 'test-pb-opp-a'
const EST_A = 'test-pb-est-a'
const LINE_A = 'test-pb-line-a'
const WD_A = 'test-pb-wd-a'
const WDV_A = 'test-pb-wdv-a'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  name: 'Test User A', email: 'a@pb-test.com', actorType: 'human',
}

// A valid recipe with all prices sourced
const VALID_RECIPE = JSON.stringify([
  { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Cement', unit: 'ton', quantityPerUnit: 0.035, priceObservation: { price: 95, provenance: 'supplier-quote', sourceReference: 'Q1', observedAt: '2025-01-01' } },
  { resourceKind: 'labour', resourceCode: 'RES-L', resourceName: 'Mason', unit: 'day', quantityPerUnit: 0.5, priceObservation: { price: 120, provenance: 'policy', observedAt: '2025-01-01' } },
])

// A recipe with a missing price observation (unsourced)
const UNSOURCED_RECIPE = JSON.stringify([
  { resourceKind: 'material', resourceCode: 'RES-M', resourceName: 'Cement', unit: 'ton', quantityPerUnit: 0.035, priceObservation: { price: 95, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
  { resourceKind: 'labour', resourceCode: 'RES-L', resourceName: 'Mason', unit: 'day', quantityPerUnit: 0.5, priceObservation: null },
])

describe('PricingEngine service-boundary integration tests', () => {
  beforeAll(async () => {
    // Clean up
    await db.commercialException.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: ORG_A } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG_A } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG_A } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER_A } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG_A } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'PB Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@pb-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'PB Opp', status: 'estimating' } })
    await db.scopePackage.create({ data: { opportunityId: OPP_A, completeness: 0, origin: 'rfq' } })
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-PB', name: 'PB WD', unit: 'm2' } })
    await db.workDefinitionVersion.create({
      data: { id: WDV_A, workDefinitionId: WD_A, version: 1, costRecipeJson: VALID_RECIPE, approvalState: 'approved', wastage: 0.05, hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.estimateLine.create({
      data: {
        id: LINE_A, estimateId: EST_A, workDefinitionId: WD_A, workDefinitionVersionId: WDV_A,
        description: 'PB Test Line', quantity: 100, unit: 'm2',
        executionStrategy: 'self-perform', calculationStatus: 'complete',
      },
    })
  }, 120000)

  afterAll(async () => {
    await db.commercialException.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: ORG_A } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG_A } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG_A } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER_A } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG_A } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  beforeEach(async () => {
    // Reset the WDV + line to a valid state before each test
    await db.workDefinitionVersion.update({
      where: { id: WDV_A },
      data: { costRecipeJson: VALID_RECIPE },
    })
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: {
        executionStrategy: 'self-perform',
        calculationStatus: 'complete',
        sellPrice: 0, unitRate: 0, directCost: 0,
      },
    })
    await db.commercialException.deleteMany({ where: { organizationId: ORG_A, entityType: 'estimate-line' } }).catch(() => {})
  }, 30000)

  // ── Complete calculation → authoritative price persisted ─────────────────

  test('complete calculation → authoritative sellPrice/unitRate persisted', async () => {
    const result = await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.line.calculationStatus).toBe('complete')
    expect(result.line.sellPrice).toBeGreaterThan(0)
    expect(result.line.unitRate).toBeGreaterThan(0)
    expect(result.line.estimatedTotalCost).toBeGreaterThan(0)

    // Verify DB state
    const dbLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(dbLine?.calculationStatus).toBe('complete')
    expect(dbLine?.sellPrice).toBeGreaterThan(0)
    expect(dbLine?.unitRate).toBeGreaterThan(0)
    expect(dbLine?.directCost).toBeGreaterThan(0)
  }, 30000)

  // ── Undecided strategy → incomplete → NO authoritative price ─────────────

  test('undecided strategy → incomplete → sellPrice/unitRate ZEROED in DB', async () => {
    // First compute as self-perform (complete) to establish a non-zero price
    await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
    })
    const beforeLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(beforeLine?.sellPrice).toBeGreaterThan(0) // established a price

    // Now recompute with undecided strategy
    const result = await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
      executionStrategy: 'undecided',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.line.calculationStatus).toBe('incomplete')

    // Verify DB state — authoritative fields are ZEROED
    const dbLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(dbLine?.calculationStatus).toBe('incomplete')
    expect(dbLine?.sellPrice).toBe(0) // NOT the previous price
    expect(dbLine?.unitRate).toBe(0)
    expect(dbLine?.directCost).toBe(0)
    expect(dbLine?.profitCost).toBe(0)
    expect(dbLine?.estimatedTotalCost).toBe(0)
    expect(dbLine?.expectedProfit).toBe(0)
    expect(dbLine?.expectedMarginPct).toBe(0)

    // Diagnostic fields ARE persisted
    expect(dbLine?.blockingInputsJson).toContain('undecided-execution-strategy')

    // CommercialException was created with exposure=0 (not the stale sellPrice)
    const exception = await db.commercialException.findFirst({
      where: { estimateLineId: LINE_A, type: 'incomplete-calculation' },
    })
    expect(exception).not.toBeNull()
    expect(exception?.exposure).toBe(0)
  }, 30000)

  // ── Missing price → incomplete → NO authoritative price ──────────────────

  test('missing price observation → incomplete → sellPrice/unitRate ZEROED in DB', async () => {
    // Switch to a recipe with a missing price
    await db.workDefinitionVersion.update({
      where: { id: WDV_A },
      data: { costRecipeJson: UNSOURCED_RECIPE },
    })

    const result = await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.line.calculationStatus).toBe('incomplete')
    expect(result.line.isUnsourced).toBe(true)

    // Verify DB state — authoritative fields are ZEROED
    const dbLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(dbLine?.sellPrice).toBe(0)
    expect(dbLine?.unitRate).toBe(0)
    expect(dbLine?.directCost).toBe(0)

    // But the breakdown components are persisted as preview (material is priced)
    expect(dbLine?.materialCost).toBeGreaterThan(0)
    // Labour is unsourced → 0
    expect(dbLine?.labourCost).toBe(0)

    // CommercialException created
    const exception = await db.commercialException.findFirst({
      where: { estimateLineId: LINE_A, type: 'incomplete-calculation' },
    })
    expect(exception).not.toBeNull()
    expect(exception?.exposure).toBe(0)
  }, 30000)

  // ── Previously valid price NOT retained after recomputation becomes blocked ──

  test('previously valid price is NOT retained after recomputation becomes blocked', async () => {
    // Step 1: Compute as self-perform (complete) — establishes sellPrice > 0
    await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
    })
    const beforeLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(beforeLine?.sellPrice).toBeGreaterThan(0)
    expect(beforeLine?.calculationStatus).toBe('complete')
    const previousSellPrice = beforeLine!.sellPrice

    // Step 2: Switch to undecided — recomputation becomes blocked
    const result = await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
      executionStrategy: 'undecided',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.line.calculationStatus).toBe('incomplete')

    // Step 3: Verify the previous sellPrice is NOT retained
    const afterLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(afterLine?.sellPrice).toBe(0) // NOT previousSellPrice
    expect(afterLine?.sellPrice).not.toBe(previousSellPrice)
    expect(afterLine?.unitRate).toBe(0)
    expect(afterLine?.directCost).toBe(0)

    // Step 4: Reset the WDV to valid recipe and recompute as self-perform — price is restored
    await db.workDefinitionVersion.update({
      where: { id: WDV_A },
      data: { costRecipeJson: VALID_RECIPE },
    })
    await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
      executionStrategy: 'self-perform', // explicitly reset from undecided
    })
    const restoredLine = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(restoredLine?.calculationStatus).toBe('complete')
    expect(restoredLine?.sellPrice).toBeGreaterThan(0)
    expect(restoredLine?.sellPrice).toBe(previousSellPrice) // same price as before
  }, 30000)

  // ── Audit log does not present indicative price as committed ─────────────

  test('audit log for incomplete calculation does NOT present indicative unitRate as committed', async () => {
    await estimateService.recomputeLine({
      ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A,
      executionStrategy: 'undecided',
    })

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'EstimateLine', entityId: LINE_A },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
    // Summary says "BLOCKED" not "GHS X.XX"
    expect(audit?.summary).toContain('BLOCKED')
    expect(audit?.summary).not.toContain('GHS')

    // afterJson has unitRate=0 (not the indicative value)
    const afterJson = JSON.parse(audit?.afterJson ?? '{}')
    expect(afterJson.unitRate).toBe(0)
    expect(afterJson.sellPrice).toBe(0)
    expect(afterJson.calculationStatus).toBe('incomplete')
  }, 30000)
})
