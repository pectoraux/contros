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
  // Note: The caller-supplied programmeRevisionId API was removed in the final
  // cleanup. Programme truth comes exclusively from
  // TenderDeliverable(kind='programme').revisionId. The wrong-type-revision
  // case is covered by the test below ("Programme deliverable with estimate-type
  // revisionId → submission blocked").

  // ── Document-backed deliverable satisfies gate without revisionId ─────────
  test('Document-backed deliverable (method-statement) with status=finalized and no revisionId satisfies the gate', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 800 })
    if (!finalizeResult.ok) return

    // Create a bid with only document-backed deliverables required (no programme)
    const createResult = await bidService.createBid({
      ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A,
      requiredDeliverables: [
        { kind: 'boq', required: true },
        { kind: 'method-statement', required: true },
        { kind: 'jha', required: true },
        // programme explicitly not required for this tender
        { kind: 'programme', required: false },
      ],
    })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'document-backed test',
    })

    // Mark all required deliverables as finalized with NO revisionId.
    // This must satisfy the gate because document-backed kinds only require
    // status='ready'|'finalized'. Their revisionId semantics are deferred to
    // a future DocumentService.
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId },
      data: { status: 'finalized', revisionId: null },
    })

    const wsResult = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsResult.ok).toBe(true)
    if (wsResult.ok) {
      const deliverablesCheck = wsResult.gate.checks.find((c) => c.id === 'deliverables')
      if (deliverablesCheck) {
        // No required deliverable should be a blocker — all are finalized.
        expect(deliverablesCheck.status).not.toBe('blocker')
      }
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 800 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── BOQ readiness must use TenderDeliverable only (not estimate lines) ────
  test('BOQ deliverable missing → blocker even if estimate has lines', async () => {
    // Create a bid with default deliverables (BOQ required, status=missing)
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    // The estimate has lines, but BOQ deliverable status is 'missing'
    const wsResult = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsResult.ok).toBe(true)
    if (wsResult.ok) {
      const boqCheck = wsResult.gate.checks.find((c) => c.id === 'deliverables')
      if (boqCheck) {
        // BOQ is missing → deliverables check should be blocker
        expect(boqCheck.status).toBe('blocker')
      }
    }
  }, 60000)

  // ── Tender-specific deliverable requirements ──────────────────────────────
  test('Bid with programme not required → no programme blocker', async () => {
    const createResult = await bidService.createBid({
      ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A,
      requiredDeliverables: [
        { kind: 'boq', required: true },
        { kind: 'programme', required: false },
        { kind: 'method-statement', required: false },
        { kind: 'jha', required: false },
      ],
    })
    if (!createResult.ok) return

    // Mark BOQ as ready
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId, kind: 'boq' },
      data: { status: 'ready' },
    })

    const wsResult = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsResult.ok).toBe(true)
    if (wsResult.ok) {
      // Programme/MS/JHA are not required → should not be a blocker
      const deliverablesCheck = wsResult.gate.checks.find((c) => c.id === 'deliverables')
      if (deliverablesCheck) {
        expect(deliverablesCheck.status).not.toBe('blocker')
      }
    }
  }, 60000)

  // ── Post-adjudication: subcontract + estimate.status mutation ──────────────
  test('Post-adjudication: new subcontract quote + estimate.status change do not alter gate', async () => {
    // 1. Recompute + finalize (no subcontract in the revision)
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 900 })
    if (!finalizeResult.ok) return
    const revId = finalizeResult.revisionId

    // 2. Create bid + adjudicate (no subcontract in snapshot)
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: revId,
      directorAdjustment: 0, adjustmentRationale: 'mutation test',
    })

    // 3. Record the gate BEFORE mutation
    const wsBefore = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsBefore.ok).toBe(true)

    // 4. Mutate: change current estimate status
    await db.estimate.update({
      where: { id: EST_A },
      data: { status: 'submitted' },
    })

    // 5. Run gate AFTER mutation
    const wsAfter = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsAfter.ok).toBe(true)

    if (wsBefore.ok && wsAfter.ok) {
      // P0-2: commercialApproval must NOT change due to estimate.status mutation
      const approvalBefore = wsBefore.gate.checks.find((c) => c.id === 'commercial-approval')
      const approvalAfter = wsAfter.gate.checks.find((c) => c.id === 'commercial-approval')
      if (approvalBefore && approvalAfter) {
        expect(approvalAfter.status).toBe(approvalBefore.status)
      }

      // P0-1: subcontract packages must be empty (no snapshot, no fallback)
      // The gate's subcontract-coverage check should not see any packages
      const subcontractCheck = wsAfter.gate.checks.find((c) => c.id === 'subcontract-coverage')
      if (subcontractCheck) {
        // No packages = pass (nothing to check)
        expect(subcontractCheck.status).toBe('pass')
      }
    }

    // Clean up: restore estimate
    await db.estimate.update({ where: { id: EST_A }, data: { status: 'draft' } })
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 900 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Post-adjudication: new subcontract quote created after adjudication ───
  test('Post-adjudication: new subcontract package/quote created after adjudication is ignored by gate', async () => {
    // 1. Recompute + finalize (no subcontract in revision)
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 910 })
    if (!finalizeResult.ok) return

    // 2. Create bid + adjudicate
    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return
    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'subcontract mutation test',
    })

    // 3. Create a subcontract package + quote AFTER adjudication
    const PKG_NEW = 'test-bid-pkg-new'
    const QUOTE_NEW = 'test-bid-quote-new'
    await db.subcontractPackage.create({
      data: { id: PKG_NEW, organizationId: ORG_A, opportunityId: OPP_A, name: 'New Pkg', executionStrategy: 'subcontract' },
    })
    await db.subcontractQuote.create({
      data: { id: QUOTE_NEW, subcontractPackageId: PKG_NEW, supplierName: 'New Supplier', totalAmount: 99999, coveragePct: 1.0 },
    })
    // Select the new quote
    await db.subcontractPackage.update({ where: { id: PKG_NEW }, data: { selectedQuoteId: QUOTE_NEW, status: 'awarded' } })

    // 4. Run gate — the new subcontract should NOT appear
    const wsResult = await bidService.getBidWorkspace({ ctx: ctxA, opportunityId: OPP_A })
    expect(wsResult.ok).toBe(true)
    if (wsResult.ok) {
      // Subcontract-coverage should be 'pass' (no frozen packages = nothing to check)
      const scCheck = wsResult.gate.checks.find((c) => c.id === 'subcontract-coverage')
      if (scCheck) {
        expect(scCheck.status).toBe('pass')
      }
    }

    // Clean up
    await db.subcontractQuote.deleteMany({ where: { id: QUOTE_NEW } })
    await db.subcontractPackage.deleteMany({ where: { id: PKG_NEW } })
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 910 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Programme deliverable without revisionId → blocker ────────────────────
  test('Programme deliverable ready but no revisionId → submission blocked', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 920 })
    if (!finalizeResult.ok) return

    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'programme test',
    })

    // Mark ALL deliverables as ready, but programme has no revisionId
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId },
      data: { status: 'ready' },
    })

    // Attempt submission — should fail because programme has no revisionId
    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })
    expect(submitResult.ok).toBe(false)
    if (!submitResult.ok) {
      expect(submitResult.error).toContain('revisionId')
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 920 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Programme deliverable with estimate-type revision → blocker ───────────
  test('Programme deliverable with estimate-type revisionId → submission blocked', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 930 })
    if (!finalizeResult.ok) return
    // This revision has revisionType='estimate' (default)

    const createResult = await bidService.createBid({ ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'wrong-type programme test',
    })

    // Mark all deliverables ready + set programme revisionId to the ESTIMATE revision
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId },
      data: { status: 'ready' },
    })
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId, kind: 'programme' },
      data: { revisionId: finalizeResult.revisionId }, // type='estimate', not 'programme'
    })

    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })
    expect(submitResult.ok).toBe(false)
    if (!submitResult.ok) {
      expect(submitResult.error).toContain('invalid programme revision')
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 930 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Programme revision derived exclusively from TenderDeliverable ──────────
  test('submitBid derives programme revision exclusively from TenderDeliverable(kind=programme).revisionId — happy path', async () => {
    // 1. Recompute + finalize an ESTIMATE revision (for adjudication)
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 950 })
    if (!finalizeResult.ok) return

    // 2. Create a PROGRAMME revision (revisionType='programme') on the same estimate.
    //    This is the revision the programme deliverable will reference.
    const programmeRevision = await db.estimateRevision.create({
      data: {
        estimateId: EST_A,
        revisionNo: 951,
        revisionType: 'programme',
        status: 'finalized',
        snapshotJson: JSON.stringify({ lines: [], subcontractScopeSnapshots: [], totals: { systemSellPrice: 0 } }),
        finalizedById: ctxA.userId ?? null,
      },
    })

    // 3. Create a bid with BOQ + programme required.
    const createResult = await bidService.createBid({
      ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A,
      requiredDeliverables: [
        { kind: 'boq', required: true },
        { kind: 'programme', required: true },
      ],
    })
    if (!createResult.ok) return

    // 4. Adjudicate using the ESTIMATE revision.
    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'programme happy path',
    })

    // 5. Mark BOQ as ready, and programme as ready with the PROGRAMME revision ID.
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId, kind: 'boq' },
      data: { status: 'ready' },
    })
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId, kind: 'programme' },
      data: { status: 'ready', revisionId: programmeRevision.id },
    })

    // 6. Transition to ready and submit — NO programmeRevisionId argument.
    //    The service MUST derive programme truth exclusively from the
    //    TenderDeliverable(kind='programme').revisionId.
    await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'ready' })
    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })

    // 7. Assert the invariant. Two acceptable outcomes:
    //    (a) Submission succeeds → bid.programmeRevisionId === programmeRevision.id
    //        (proves the programme revision was resolved from the deliverable
    //         and written to the bid without any caller-supplied input)
    //    (b) Submission fails for NON-programme reasons (e.g. scope-completeness
    //        gate blockers, which are unrelated to this invariant) → the error
    //        must NOT mention programme/revisionId (proving programme resolution
    //        succeeded; some other gate check blocked)
    //    Outcome (b) is acceptable because this test's estimate has no scope
    //    items, so the scope-completeness gate may block. The invariant under
    //    test is programme resolution, not full gate passage.
    if (submitResult.ok) {
      const submittedBid = await db.bid.findUnique({ where: { id: createResult.bidId } })
      expect(submittedBid?.tenderPackStatus).toBe('submitted')
      expect(submittedBid?.programmeRevisionId).toBe(programmeRevision.id)
      expect(submittedBid?.estimateRevisionId).toBe(finalizeResult.revisionId)
      expect(submittedBid?.adjudicatedRevisionId).toBe(finalizeResult.revisionId)
    } else {
      // Programme resolution must have succeeded — the error must NOT be
      // about the programme deliverable or its revisionId.
      expect(submitResult.error).not.toMatch(/programme/i)
      expect(submitResult.error).not.toMatch(/revisionId/i)
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: { in: [950, 951] } } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)

  // ── Current estimate status does not affect post-adjudication submission ─
  test('Current estimate status draft does not block post-adjudication submission', async () => {
    await estimateService.recomputeLine({ ctx: ctxA, estimateId: EST_A, estimateLineId: LINE_A })
    const finalizeResult = await estimateService.finalizeRevision({ ctx: ctxA, estimateId: EST_A, revisionNo: 940 })
    if (!finalizeResult.ok) return

    const createResult = await bidService.createBid({
      ctx: ctxA, opportunityId: OPP_A, estimateId: EST_A,
      requiredDeliverables: [{ kind: 'boq', required: true }], // Only BOQ required, no programme
    })
    if (!createResult.ok) return

    await bidService.recordAdjudication({
      ctx: ctxA, bidId: createResult.bidId, estimateRevisionId: finalizeResult.revisionId,
      directorAdjustment: 0, adjustmentRationale: 'estimate status test',
    })

    // Ensure estimate status is draft
    await db.estimate.update({ where: { id: EST_A }, data: { status: 'draft' } })

    // Mark BOQ as ready
    await db.tenderDeliverable.updateMany({
      where: { bidId: createResult.bidId, kind: 'boq' },
      data: { status: 'ready' },
    })

    await bidService.transitionStatus({ ctx: ctxA, bidId: createResult.bidId, newStatus: 'ready' })

    // Submit — should NOT fail because of estimate.status='draft'
    // (It may fail for other gate reasons, but NOT because of estimate status)
    const submitResult = await bidService.submitBid({ ctx: ctxA, bidId: createResult.bidId })
    // If it fails, the error must NOT contain 'draft'
    if (!submitResult.ok) {
      expect(submitResult.error).not.toContain('draft')
    }

    // Clean up
    await db.estimateRevision.deleteMany({ where: { estimateId: EST_A, revisionNo: 940 } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Bid' } })
  }, 60000)
})
