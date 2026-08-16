/**
 * Layer 2: Application-Boundary Historical Bid Reconstruction
 *
 * This test proves that the frozen application services can reconstruct a
 * historical bid WITHOUT bypassing them. Unlike Layer 1 (which reads from
 * the DB and calls replayRevision directly), Layer 2 uses:
 *
 *   OpportunityService.createOpportunity()
 *   → EstimateService.recomputeLine() (for each line)
 *   → EstimateService.finalizeRevision()
 *   → BidService.createBid()
 *   → BidService.recordAdjudication()
 *   → replayRevision(snapshot)
 *   → compare DB state vs replay
 *
 * The test creates an isolated tenant so it doesn't touch the canonical
 * historical data. Since the services use the CURRENT (corrected) engine,
 * the DB values should match the replay EXACTLY — no wastage-fix variance.
 *
 * Acceptance gate:
 *   Layer 1 — historical DB snapshot → replay          ✅
 *   Layer 2 — application services → revision → replay  ⏳ THIS TEST
 *
 * Run: bun test tests/integration/app-boundary-reconstruction.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { estimateService } from '../../src/application/estimate-service'
import { bidService } from '../../src/application/bid-service'
import { opportunityService } from '../../src/application/opportunity-service'
import { replayRevision } from '../../src/lib/engines/revision-service'
import { round2 } from '../../src/lib/engines/money'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG = 'layer2-org'
const USER = 'layer2-user'
const CLIENT = 'layer2-client'
const OPP = 'layer2-opp'
const EST = 'layer2-est'
const WD = 'layer2-wd'
const WDV = 'layer2-wdv'
const LINE_1 = 'layer2-line-1'
const LINE_2 = 'layer2-line-2'

const ctx: RequestContext = {
  userId: USER, organizationId: ORG, role: 'estimator', isDemo: false,
  name: 'Layer 2 User', email: 'layer2@test.com', actorType: 'human',
}

// Recipe with material + labour (tests wastage material-only semantics)
const RECIPE = JSON.stringify([
  { resourceKind: 'material', resourceCode: 'RES-MAT-BLOCK', resourceName: 'Blocks', unit: 'no', quantityPerUnit: 12.5, priceObservation: { price: 6.50, provenance: 'supplier-quote', sourceReference: 'BTP-183', observedAt: '2025-01-15' } },
  { resourceKind: 'material', resourceCode: 'RES-MAT-CEM', resourceName: 'Cement', unit: 'ton', quantityPerUnit: 0.035, priceObservation: { price: 95.00, provenance: 'invoice', sourceReference: 'INV-982', observedAt: '2025-01-15' } },
  { resourceKind: 'labour', resourceCode: 'RES-LAB-MASON', resourceName: 'Mason', unit: 'day', quantityPerUnit: 0.083, priceObservation: { price: 120.00, provenance: 'historical-bid', sourceReference: 'BID-2024', observedAt: '2025-01-15' } },
])

const RECIPE_2 = JSON.stringify([
  { resourceKind: 'material', resourceCode: 'RES-MAT-ROOF', resourceName: 'Roofing', unit: 'm2', quantityPerUnit: 1.05, priceObservation: { price: 58.00, provenance: 'supplier-quote', sourceReference: 'ALU-558', observedAt: '2025-01-15' } },
  { resourceKind: 'labour', resourceCode: 'RES-LAB-ROOFER', resourceName: 'Roofer', unit: 'day', quantityPerUnit: 0.04, priceObservation: { price: 130.00, provenance: 'historical-bid', sourceReference: 'BID-2024', observedAt: '2025-01-15' } },
])

describe('Layer 2: Application-Boundary Historical Bid Reconstruction', () => {
  let revisionId: string
  let bidId: string

  beforeAll(async () => {
    // Clean up
    await db.commercialException.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.executionSegment.deleteMany({ where: { estimateLine: { estimate: { organizationId: ORG } } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: ORG } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG } }).catch(() => {})

    // Create isolated tenant
    await db.organization.create({ data: { id: ORG, name: 'Layer 2 Org', currency: 'GHS' } })
    await db.user.create({ data: { id: USER, organizationId: ORG, name: 'L2 User', email: 'layer2@test.com', role: 'director' } })
  }, 120000)

  afterAll(async () => {
    await db.commercialException.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.executionSegment.deleteMany({ where: { estimateLine: { estimate: { organizationId: ORG } } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: ORG } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: ORG } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG } }).catch(() => {})
    await db.user.deleteMany({ where: { id: USER } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: ORG } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ─── Step 1: Create opportunity via OpportunityService ────────────────────

  test('Step 1: OpportunityService.createOpportunity creates opportunity + scope package', async () => {
    // Create client first (OpportunityService requires a client)
    await db.client.create({ data: { id: CLIENT, organizationId: ORG, name: 'Layer 2 Client' } })

    const result = await opportunityService.createOpportunity({
      ctx, clientId: CLIENT, title: 'Layer 2 Test Opportunity',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Verify the opportunity has a scope package (auto-created)
    const opp = await db.opportunity.findUnique({
      where: { id: result.opportunityId },
      include: { scopePackage: true },
    })
    expect(opp).not.toBeNull()
    expect(opp?.scopePackage).not.toBeNull()
  }, 30000)

  // ─── Step 2: Create WorkDefinitions + WDVersions (setup, not service) ────

  test('Step 2: Create WorkDefinitions + approved WDVersions', async () => {
    // Get the opportunity ID from step 1
    const opp = await db.opportunity.findFirst({ where: { organizationId: ORG } })

    // Create WD + WDV for blockwork
    await db.workDefinition.create({
      data: { id: WD, organizationId: ORG, code: 'WD-L2-001', name: 'Blockwork', unit: 'm2' },
    })
    await db.workDefinitionVersion.create({
      data: {
        id: WDV, workDefinitionId: WD, version: 1,
        costRecipeJson: RECIPE, approvalState: 'approved',
        wastage: 0.05, productivityRule: 12,
        hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]',
        approvedAt: new Date(), approvedById: USER,
      },
    })
    await db.workDefinition.update({ where: { id: WD }, data: { currentVersionId: WDV } })

    // Create WD + WDV for roofing
    await db.workDefinition.create({
      data: { id: WD + '-2', organizationId: ORG, code: 'WD-L2-002', name: 'Roofing', unit: 'm2' },
    })
    await db.workDefinitionVersion.create({
      data: {
        id: WDV + '-2', workDefinitionId: WD + '-2', version: 1,
        costRecipeJson: RECIPE_2, approvalState: 'approved',
        wastage: 0.07, productivityRule: 25,
        hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]',
        approvedAt: new Date(), approvedById: USER,
      },
    })
    await db.workDefinition.update({ where: { id: WD + '-2' }, data: { currentVersionId: WDV + '-2' } })
  }, 30000)

  // ─── Step 3: Create Estimate + Lines (setup), then recompute via service ──

  test('Step 3: EstimateService.recomputeLine prices each line through the engine', async () => {
    const opp = await db.opportunity.findFirst({ where: { organizationId: ORG } })
    if (!opp) return

    // Create estimate
    await db.estimate.create({
      data: {
        id: EST, organizationId: ORG, opportunityId: opp.id,
        status: 'draft', version: 1,
        overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
      },
    })

    // Create estimate lines
    await db.estimateLine.create({
      data: {
        id: LINE_1, estimateId: EST,
        workDefinitionId: WD, workDefinitionVersionId: WDV,
        description: 'Blockwork', quantity: 380, unit: 'm2',
        executionStrategy: 'self-perform', calculationStatus: 'complete',
      },
    })
    await db.estimateLine.create({
      data: {
        id: LINE_2, estimateId: EST,
        workDefinitionId: WD + '-2', workDefinitionVersionId: WDV + '-2',
        description: 'Roofing', quantity: 220, unit: 'm2',
        executionStrategy: 'self-perform', calculationStatus: 'complete',
      },
    })

    // Recompute each line via the service (application boundary)
    const r1 = await estimateService.recomputeLine({ ctx, estimateId: EST, estimateLineId: LINE_1 })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.line.calculationStatus).toBe('complete')
      expect(r1.line.sellPrice).toBeGreaterThan(0)
    }

    const r2 = await estimateService.recomputeLine({ ctx, estimateId: EST, estimateLineId: LINE_2 })
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.line.calculationStatus).toBe('complete')
      expect(r2.line.sellPrice).toBeGreaterThan(0)
    }
  }, 30000)

  // ─── Step 4: Finalize revision via EstimateService ────────────────────────

  test('Step 4: EstimateService.finalizeRevision creates immutable snapshot', async () => {
    const result = await estimateService.finalizeRevision({ ctx, estimateId: EST, revisionNo: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    revisionId = result.revisionId

    // Verify the revision is finalized
    const rev = await db.estimateRevision.findUnique({
      where: { id: revisionId },
      select: { status: true, snapshotJson: true },
    })
    expect(rev?.status).toBe('finalized')

    // Verify the replay matches (sanity check from the service return)
    expect(result.replay.totalSellPrice).toBeGreaterThan(0)
  }, 30000)

  // ─── Step 5: Create bid via BidService ────────────────────────────────────

  test('Step 5: BidService.createBid creates bid with deliverables', async () => {
    const opp = await db.opportunity.findFirst({ where: { organizationId: ORG } })
    if (!opp) return

    const result = await bidService.createBid({
      ctx, opportunityId: opp.id, estimateId: EST,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    bidId = result.bidId

    const bid = await db.bid.findUnique({ where: { id: bidId } })
    expect(bid?.tenderPackStatus).toBe('draft')
  }, 30000)

  // ─── Step 6: Record adjudication via BidService ───────────────────────────

  test('Step 6: BidService.recordAdjudication freezes commercial state', async () => {
    const result = await bidService.recordAdjudication({
      ctx, bidId, estimateRevisionId: revisionId,
      directorAdjustment: -0.02, adjustmentRationale: '2% discount for repeat client',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.systemSellPrice).toBeGreaterThan(0)
    expect(result.finalPrice).toBeGreaterThan(0)

    // Verify the bid has the adjudicated revision
    const bid = await db.bid.findUnique({ where: { id: bidId } })
    expect(bid?.adjudicatedRevisionId).toBe(revisionId)
    expect(bid?.estimateRevisionId).toBe(revisionId)
    expect(bid?.systemSellPrice).toBe(result.systemSellPrice)
  }, 30000)

  // ─── Step 7: Replay and compare with DB (EXACT match expected) ────────────

  test('Step 7: replayRevision matches DB state EXACTLY (no wastage-fix variance)', async () => {
    // Load the revision snapshot
    const rev = await db.estimateRevision.findUnique({
      where: { id: revisionId },
      select: { snapshotJson: true },
    })
    expect(rev).not.toBeNull()

    // Replay
    const replay = replayRevision(rev!.snapshotJson)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return

    // Load DB lines
    const dbLines = await db.estimateLine.findMany({
      where: { estimateId: EST },
      select: {
        id: true, description: true, sellPrice: true, unitRate: true,
        directCost: true, materialCost: true, labourCost: true, plantCost: true,
        subcontractCost: true, feeCost: true, calculationStatus: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    expect(replay.lines.length).toBe(dbLines.length)

    // Compare each line — ALL fields should be EXACT (both DB and replay use the new engine)
    for (const dbLine of dbLines) {
      const replayedLine = replay.lines.find(l => l.lineId === dbLine.id)
      expect(replayedLine).toBeDefined()
      if (!replayedLine) continue

      const b = replayedLine.breakdown
      // All fields should match EXACTLY — both DB and replay use the same (current) engine.
      // No wastage-fix variance because the DB values were computed by the CURRENT engine.
      expect(dbLine.sellPrice).toBe(b.sellPrice)
      expect(dbLine.unitRate).toBe(b.unitRate)
      expect(dbLine.directCost).toBe(b.directCost)
      expect(dbLine.materialCost).toBe(b.material)
      expect(dbLine.labourCost).toBe(b.labour)
      expect(dbLine.plantCost).toBe(b.plant)
      expect(dbLine.subcontractCost).toBe(b.subcontract)
      expect(dbLine.feeCost).toBe(b.fee)
    }

    // Total sell price must match
    const dbTotalSellPrice = dbLines.reduce((s, l) => s + l.sellPrice, 0)
    expect(replay.totalSellPrice).toBe(round2(dbTotalSellPrice))
  }, 30000)

  // ─── Step 8: Bid commercial state matches replay ──────────────────────────

  test('Step 8: Bid.systemSellPrice matches replay.totalSellPrice', async () => {
    const rev = await db.estimateRevision.findUnique({
      where: { id: revisionId },
      select: { snapshotJson: true },
    })
    const replay = replayRevision(rev!.snapshotJson)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return

    const bid = await db.bid.findUnique({ where: { id: bidId } })
    expect(bid?.systemSellPrice).toBe(replay.totalSellPrice)

    // finalPrice = systemSellPrice × (1 + directorAdjustment)
    const expectedFinalPrice = round2(replay.totalSellPrice * (1 + -0.02))
    expect(bid?.finalPrice).toBe(expectedFinalPrice)
  }, 30000)

  // ─── Step 9: Provenance is complete ────────────────────────────────────────

  test('Step 9: Every priced resource has provenance in the replay', async () => {
    const rev = await db.estimateRevision.findUnique({
      where: { id: revisionId },
      select: { snapshotJson: true },
    })
    const replay = replayRevision(rev!.snapshotJson)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return

    for (const line of replay.lines) {
      expect(line.breakdown.provenance.length).toBeGreaterThan(0)
      expect(line.breakdown.unsourced).toBe(false)
      for (const prov of line.breakdown.provenance) {
        expect(prov.resourceCode).toBeTruthy()
        expect(prov.price).toBeGreaterThan(0)
        expect(prov.provenance).toBeTruthy()
      }
    }
  }, 30000)
})
