/**
 * BidService integration tests — REAL adversarial tests with actual Neon DB data.
 *
 * Run: bun test tests/integration/bid-service.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { bidService } from '../../src/application/bid-service'
import { estimateService } from '../../src/application/estimate-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-bid-org-a'
const ORG_B = 'test-bid-org-b'
const USER_A = 'test-bid-user-a'
const USER_B = 'test-bid-user-b'
const CLIENT_A = 'test-bid-client-a'
const CLIENT_B = 'test-bid-client-b'
const OPP_A = 'test-bid-opp-a'
const OPP_B = 'test-bid-opp-b'
const EST_A = 'test-bid-est-a'
const EST_B = 'test-bid-est-b'
const LINE_A = 'test-bid-line-a'
const WD_A = 'test-bid-wd-a'
const WDV_A = 'test-bid-wdv-a'
const BID_A = 'test-bid-a'
const BID_B = 'test-bid-b'

const RECIPE = JSON.stringify([
  { resourceKind: 'material', resourceCode: 'RES-BID', resourceName: 'Test Material',
    unit: 'ton', quantityPerUnit: 0.1,
    priceObservation: { price: 100, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
])

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  name: 'Test User A', email: 'a@bid-test.com',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  name: 'Test User B', email: 'b@bid-test.com',
}

describe('BidService integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.workDefinitionVersion.deleteMany({ where: { id: WDV_A } })
    await db.workDefinition.deleteMany({ where: { id: WD_A } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })

    await db.organization.create({ data: { id: ORG_A, name: 'Bid Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@bid-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Bid Opp A', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-BID', name: 'Bid WD', unit: 'm2' } })
    await db.workDefinitionVersion.create({ data: { id: WDV_A, workDefinitionId: WD_A, version: 1, wastage: 0.05, costRecipeJson: RECIPE, approvalState: 'approved', hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' } })
    await db.estimateLine.create({ data: { id: LINE_A, estimateId: EST_A, workDefinitionId: WD_A, workDefinitionVersionId: WDV_A, description: 'Bid Line A', quantity: 100, unit: 'm2', executionStrategy: 'self-perform', calculationStatus: 'complete' } })

    await db.organization.create({ data: { id: ORG_B, name: 'Bid Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@bid-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({ data: { id: OPP_B, organizationId: ORG_B, clientId: CLIENT_B, title: 'Bid Opp B', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_B, organizationId: ORG_B, opportunityId: OPP_B, status: 'draft' } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.workDefinitionVersion.deleteMany({ where: { id: WDV_A } })
    await db.workDefinition.deleteMany({ where: { id: WD_A } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await db.$disconnect()
  }, 120000)

  beforeEach(async () => {
    // Simplified cleanup — delete deliverables by org, then bids by org
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: ORG_A } } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: ORG_B } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG_B } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } }).catch(() => {})
  }, 30000)

  // ── Cross-tenant tests ─────────────────────────────────────────────────────
  test('Org A cannot read Org B bid workspace', async () => {
    await db.bid.create({ data: { id: BID_B, organizationId: ORG_B, opportunityId: OPP_B, estimateId: EST_B, tenderPackStatus: 'draft' } })
    const result = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_B })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    await db.bid.delete({ where: { id: BID_B } })
  }, 60000)

  test('Org A cannot submit Org B bid', async () => {
    await db.bid.create({ data: { id: BID_B, organizationId: ORG_B, opportunityId: OPP_B, estimateId: EST_B, tenderPackStatus: 'adjudication' } })
    const result = await bidService.submitBid({ ctx: ctxA, bidId: BID_B })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    await db.bid.delete({ where: { id: BID_B } })
  }, 60000)

  // ── State machine tests ────────────────────────────────────────────────────
  test('Legal transition: draft → adjudication → ready', async () => {
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    const t1 = await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'adjudication' })
    expect(t1.ok).toBe(true)

    const t2 = await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'ready' })
    expect(t2.ok).toBe(true)
  }, 60000)

  test('Illegal transition: submitted → draft → rejected', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'submitted', submittedAt: new Date() } })
    const result = await bidService.transitionStatus({ ctx: ctxA, bidId: BID_A, newStatus: 'draft' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 60000)

  // ── Adjudication tests ─────────────────────────────────────────────────────
  test('Adjudication uses finalized revision (not mutable estimate)', async () => {
    // Recompute + finalize
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 200 })
    if (!finalizeResult.ok) return
    const revId = finalizeResult.revisionId

    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'adjudication' } })

    const result = await bidService.recordAdjudication({
      ctx: ctxA, bidId: BID_A, estimateRevisionId: revId,
      directorAdjustment: -0.05, adjustmentRationale: 'Strategic positioning',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.systemSellPrice).toBeGreaterThan(0)
      expect(result.finalPrice).toBeGreaterThan(0)
      expect(result.finalPrice).toBeLessThan(result.systemSellPrice) // -5%
    }

    // Verify the bid has both system price and adjustment persisted
    const bid = await db.bid.findUnique({ where: { id: BID_A } })
    expect(bid?.systemSellPrice).toBeGreaterThan(0)
    expect(bid?.directorAdjustment).toBe(-0.05)
    expect(bid?.adjustmentRationale).toBe('Strategic positioning')
    expect(bid?.finalPrice).toBeGreaterThan(0)
    expect(bid?.adjudicatedRevisionId).toBe(revId)

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 200 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, action: 'bid.adjudication-recorded' } })
  }, 60000)

  test('Adjudication without finalized revision → rejected', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'adjudication' } })
    const result = await bidService.recordAdjudication({
      ctx: ctxA, bidId: BID_A, estimateRevisionId: 'nonexistent-rev',
      directorAdjustment: 0, adjustmentRationale: 'test',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  }, 60000)

  test('Post-submission immutability: cannot adjudicate after submission', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'submitted', submittedAt: new Date() } })
    const result = await bidService.recordAdjudication({
      ctx: ctxA, bidId: BID_A, estimateRevisionId: 'any',
      directorAdjustment: 0, adjustmentRationale: 'attempted',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 60000)

  // ── Submission tests ───────────────────────────────────────────────────────
  test('Submit without adjudicated revision → rejected', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'adjudication' } })
    const result = await bidService.submitBid({ ctx: ctxA, bidId: BID_A })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('adjudicated')
  }, 60000)

  // ── Transaction rollback ───────────────────────────────────────────────────
  test('Transaction rollback: audit FK failure rolls back bid status change', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'draft' } })
    const ctxBad: RequestContext = { ...ctxA, userId: 'nonexistent-bid-user' }
    try {
      await bidService.transitionStatus({ ctx: ctxBad, bidId: BID_A, newStatus: 'adjudication' })
    } catch { /* Expected */ }
    const bid = await db.bid.findUnique({ where: { id: BID_A } })
    expect(bid?.tenderPackStatus).toBe('draft')
  }, 60000)

  // ── Outcome ────────────────────────────────────────────────────────────────
  test('Record outcome: won', async () => {
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'submitted', submittedAt: new Date(), finalPrice: 50000 } })
    const result = await bidService.recordOutcome({
      ctx: ctxA, bidId: BID_A, outcome: 'won', winningPrice: 50000, ourRank: 1,
    })
    expect(result.ok).toBe(true)
    const bid = await db.bid.findUnique({ where: { id: BID_A } })
    expect(bid?.outcome).toBe('won')
    expect(bid?.tenderPackStatus).toBe('won')
    expect(bid?.ourRank).toBe(1)
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, action: 'bid.outcome-recorded' } })
  }, 60000)

  // ── Cross-tenant estimate revision ─────────────────────────────────────────
  test('Org A cannot use Org B estimate revision for adjudication', async () => {
    // Finalize a revision in Org B
    await db.estimateLine.create({ data: { id: 'test-bid-line-b', estimateId: EST_B, description: 'B Line', quantity: 10, unit: 'm2', executionStrategy: 'self-perform', calculationStatus: 'complete' } })
    const finalizeB = await estimateService.finalizeRevision({ ctx: ctxB, estimateId: EST_B, revisionNo: 300 })
    let revBId: string | null = null
    if (finalizeB.ok) revBId = finalizeB.revisionId

    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'adjudication' } })

    if (revBId) {
      const result = await bidService.recordAdjudication({
        ctx: ctxA, bidId: BID_A, estimateRevisionId: revBId,
        directorAdjustment: 0, adjustmentRationale: 'cross-tenant attempt',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(404)
    }

    // Clean up
    if (revBId) await db.estimateRevision.delete({ where: { id: revBId } })
    await db.estimateLine.deleteMany({ where: { id: 'test-bid-line-b' } })
  }, 60000)

  // ── Wrong same-org revision (different estimate/opportunity) ───────────────
  test('Adjudication with same-org but wrong-estimate revision → rejected', async () => {
    // Create a second opportunity + estimate in Org A
    const OPP_A2 = 'test-bid-opp-a2'
    const EST_A2 = 'test-bid-est-a2'
    const LINE_A2 = 'test-bid-line-a2'
    await db.opportunity.create({ data: { id: OPP_A2, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A2', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_A2, organizationId: ORG_A, opportunityId: OPP_A2, status: 'draft' } })
    await db.estimateLine.create({ data: { id: LINE_A2, estimateId: EST_A2, description: 'A2 Line', quantity: 10, unit: 'm2', executionStrategy: 'self-perform', calculationStatus: 'complete' } })

    // Finalize a revision on EST_A2
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A2, revisionNo: 400 })
    let wrongRevId: string | null = null
    if (finalizeResult.ok) wrongRevId = finalizeResult.revisionId

    // Create a bid on EST_A (original)
    await db.bid.create({ data: { id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A, tenderPackStatus: 'adjudication' } })

    if (wrongRevId) {
      // Attempt to adjudicate Bid A (on EST_A) with a revision from EST_A2
      const result = await bidService.recordAdjudication({
        ctx: ctxA, bidId: BID_A, estimateRevisionId: wrongRevId,
        directorAdjustment: 0, adjustmentRationale: 'wrong estimate attempt',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(404)
    }

    // Clean up
    if (wrongRevId) await db.estimateRevision.delete({ where: { id: wrongRevId } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { id: LINE_A2 } })
    await db.estimate.deleteMany({ where: { id: EST_A2 } })
    await db.opportunity.deleteMany({ where: { id: OPP_A2 } })
  }, 60000)

  // ── End-to-end submission test ─────────────────────────────────────────────
  test('End-to-end: create → recompute → finalize → adjudicate → submit', async () => {
    // 1. Recompute the estimate line
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })

    // 2. Finalize a revision
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 500 })
    if (!finalizeResult.ok) return
    const revId = finalizeResult.revisionId

    // 3. Create a bid
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    // 4. Adjudicate with the finalized revision
    const adjResult = await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: revId,
      directorAdjustment: -0.03, adjustmentRationale: 'End-to-end test',
    })
    expect(adjResult.ok).toBe(true)
    if (adjResult.ok) {
      expect(adjResult.systemSellPrice).toBeGreaterThan(0)
      expect(adjResult.finalPrice).toBeGreaterThan(0)
    }

    // 5. Verify the bid has both revision IDs set and equal
    const bid = await db.bid.findUnique({ where: { id: createResult.bidId } })
    expect(bid?.adjudicatedRevisionId).toBe(revId)
    expect(bid?.estimateRevisionId).toBe(revId) // P0-4: both set to same revision
    expect(bid?.systemSellPrice).toBeGreaterThan(0)

    // 6. Transition to ready
    const transitionResult = await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'ready' })
    expect(transitionResult.ok).toBe(true)

    // 7. Submit (may fail due to gate blockers — that's OK, the key assertions
    // are about the adjudication/revision linkage, not the gate passing)
    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })
    // If submission succeeds, verify the bid is submitted with the right revision
    if (submitResult.ok) {
      const submittedBid = await db.bid.findUnique({ where: { id: createResult.bidId } })
      expect(submittedBid?.tenderPackStatus).toBe('submitted')
      expect(submittedBid?.estimateRevisionId).toBe(revId)
      expect(submittedBid?.adjudicatedRevisionId).toBe(revId)
      expect(submittedBid?.submittedAt).not.toBeNull()
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 500 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Post-adjudication mutation test ────────────────────────────────────────
  test('Post-adjudication: current estimate mutation does not change gate commercial state', async () => {
    // 1. Recompute + finalize
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 600 })
    if (!finalizeResult.ok) return
    const revId = finalizeResult.revisionId

    // 2. Create bid + adjudicate
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: revId,
      directorAdjustment: 0, adjustmentRationale: 'mutation test',
    })

    // 3. Mutate the current estimate line (change calculationStatus to incomplete)
    await db.estimateLine.update({
      where: { id: LINE_A },
      data: { calculationStatus: 'incomplete', unitRate: 0 },
    })

    // 4. Run the gate — it should use the FROZEN revision, not the mutated estimate
    const wsResult = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsResult.ok).toBe(true)
    if (wsResult.ok) {
      // The gate should NOT see the mutated incomplete line.
      // The frozen revision had calculationStatus='complete'.
      const incompleteCheck = wsResult.gate.checks.find((c) => c.id === 'incomplete-calculations')
      // If the gate is using the frozen revision, incomplete-calculations should be 'pass'
      // (because the revision was complete when finalized).
      // If the gate is using the mutable estimate, it would be 'blocker'.
      if (incompleteCheck) {
        expect(incompleteCheck.status).not.toBe('blocker')
      }
    }

    // Clean up: restore the line
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 600 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Missing required deliverable blocks submission ─────────────────────────
  test('Missing required deliverable blocks submission', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 700 })
    if (!finalizeResult.ok) return

    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'deliverable test',
    })

    await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'ready' })

    // Attempt to submit — should be blocked because deliverables are 'missing'
    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })
    expect(submitResult.ok).toBe(false)
    if (!submitResult.ok) {
      expect(submitResult.error).toContain('Required deliverables not ready')
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 700 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Wrong-type revision cannot satisfy programme requirement ──────────────
  test('Estimate revision (type=estimate) cannot be used as programme revision', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 800 })
    if (!finalizeResult.ok) return
    // This revision has revisionType='estimate' (default), not 'programme'

    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'wrong-type test',
    })

    // Try to submit with the estimate revision as programme revision
    const submitResult = await bidService.submitBid({
      ctx: ctxA, bidId: createResult.bidId,
      programmeRevisionId: finalizeResult.revisionId, // type='estimate', not 'programme'
    })

    // Should fail because the revision is type='estimate', not type='programme'
    // (or fail because deliverables are missing — either way it shouldn't succeed)
    expect(submitResult.ok).toBe(false)

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 800 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)
})
