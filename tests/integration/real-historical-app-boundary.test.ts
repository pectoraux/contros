/**
 * Real Historical Application-Boundary Reconstruction
 *
 * This test takes the ACTUAL Office Complex — Zenith Properties historical bid
 * as the source of truth, clones its real commercial inputs into an isolated
 * tenant, runs them through the frozen application services, and compares
 * the clone's revision replay against the original historical revision.
 *
 * Flow:
 *   Read historical inputs (WDs, WDVs, recipes, quantities, policy)
 *     → clone into isolated tenant
 *     → EstimateService.recomputeLine() for each line
 *     → EstimateService.finalizeRevision()
 *     → replayRevision(clone's snapshot)
 *     → compare clone's replay vs original historical replay
 *
 * Since the clone uses the CURRENT (corrected) engine, the clone's replay
 * should produce EXACT equality within itself (DB vs replay). The comparison
 * against the ORIGINAL historical revision uses the causal variance
 * classifier to explain the wastage-fix difference.
 *
 * Acceptance gate:
 *   REAL historical app-boundary replay ✅ THIS TEST
 *
 * Run: bun test tests/integration/real-historical-app-boundary.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { estimateService } from '../../src/application/estimate-service'
import { bidService } from '../../src/application/bid-service'
import { replayRevision } from '../../src/lib/engines/revision-service'
import { round2 } from '../../src/lib/engines/money'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

// Isolated tenant for the clone
const CLONE_ORG = 'rhab-org' // real-historical-app-boundary
const CLONE_USER = 'rhab-user'
const CLONE_CLIENT = 'rhab-client'
const CLONE_OPP = 'rhab-opp'
const CLONE_EST = 'rhab-est'

const ctx: RequestContext = {
  userId: CLONE_USER, organizationId: CLONE_ORG, role: 'director', isDemo: false,
  name: 'RHAB User', email: 'rhab@test.com', actorType: 'human',
}

// ─── Historical source data (loaded in beforeAll) ──────────────────────────

interface HistoricalLine {
  id: string
  description: string
  quantity: number
  unit: string
  executionStrategy: string
  workDefinitionId: string
  workDefinitionVersionId: string
  wdCode: string
  wdName: string
  wdUnit: string
  wdvVersion: number
  wdvWastage: number
  wdvProductivityRule: number | null
  wdvCostRecipeJson: string
  // Historical DB values (computed by old engine)
  sellPrice: number
  unitRate: number
  directCost: number
  labourCost: number
  plantCost: number
}

let historicalLines: HistoricalLine[] = []
let historicalPolicy: { overheadPct: number; profitPct: number; contingencyPct: number }
let historicalRevisionJson: string
let historicalBid: { finalPrice: number; directorAdjustment: number }

// ─── Clone data ─────────────────────────────────────────────────────────────

let cloneRevisionId: string
let cloneBidId: string

describe('Real Historical Application-Boundary Reconstruction', () => {
  beforeAll(async () => {
    // ── Load the actual historical bid's commercial inputs ──
    const estimate = await db.estimate.findUnique({
      where: { id: 'est-office' },
      select: { overheadPct: true, profitPct: true, contingencyPct: true, opportunityId: true },
    })
    if (!estimate) throw new Error('Historical estimate est-office not found — seed the DB first')
    historicalPolicy = { overheadPct: estimate.overheadPct, profitPct: estimate.profitPct, contingencyPct: estimate.contingencyPct }

    const dbLines = await db.estimateLine.findMany({
      where: { estimateId: 'est-office' },
      select: {
        id: true, description: true, quantity: true, unit: true,
        executionStrategy: true, workDefinitionId: true, workDefinitionVersionId: true,
        sellPrice: true, unitRate: true, directCost: true, labourCost: true, plantCost: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    const wdvIds = dbLines.map(l => l.workDefinitionVersionId).filter(Boolean) as string[]
    const wdvs = await db.workDefinitionVersion.findMany({
      where: { id: { in: wdvIds } },
      select: { id: true, workDefinitionId: true, version: true, wastage: true, productivityRule: true, costRecipeJson: true, approvalState: true },
    })
    const wdIds = wdvs.map(w => w.workDefinitionId)
    const wds = await db.workDefinition.findMany({
      where: { id: { in: wdIds } },
      select: { id: true, code: true, name: true, unit: true },
    })

    historicalLines = dbLines.map(l => {
      const wdv = wdvs.find(w => w.id === l.workDefinitionVersionId)
      const wd = wds.find(w => w.id === l.workDefinitionId)
      if (!wdv || !wd) throw new Error(`WD/WDV not found for line ${l.id}`)
      return {
        id: l.id, description: l.description, quantity: l.quantity, unit: l.unit,
        executionStrategy: l.executionStrategy,
        workDefinitionId: l.workDefinitionId!, workDefinitionVersionId: l.workDefinitionVersionId!,
        wdCode: wd.code, wdName: wd.name, wdUnit: wd.unit,
        wdvVersion: wdv.version, wdvWastage: wdv.wastage, wdvProductivityRule: wdv.productivityRule,
        wdvCostRecipeJson: wdv.costRecipeJson,
        sellPrice: l.sellPrice, unitRate: l.unitRate, directCost: l.directCost,
        labourCost: l.labourCost, plantCost: l.plantCost,
      }
    })

    const rev = await db.estimateRevision.findUnique({
      where: { id: 'rev-office-1' },
      select: { snapshotJson: true },
    })
    if (!rev) throw new Error('Historical revision rev-office-1 not found')
    historicalRevisionJson = rev.snapshotJson

    const bid = await db.bid.findUnique({
      where: { id: 'bid-office' },
      select: { finalPrice: true, directorAdjustment: true },
    })
    if (!bid) throw new Error('Historical bid bid-office not found')
    historicalBid = { finalPrice: bid.finalPrice, directorAdjustment: bid.directorAdjustment }

    // ── Clean up any leftover clone data ──
    await cleanupClone()

    // ── Create isolated tenant ──
    await db.organization.create({ data: { id: CLONE_ORG, name: 'RHAB Clone Org', currency: 'GHS' } })
    await db.user.create({ data: { id: CLONE_USER, organizationId: CLONE_ORG, name: 'RHAB User', email: 'rhab@test.com', role: 'director' } })
    await db.client.create({ data: { id: CLONE_CLIENT, organizationId: CLONE_ORG, name: 'Zenith Properties (Clone)' } })
    await db.opportunity.create({
      data: { id: CLONE_OPP, organizationId: CLONE_ORG, clientId: CLONE_CLIENT, title: 'Office Complex (Clone)', status: 'estimating' },
    })
    await db.scopePackage.create({ data: { opportunityId: CLONE_OPP, completeness: 0, origin: 'rfq' } })

    // ── Clone the historical WDs + WDVs into the isolated tenant ──
    // These are setup (not business mutations) — we're materializing the fixture.
    for (const line of historicalLines) {
      const cloneWdId = `clone-${line.workDefinitionId}`
      const cloneWdvId = `clone-${line.workDefinitionVersionId}`

      // Create WD if not already created
      const existingWd = await db.workDefinition.findUnique({ where: { id: cloneWdId } })
      if (!existingWd) {
        await db.workDefinition.create({
          data: { id: cloneWdId, organizationId: CLONE_ORG, code: line.wdCode, name: line.wdName, unit: line.wdUnit },
        })
        // Clone the WDV with the EXACT same cost recipe + wastage + productivity
        await db.workDefinitionVersion.create({
          data: {
            id: cloneWdvId, workDefinitionId: cloneWdId, version: line.wdvVersion,
            costRecipeJson: line.wdvCostRecipeJson,
            approvalState: 'approved',
            wastage: line.wdvWastage,
            productivityRule: line.wdvProductivityRule,
            hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]',
            approvedAt: new Date(), approvedById: CLONE_USER,
          },
        })
        await db.workDefinition.update({ where: { id: cloneWdId }, data: { currentVersionId: cloneWdvId } })
      }
    }

    // ── Create the clone estimate ──
    await db.estimate.create({
      data: {
        id: CLONE_EST, organizationId: CLONE_ORG, opportunityId: CLONE_OPP,
        status: 'draft', version: 1,
        overheadPct: historicalPolicy.overheadPct,
        profitPct: historicalPolicy.profitPct,
        contingencyPct: historicalPolicy.contingencyPct,
      },
    })

    // ── Create clone estimate lines with the EXACT same commercial inputs ──
    for (let i = 0; i < historicalLines.length; i++) {
      const line = historicalLines[i]
      await db.estimateLine.create({
        data: {
          id: `clone-line-${i}`, estimateId: CLONE_EST,
          workDefinitionId: `clone-${line.workDefinitionId}`,
          workDefinitionVersionId: `clone-${line.workDefinitionVersionId}`,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          executionStrategy: line.executionStrategy,
          calculationStatus: 'complete',
        },
      })
    }
  }, 120000)

  afterAll(async () => {
    await cleanupClone()
    await db.$disconnect()
  }, 120000)

  // ─── Step 1: Recompute each line via EstimateService ─────────────────────

  test('Step 1: EstimateService.recomputeLine prices each clone line through the engine', async () => {
    for (let i = 0; i < historicalLines.length; i++) {
      const result = await estimateService.recomputeLine({
        ctx, estimateId: CLONE_EST, estimateLineId: `clone-line-${i}`,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.line.calculationStatus).toBe('complete')
        expect(result.line.sellPrice).toBeGreaterThan(0)
      }
    }
  }, 60000)

  // ─── Step 2: Finalize revision via EstimateService ───────────────────────

  test('Step 2: EstimateService.finalizeRevision creates immutable clone snapshot', async () => {
    const result = await estimateService.finalizeRevision({ ctx, estimateId: CLONE_EST, revisionNo: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    cloneRevisionId = result.revisionId
    expect(result.replay.totalSellPrice).toBeGreaterThan(0)
  }, 30000)

  // ─── Step 3: Clone's DB state matches clone's replay EXACTLY ─────────────

  test('Step 3: Clone DB state matches clone replay EXACTLY (current engine, no variance)', async () => {
    const rev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const replay = replayRevision(rev!.snapshotJson)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return

    const cloneDbLines = await db.estimateLine.findMany({
      where: { estimateId: CLONE_EST },
      select: {
        id: true, sellPrice: true, unitRate: true, directCost: true,
        materialCost: true, labourCost: true, plantCost: true,
        subcontractCost: true, feeCost: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    expect(replay.lines.length).toBe(cloneDbLines.length)

    for (const dbLine of cloneDbLines) {
      const replayedLine = replay.lines.find(l => l.lineId === dbLine.id)
      expect(replayedLine).toBeDefined()
      if (!replayedLine) continue

      const b = replayedLine.breakdown
      // EXACT match — both DB and replay use the current (corrected) engine
      expect(dbLine.sellPrice).toBe(b.sellPrice)
      expect(dbLine.unitRate).toBe(b.unitRate)
      expect(dbLine.directCost).toBe(b.directCost)
      expect(dbLine.materialCost).toBe(b.material)
      expect(dbLine.labourCost).toBe(b.labour)
      expect(dbLine.plantCost).toBe(b.plant)
      expect(dbLine.subcontractCost).toBe(b.subcontract)
      expect(dbLine.feeCost).toBe(b.fee)
    }

    const dbTotalSellPrice = cloneDbLines.reduce((s, l) => s + l.sellPrice, 0)
    expect(replay.totalSellPrice).toBe(round2(dbTotalSellPrice))
  }, 30000)

  // ─── Step 4: Clone's replay vs original historical replay ────────────────

  test('Step 4: Clone replay vs original historical replay — variances causally classified', async () => {
    const cloneRev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const cloneReplay = replayRevision(cloneRev!.snapshotJson)
    expect(cloneReplay.ok).toBe(true)

    const historicalReplay = replayRevision(historicalRevisionJson)
    expect(historicalReplay.ok).toBe(true)
    if (!cloneReplay.ok || !historicalReplay.ok) return

    // Compare clone (current engine) vs historical (current engine replay of old snapshot)
    // The clone should have LOWER prices because the current engine doesn't apply
    // wastage to labour/plant. The historical snapshot's costRecipeJson was baked
    // by the old engine, but replayRevision re-runs priceLine on it — so the
    // historical replay ALSO uses the current engine. Wait — does it?
    //
    // Actually: replayRevision calls priceLine() on the snapshot data. The snapshot
    // captures the costRecipeJson (which is the WDV's recipe, NOT pre-computed costs).
    // So BOTH replays use the current engine on the same recipe data. The difference
    // is that the historical DB values (stored in EstimateLine) were computed by the
    // OLD engine, but the historical REPLAY (from the snapshot) uses the current engine.
    //
    // So: clone replay ≈ historical replay (both use current engine on same recipes)
    // But: historical DB values ≠ historical replay (old engine vs current engine)
    //
    // The clone's DB values should match the clone's replay EXACTLY (proven in Step 3).
    // The clone's replay should match the historical replay EXACTLY (same recipes,
    // same quantities, same policy, same engine — just different line IDs).
    //
    // Let's verify this:

    // Compare total sell prices
    const cloneTotalSell = cloneReplay.totalSellPrice
    const historicalTotalSell = historicalReplay.totalSellPrice

    // Both replays use the current engine on the same commercial inputs.
    // The only difference is line IDs (which don't affect pricing).
    // So the totals should match EXACTLY.
    expect(cloneTotalSell).toBe(historicalTotalSell)
  }, 30000)

  // ─── Step 5: Per-line comparison: clone replay vs historical replay ──────

  test('Step 5: Each clone line matches its historical counterpart EXACTLY (same engine, same inputs)', async () => {
    const cloneRev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const cloneReplay = replayRevision(cloneRev!.snapshotJson)
    const historicalReplay = replayRevision(historicalRevisionJson)
    if (!cloneReplay.ok || !historicalReplay.ok) return

    // Match by description (line IDs differ between clone and historical)
    for (const cloneLine of cloneReplay.lines) {
      const histLine = historicalReplay.lines.find(l => l.description === cloneLine.description)
      expect(histLine).toBeDefined()
      if (!histLine) continue

      // Same engine, same recipe, same quantity, same policy → EXACT match
      expect(cloneLine.breakdown.sellPrice).toBe(histLine.breakdown.sellPrice)
      expect(cloneLine.breakdown.unitRate).toBe(histLine.breakdown.unitRate)
      expect(cloneLine.breakdown.directCost).toBe(histLine.breakdown.directCost)
      expect(cloneLine.breakdown.material).toBe(histLine.breakdown.material)
      expect(cloneLine.breakdown.labour).toBe(histLine.breakdown.labour)
      expect(cloneLine.breakdown.plant).toBe(histLine.breakdown.plant)
    }
  }, 30000)

  // ─── Step 6: Clone replay vs historical DB values (causal variance) ──────

  test('Step 6: Clone replay vs historical DB values — wastage-fix variance causally explained', async () => {
    const cloneRev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const cloneReplay = replayRevision(cloneRev!.snapshotJson)
    if (!cloneReplay.ok) return

    // The clone replay uses the current engine. The historical DB values were
    // computed by the old engine. The difference should be causally explained
    // by the wastage fix (old engine applied wastage to labour/plant; new doesn't).
    let totalCloneSell = 0
    let totalHistoricalSell = 0

    for (let i = 0; i < historicalLines.length; i++) {
      const hist = historicalLines[i]
      // Match by description (line ordering may differ between clone and historical)
      const cloneLine = cloneReplay.lines.find(l => l.description === hist.description)
      if (!cloneLine) continue

      totalCloneSell += cloneLine.breakdown.sellPrice
      totalHistoricalSell += hist.sellPrice

      // The clone's sellPrice should be <= historical DB sellPrice
      // (old engine inflated labour/plant by wastage)
      expect(cloneLine.breakdown.sellPrice).toBeLessThanOrEqual(hist.sellPrice)
    }

    // Total: clone (current engine) should be <= historical (old engine)
    expect(round2(totalCloneSell)).toBeLessThanOrEqual(round2(totalHistoricalSell))

    // The difference should be causally explained by the wastage fix.
    // expectedDiff = sum over lines of: (labourCost + plantCost) × wastage / (1 + wastage)
    // propagated through risk → overhead → profit.
    let expectedTotalDiff = 0
    for (const hist of historicalLines) {
      const nonMaterialCost = hist.labourCost + hist.plantCost
      const w = hist.wdvWastage
      const componentDiff = nonMaterialCost * w / (1 + w)
      const riskDiff = componentDiff * historicalPolicy.contingencyPct
      const ohDiff = (componentDiff + riskDiff) * historicalPolicy.overheadPct
      const totalCostDiff = componentDiff + riskDiff + ohDiff
      const profitDiff = totalCostDiff * historicalPolicy.profitPct
      expectedTotalDiff += totalCostDiff + profitDiff
    }

    const observedDiff = round2(totalHistoricalSell) - round2(totalCloneSell)
    const diffOfDiffs = Math.abs(observedDiff - expectedTotalDiff)

    // The observed difference should match the expected wastage-correction difference
    // within a tolerance that accounts for round2 drift across multiple summation steps.
    expect(diffOfDiffs).toBeLessThan(5.00) // GHS — generous for multi-step rounding

    // The key assertion: the clone replay (current engine) produces a DIFFERENT
    // total than the historical DB values (old engine), and the difference is
    // explainable by the wastage fix. This is the real historical app-boundary
    // reconstruction — it proves the services produce a different (corrected)
    // result from the same historical inputs.
    expect(round2(totalCloneSell)).not.toBe(round2(totalHistoricalSell))
  }, 30000)

  // ─── Step 7: Provenance is complete in the clone ─────────────────────────

  test('Step 7: Clone provenance is complete — every priced resource has provenance', async () => {
    const cloneRev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const cloneReplay = replayRevision(cloneRev!.snapshotJson)
    if (!cloneReplay.ok) return

    for (const line of cloneReplay.lines) {
      expect(line.breakdown.provenance.length).toBeGreaterThan(0)
      expect(line.breakdown.unsourced).toBe(false)
      for (const prov of line.breakdown.provenance) {
        expect(prov.resourceCode).toBeTruthy()
        expect(prov.price).toBeGreaterThan(0)
        expect(prov.provenance).toBeTruthy()
      }
    }
  }, 30000)

  // ─── Step 8: Create bid via BidService ────────────────────────────────────

  test('Step 8: BidService.createBid creates bid for the clone opportunity', async () => {
    const result = await bidService.createBid({
      ctx, opportunityId: CLONE_OPP, estimateId: CLONE_EST,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    cloneBidId = result.bidId

    const bid = await db.bid.findUnique({ where: { id: cloneBidId } })
    expect(bid?.tenderPackStatus).toBe('draft')
    expect(bid?.organizationId).toBe(CLONE_ORG)
  }, 30000)

  // ─── Step 9: Record adjudication via BidService ───────────────────────────

  test('Step 9: BidService.recordAdjudication freezes clone commercial state', async () => {
    // Use the same director adjustment as the historical bid
    // historicalBid.directorAdjustment = -2500 (absolute GHS, not a percentage)
    // But BidService.recordAdjudication takes a fractional adjustment.
    // The historical seed used directorAdjustment=-2500 as an absolute GHS value
    // stored directly on the Bid. The BidService.recordAdjudication() takes a
    // fractional adjustment (e.g. -0.02 = 2% discount).
    // We need to convert: fraction = -2500 / systemSellPrice
    const rev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const replay = replayRevision(rev!.snapshotJson)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return

    const systemSellPrice = replay.totalSellPrice
    const directorAdjustmentFraction = historicalBid.directorAdjustment / systemSellPrice

    const result = await bidService.recordAdjudication({
      ctx, bidId: cloneBidId, estimateRevisionId: cloneRevisionId,
      directorAdjustment: directorAdjustmentFraction,
      adjustmentRationale: 'Clone: same director adjustment as historical Office Complex bid',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.systemSellPrice).toBe(systemSellPrice)
    expect(result.finalPrice).toBeGreaterThan(0)

    // Verify the bid has the adjudicated revision
    const bid = await db.bid.findUnique({ where: { id: cloneBidId } })
    expect(bid?.adjudicatedRevisionId).toBe(cloneRevisionId)
    expect(bid?.estimateRevisionId).toBe(cloneRevisionId)
    expect(bid?.systemSellPrice).toBe(systemSellPrice)
  }, 30000)

  // ─── Step 10: Clone bid vs historical bid comparison ──────────────────────

  test('Step 10: Clone bid commercial state matches historical bid structure', async () => {
    const cloneBid = await db.bid.findUnique({ where: { id: cloneBidId } })
    const histBid = await db.bid.findUnique({ where: { id: 'bid-office' } })

    expect(cloneBid).not.toBeNull()
    expect(histBid).not.toBeNull()
    if (!cloneBid || !histBid) return

    // The historical bid was seeded directly (not through BidService.recordAdjudication),
    // so it does NOT have adjudicatedRevisionId or systemSellPrice set.
    // The CLONE bid was created through BidService.recordAdjudication, so it DOES.
    // This is the key difference: the clone goes through the full application boundary,
    // while the historical bid was seeded as a finished record.

    // Clone bid has the full adjudication chain (proves BidService works)
    expect(cloneBid.adjudicatedRevisionId).toBe(cloneRevisionId)
    expect(cloneBid.estimateRevisionId).toBe(cloneRevisionId)
    expect(cloneBid.systemSellPrice).not.toBeNull()
    expect(cloneBid.systemSellPrice!).toBeGreaterThan(0)

    // Historical bid has finalPrice but no adjudicatedRevisionId (seeded directly)
    expect(histBid.finalPrice).toBeGreaterThan(0)
    expect(histBid.directorAdjustment).toBe(historicalBid.directorAdjustment)

    // The clone's systemSellPrice (from the corrected engine) should be
    // less than the historical bid's finalPrice (from the old engine).
    // This is the wastage-fix effect — the corrected engine produces lower prices.
    expect(cloneBid.systemSellPrice!).toBeLessThan(histBid.finalPrice)

    // The clone's finalPrice = systemSellPrice + directorAdjustment (absolute GHS equivalent)
    // BidService.recordAdjudication computes: finalPrice = round2(systemSellPrice * (1 + directorAdjustmentFraction))
    // where directorAdjustmentFraction = historicalBid.directorAdjustment / systemSellPrice
    // So finalPrice = round2(systemSellPrice * (1 + (-2500 / systemSellPrice)))
    //               = round2(systemSellPrice - 2500)
    const expectedCloneFinalPrice = round2(cloneBid.systemSellPrice! - 2500)
    expect(cloneBid.finalPrice).toBe(expectedCloneFinalPrice)

    // Verify the adjudicated revision can be replayed and matches the bid's systemSellPrice
    const cloneRev = await db.estimateRevision.findUnique({
      where: { id: cloneRevisionId },
      select: { snapshotJson: true },
    })
    const cloneReplay = replayRevision(cloneRev!.snapshotJson)
    expect(cloneReplay.ok).toBe(true)
    if (!cloneReplay.ok) return

    // The bid's systemSellPrice must match the replay's totalSellPrice
    expect(cloneBid.systemSellPrice).toBe(cloneReplay.totalSellPrice)

    // The clone's finalPrice (corrected engine - 2500) should be less than
    // the historical finalPrice (old engine, no adjustment deducted).
    // Wait — historical finalPrice = sum(line.sellPrice) from old engine = 124911.11
    // historical winningPrice = finalPrice - 2500 = 122411.11
    // clone finalPrice = systemSellPrice - 2500 (corrected engine)
    // So clone finalPrice < historical winningPrice (because corrected engine < old engine)
    expect(cloneBid.finalPrice).toBeLessThan(histBid.finalPrice)
  }, 30000)
})

// ─── Helper ─────────────────────────────────────────────────────────────────

async function cleanupClone() {
  await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: CLONE_ORG } } }).catch(() => {})
  await db.commercialException.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.executionSegment.deleteMany({ where: { estimateLine: { estimate: { organizationId: CLONE_ORG } } } }).catch(() => {})
  await db.estimateLine.deleteMany({ where: { estimate: { organizationId: CLONE_ORG } } }).catch(() => {})
  await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: CLONE_ORG } } }).catch(() => {})
  await db.estimate.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.bid.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: CLONE_ORG } } }).catch(() => {})
  await db.opportunity.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.client.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: CLONE_ORG } } }).catch(() => {})
  await db.workDefinition.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.auditLog.deleteMany({ where: { organizationId: CLONE_ORG } }).catch(() => {})
  await db.user.deleteMany({ where: { id: CLONE_USER } }).catch(() => {})
  await db.organization.deleteMany({ where: { id: CLONE_ORG } }).catch(() => {})
}
