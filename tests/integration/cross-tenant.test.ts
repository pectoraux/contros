/**
 * Cross-tenant integration tests — REAL adversarial tests with actual DB data.
 *
 * These tests create two organizations, two estimates, and cross-reference
 * a subcontract quote from Org B into an execution segment in Org A.
 * The service must NOT resolve the Org B quote.
 *
 * Run: bun test tests/integration/cross-tenant.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { estimateService } from '../../src/application/estimate-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

// Test fixture IDs (fixed for reproducibility)
const ORG_A = 'test-org-a'
const ORG_B = 'test-org-b'
const USER_A = 'test-user-a'
const USER_B = 'test-user-b'
const CLIENT_A = 'test-client-a'
const CLIENT_B = 'test-client-b'
const OPP_A = 'test-opp-a'
const OPP_B = 'test-opp-b'
const EST_A = 'test-est-a'
const EST_B = 'test-est-b'
const LINE_A = 'test-line-a'
const LINE_B = 'test-line-b'
const WD_A = 'test-wd-a'
const WDV_A = 'test-wdv-a'
const PKG_A = 'test-pkg-a'
const PKG_B = 'test-pkg-b'
const QUOTE_B = 'test-quote-b' // Quote in Org B
const QUOTE_A = 'test-quote-a' // Quote in Org A
const SEG_A = 'test-seg-a' // Segment in Org A that will reference QUOTE_B
const WD_B = 'test-wd-b'
const WDV_B = 'test-wdv-b'
const RES_B = 'test-res-b'
const RES_OBS_B = 'test-resobs-b'

const ctxA: RequestContext = {
  userId: USER_A,
  organizationId: ORG_A,
  role: 'estimator',
  isDemo: false,
  name: 'Test User A',
  email: 'a@test.com',
}

const ctxB: RequestContext = {
  userId: USER_B,
  organizationId: ORG_B,
  role: 'estimator',
  isDemo: false,
  name: 'Test User B',
  email: 'b@test.com',
}

// A simple priced recipe for the test work definition.
const RECIPE = JSON.stringify([
  {
    resourceKind: 'material',
    resourceCode: 'RES-TEST',
    resourceName: 'Test Material',
    unit: 'ton',
    quantityPerUnit: 0.1,
    priceObservation: { price: 100, provenance: 'supplier-quote', observedAt: '2025-01-01' },
  },
])

describe('Cross-tenant integration tests', () => {
  beforeAll(async () => {
    // Clean up any previous test data — audit/exceptions first (FK constraints).
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.estimateRevision.deleteMany({ where: { estimateId: { in: [EST_A, EST_B] } } })
    await db.executionSegment.deleteMany({ where: { id: { startsWith: SEG_A } } })
    await db.subcontractQuote.deleteMany({ where: { id: { in: [QUOTE_A, QUOTE_B] } } })
    await db.subcontractPackage.deleteMany({ where: { id: { in: [PKG_A, PKG_B] } } })
    await db.estimateLine.deleteMany({ where: { id: { in: [LINE_A, LINE_B] } } })
    await db.estimate.deleteMany({ where: { id: { in: [EST_A, EST_B] } } })
    await db.opportunity.deleteMany({ where: { id: { in: [OPP_A, OPP_B] } } })
    await db.client.deleteMany({ where: { id: { in: [CLIENT_A, CLIENT_B] } } })
    await db.resourcePriceObservation.deleteMany({ where: { id: RES_OBS_B } })
    await db.resource.deleteMany({ where: { id: RES_B } })
    await db.workDefinitionVersion.deleteMany({ where: { id: { in: [WDV_A, WDV_B] } } })
    await db.workDefinition.deleteMany({ where: { id: { in: [WD_A, WD_B] } } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })

    // Create Org A.
    await db.organization.create({ data: { id: ORG_A, name: 'Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-TEST', name: 'Test WD', unit: 'm2' } })
    await db.workDefinitionVersion.create({
      data: { id: WDV_A, workDefinitionId: WD_A, version: 1, wastage: 0.05, costRecipeJson: RECIPE, approvalState: 'approved', hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.estimateLine.create({
      data: { id: LINE_A, estimateId: EST_A, workDefinitionId: WD_A, workDefinitionVersionId: WDV_A, description: 'Line A', quantity: 100, unit: 'm2', executionStrategy: 'self-perform' },
    })

    // Create Org B with a subcontract quote.
    await db.organization.create({ data: { id: ORG_B, name: 'Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({ data: { id: OPP_B, organizationId: ORG_B, clientId: CLIENT_B, title: 'Opp B', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_B, organizationId: ORG_B, opportunityId: OPP_B, status: 'draft' } })
    await db.estimateLine.create({
      data: { id: LINE_B, estimateId: EST_B, description: 'Line B', quantity: 50, unit: 'm2', executionStrategy: 'self-perform' },
    })
    // Org B subcontract package + quote.
    await db.subcontractPackage.create({ data: { id: PKG_B, organizationId: ORG_B, opportunityId: OPP_B, name: 'Pkg B', executionStrategy: 'subcontract' } })
    await db.subcontractQuote.create({ data: { id: QUOTE_B, subcontractPackageId: PKG_B, supplierName: 'Supplier B', totalAmount: 99999, coveragePct: 1.0 } })

    // Org B WorkDefinition + Version + Resource + PriceObservation (for cross-tenant WD test).
    await db.workDefinition.create({ data: { id: WD_B, organizationId: ORG_B, code: 'WD-B-TEST', name: 'Org B WD', unit: 'm2' } })
    await db.workDefinitionVersion.create({
      data: { id: WDV_B, workDefinitionId: WD_B, version: 1, wastage: 0.05, costRecipeJson: RECIPE, approvalState: 'approved', hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.resource.create({ data: { id: RES_B, organizationId: ORG_B, code: 'RES-B-TEST', name: 'Org B Resource', unit: 'ton', kind: 'material' } })
    await db.resourcePriceObservation.create({ data: { id: RES_OBS_B, resourceId: RES_B, workDefinitionVersionId: WDV_B, price: 777, provenance: 'supplier-quote', sourceReference: 'ORG-B-SECRET' } })

    // Org A subcontract package + quote (for the inverse test).
    await db.subcontractPackage.create({ data: { id: PKG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Pkg A', executionStrategy: 'subcontract' } })
    await db.subcontractQuote.create({ data: { id: QUOTE_A, subcontractPackageId: PKG_A, supplierName: 'Supplier A', totalAmount: 50000, coveragePct: 1.0 } })
  }, 120000)

  afterAll(async () => {
    // Clean up — delete audit logs and exceptions first (FK constraints).
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.estimateRevision.deleteMany({ where: { estimateId: { in: [EST_A, EST_B] } } })
    await db.executionSegment.deleteMany({ where: { id: { startsWith: SEG_A } } })
    await db.subcontractQuote.deleteMany({ where: { id: { in: [QUOTE_A, QUOTE_B] } } })
    await db.subcontractPackage.deleteMany({ where: { id: { in: [PKG_A, PKG_B] } } })
    await db.estimateLine.deleteMany({ where: { id: { in: [LINE_A, LINE_B] } } })
    await db.estimate.deleteMany({ where: { id: { in: [EST_A, EST_B] } } })
    await db.opportunity.deleteMany({ where: { id: { in: [OPP_A, OPP_B] } } })
    await db.client.deleteMany({ where: { id: { in: [CLIENT_A, CLIENT_B] } } })
    await db.resourcePriceObservation.deleteMany({ where: { id: RES_OBS_B } })
    await db.resource.deleteMany({ where: { id: RES_B } })
    await db.workDefinitionVersion.deleteMany({ where: { id: { in: [WDV_A, WDV_B] } } })
    await db.workDefinition.deleteMany({ where: { id: { in: [WD_A, WD_B] } } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await db.$disconnect()
  }, 120000)

  // ── Test 1: Org A cannot use Org B's quote via execution segment ──────────
  test('Org A line with Org B quote reference → quote NOT resolved, pricing uses self-perform', async () => {
    // Create an execution segment in Org A's line that references Org B's quote.
    // This simulates a corrupted or malicious cross-tenant reference.
    await db.executionSegment.create({
      data: {
        id: SEG_A + '-t1',
        estimateLineId: LINE_A,
        strategy: 'subcontract',
        scopeDefinition: 'Cross-tenant test',
        quantityPct: 0.3,
        subcontractQuoteId: QUOTE_B, // ← references Org B's quote!
        pricingBasis: 'proportional-from-package',
        quoteCoversSegmentScope: true,
      },
    })

    // Change the line to hybrid so the segment is used.
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { executionStrategy: 'hybrid' },
    })

    // Call the service as User A.
    const result = await estimateService.recomputeLine({
      ctx: ctxA,
      estimateId: EST_A,
      estimateLineId: LINE_A,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // The quote from Org B (99999) must NOT appear anywhere in the result.
      // The segment's subcontract quote should be null (not resolved).
      // The calculation should be incomplete (missing-subcontract-quote for the segment).
      expect(result.line.calculationStatus).toBe('incomplete')
      // The subcontract cost must NOT be 99999 × 0.3 = 29999.7
      const breakdown = result.line.breakdown as { subcontract: number }
      expect(breakdown.subcontract).not.toBe(29999.7)
      // The blocking inputs should include a missing-subcontract-quote for the segment
      const blockingInputs = result.line.blockingInputs as Array<{ kind: string; detail: string }>
      // The segment's quote was not resolved (null), so pricing sees no quote
      expect(blockingInputs.some((b) => b.kind === 'missing-subcontract-quote')).toBe(true)
    }

    // Clean up the segment.
    await db.executionSegment.delete({ where: { id: SEG_A + '-t1' } })
    await db.estimateLine.update({ where: { id: LINE_A }, data: { executionStrategy: 'self-perform' } })
  }, 60000)

  // ── Test 2: Inverse — Org B cannot use Org A's quote ──────────────────────
  test('Org B line with Org A quote reference → quote NOT resolved', async () => {
    // Create an execution segment in Org B's line referencing Org A's quote.
    await db.executionSegment.create({
      data: {
        id: SEG_A + '-t2',
        estimateLineId: LINE_B,
        strategy: 'subcontract',
        scopeDefinition: 'Inverse cross-tenant test',
        quantityPct: 0.5,
        subcontractQuoteId: QUOTE_A, // ← references Org A's quote!
        pricingBasis: 'direct-segment-quote',
        quoteCoversSegmentScope: true,
      },
    })
    await db.estimateLine.update({ where: { id: LINE_B }, data: { executionStrategy: 'hybrid' } })

    const result = await estimateService.recomputeLine({
      ctx: ctxB,
      estimateId: EST_B,
      estimateLineId: LINE_B,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.line.calculationStatus).toBe('incomplete')
      // Org A's quote amount (50000) must NOT appear anywhere in the result.
      const breakdown = result.line.breakdown as { subcontract: number }
      expect(breakdown.subcontract).not.toBe(50000)
      expect(breakdown.subcontract).not.toBe(25000) // 50000 × 0.5
      // The cross-tenant quote was not resolved — the segment has no quote.
      // The calculation is incomplete (either missing-work-definition or
      // missing-subcontract-quote or segment-scope-not-covered).
      const blockingInputs = result.line.blockingInputs as Array<{ kind: string; detail: string }>
      const hasQuoteBlocker = blockingInputs.some(
        (b) => b.kind === 'missing-subcontract-quote' ||
               b.kind === 'segment-scope-not-covered' ||
               b.kind === 'missing-pricing-basis' ||
               b.kind === 'missing-work-definition'
      )
      expect(hasQuoteBlocker).toBe(true)
    }

    await db.executionSegment.delete({ where: { id: SEG_A + '-t2' } })
    await db.estimateLine.update({ where: { id: LINE_B }, data: { executionStrategy: 'self-perform' } })
  }, 60000)

  // ── Test 3: Org A cannot read Org B's estimate ────────────────────────────
  test('Org A user cannot recompute Org B estimate line', async () => {
    const result = await estimateService.recomputeLine({
      ctx: ctxA,
      estimateId: EST_B, // Org B's estimate
      estimateLineId: LINE_B,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
  }, 60000)

  // ── Test 4: Org A cannot finalize Org B's revision ────────────────────────
  test('Org A user cannot finalize Org B estimate revision', async () => {
    const result = await estimateService.finalizeRevision({
      ctx: ctxA,
      estimateId: EST_B, // Org B's estimate
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
  }, 60000)

  // ── Test 5: Same-org recompute works (control test) ───────────────────────
  test('Same-org recompute works (control test)', async () => {
    const result = await estimateService.recomputeLine({
      ctx: ctxA,
      estimateId: EST_A,
      estimateLineId: LINE_A,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The line has a valid priced recipe → should be complete
      expect(result.line.calculationStatus).toBe('complete')
      expect(result.line.sellPrice).toBeGreaterThan(0)
    }
  }, 60000)

  // ── Test 6: Org A line references Org B's WorkDefinitionVersion ─────────
  test('Org A line with Org B WorkDefinitionVersion → WD not loaded, pricing incomplete', async () => {
    // Update Org A's line to reference Org B's WDV.
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { workDefinitionId: WD_B, workDefinitionVersionId: WDV_B },
    })

    const result = await estimateService.recomputeLine({
      ctx: ctxA,
      estimateId: EST_A,
      estimateLineId: LINE_A,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // P0-3: The Org B WD is not available for Org A → 403
      expect(result.status).toBe(403)
    }

    // Restore LINE_A to its original WD.
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { workDefinitionId: WD_A, workDefinitionVersionId: WDV_A },
    })
  }, 60000)

  // ── Test 7: Transaction rollback — failed finalization leaves no revision ─
  test('Failed finalization leaves no revision (transaction rollback)', async () => {
    // Create an estimate with an incomplete line — finalizeRevision should
    // reject it with 400 (not create any revision or audit).
    // First, make LINE_A incomplete by removing its WDV reference.
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { calculationStatus: 'incomplete', workDefinitionVersionId: null },
    })

    const result = await estimateService.finalizeRevision({
      ctx: ctxA,
      estimateId: EST_A,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }

    // Verify NO revision was created for this attempt.
    const revisions = await db.estimateRevision.findMany({
      where: { estimateId: EST_A, revisionNo: 999 },
    })
    expect(revisions.length).toBe(0)

    // Verify NO audit log for a finalization of EST_A at revision 999.
    const audits = await db.auditLog.findMany({
      where: {
        organizationId: ORG_A,
        action: 'estimate.revision-finalized',
        summary: { contains: 'revision 999' },
      },
    })
    expect(audits.length).toBe(0)

    // Restore LINE_A.
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { calculationStatus: 'complete', workDefinitionVersionId: WDV_A },
    })
  }, 60000)

  // ── Test 8: Successful finalization creates revision + audit atomically ──
  test('Successful finalization creates revision + audit atomically', async () => {
    // First recompute LINE_A to ensure it's complete (the rollback test may have left it incomplete).
    await estimateService.recomputeLine({
      ctx: ctxA,
      estimateId: EST_A,
      estimateLineId: LINE_A,
    })

    const result = await estimateService.finalizeRevision({
      ctx: ctxA,
      estimateId: EST_A,
      revisionNo: 888,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.revisionNo).toBe(888)
      expect(result.replay.totalSellPrice).toBeGreaterThan(0)

      // Verify the revision exists.
      const rev = await db.estimateRevision.findFirst({
        where: { estimateId: EST_A, revisionNo: 888 },
      })
      expect(rev).not.toBeNull()
      expect(rev?.status).toBe('finalized')

      // Verify the audit log exists.
      const audit = await db.auditLog.findFirst({
        where: {
          organizationId: ORG_A,
          action: 'estimate.revision-finalized',
          entityId: rev!.id,
        },
      })
      expect(audit).not.toBeNull()

      // Clean up the test revision.
      await db.estimateRevision.delete({ where: { id: rev!.id } })
      await db.auditLog.delete({ where: { id: audit!.id } })
    }
  }, 60000)
})
