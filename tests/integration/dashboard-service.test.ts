/**
 * ContractorDashboardService integration tests.
 *
 * Verifies:
 * - Dashboard KPIs return real counts from the DB
 * - Tenant isolation: Org A's dashboard does not include Org B's data
 * - Blocked pricing items count is accurate
 * - Pipeline value is correctly summed
 *
 * Run: bun test tests/integration/dashboard-service.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { contractorDashboardService } from '../../src/application/contractor-dashboard-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-dash-org-a'
const ORG_B = 'test-dash-org-b'
const USER_A = 'test-dash-user-a'
const USER_B = 'test-dash-user-b'
const CLIENT_A = 'test-dash-client-a'
const CLIENT_B = 'test-dash-client-b'
const OPP_A = 'test-dash-opp-a'
const OPP_B = 'test-dash-opp-b'
const EST_A = 'test-dash-est-a'
const EST_B = 'test-dash-est-b'
const LINE_A = 'test-dash-line-a'
const LINE_B = 'test-dash-line-b'
const WD_A = 'test-dash-wd-a'
const WDV_A = 'test-dash-wdv-a'
const BID_A = 'test-dash-bid-a'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'director', isDemo: false,
  name: 'User A', email: 'a@dash-test.com', actorType: 'human',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'director', isDemo: false,
  name: 'User B', email: 'b@dash-test.com', actorType: 'human',
}

describe('ContractorDashboardService integration tests', () => {
  beforeAll(async () => {
    // Clean up
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})

    // Create Org A with data
    await db.organization.create({ data: { id: ORG_A, name: 'Dash Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@dash-test.com', role: 'director' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({
      data: {
        id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A,
        title: 'Dash Test Opp A', status: 'estimating',
        submissionDeadline: new Date(Date.now() + 3 * 86400000), // 3 days from now
      },
    })
    await db.scopePackage.create({ data: { opportunityId: OPP_A, completeness: 0, origin: 'rfq' } })

    // Create WD + WDV for Org A
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-DASH', name: 'Dash WD', unit: 'm2' } })
    const recipe = JSON.stringify([
      { resourceKind: 'material', resourceCode: 'RES-MAT', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 100, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
    ])
    await db.workDefinitionVersion.create({
      data: { id: WDV_A, workDefinitionId: WD_A, version: 1, costRecipeJson: recipe, approvalState: 'approved', wastage: 0.05, hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.workDefinition.update({ where: { id: WD_A }, data: { currentVersionId: WDV_A } })

    // Create estimate with one blocked line (calculationStatus=incomplete)
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.estimateLine.create({
      data: {
        id: LINE_A, estimateId: EST_A,
        workDefinitionId: WD_A, workDefinitionVersionId: WDV_A,
        description: 'Blocked line', quantity: 100, unit: 'm2',
        executionStrategy: 'undecided', calculationStatus: 'incomplete',
        sellPrice: 0, unitRate: 0, directCost: 0,
      },
    })

    // Create a submitted bid
    await db.bid.create({
      data: {
        id: BID_A, organizationId: ORG_A, opportunityId: OPP_A, estimateId: EST_A,
        tenderPackStatus: 'submitted', finalPrice: 50000, outcome: 'won',
        winningPrice: 50000, ourRank: 1,
      },
    })

    // Create a knowledge alert
    await db.knowledgeAlert.create({
      data: { organizationId: ORG_A, type: 'stale-price', severity: 'warning', title: 'Stale cement price' },
    })

    // Create an audit log entry
    await db.auditLog.create({
      data: { organizationId: ORG_A, actorId: USER_A, action: 'test.action', entityType: 'Test', entityId: 'test-1', summary: 'Test activity' },
    })

    // Create Org B with different data
    await db.organization.create({ data: { id: ORG_B, name: 'Dash Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@dash-test.com', role: 'director' } })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({
      data: {
        id: OPP_B, organizationId: ORG_B, clientId: CLIENT_B,
        title: 'Dash Test Opp B', status: 'estimating',
      },
    })
    await db.scopePackage.create({ data: { opportunityId: OPP_B, completeness: 0, origin: 'rfq' } })
    await db.estimate.create({ data: { id: EST_B, organizationId: ORG_B, opportunityId: OPP_B, status: 'draft' } })
    await db.estimateLine.create({
      data: {
        id: LINE_B, estimateId: EST_B,
        description: 'Org B line', quantity: 50, unit: 'm2',
        executionStrategy: 'self-perform', calculationStatus: 'complete',
        sellPrice: 10000, unitRate: 200, directCost: 8000,
      },
    })
    await db.knowledgeAlert.create({
      data: { organizationId: ORG_B, type: 'unapproved-rate', severity: 'blocker', title: 'Org B alert' },
    })
    await db.auditLog.create({
      data: { organizationId: ORG_B, actorId: USER_B, action: 'test.action.b', entityType: 'Test', entityId: 'test-b-1', summary: 'Org B activity' },
    })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── Dashboard returns real KPIs ──────────────────────────────────────────

  test('Org A dashboard returns correct KPIs', async () => {
    const result = await contractorDashboardService.getDashboard({ ctx: ctxA })

    expect(result.kpis.openOpportunities).toBeGreaterThanOrEqual(1)
    expect(result.kpis.bidsDueThisWeek).toBeGreaterThanOrEqual(1) // deadline in 3 days
    expect(result.kpis.blockedPricingItems).toBeGreaterThanOrEqual(1) // the undecided line
    expect(result.kpis.submittedBids).toBeGreaterThanOrEqual(1)
    expect(result.kpis.awardedProjects).toBeGreaterThanOrEqual(1) // outcome=won
    expect(result.kpis.knowledgeAlerts).toBeGreaterThanOrEqual(1)
    expect(result.kpis.estimatesNeedingReview).toBeGreaterThanOrEqual(1)
    expect(result.kpis.pipelineValue).toBeGreaterThanOrEqual(0) // sellPrice is 0 for blocked line
  }, 30000)

  // ── Tenant isolation ────────────────────────────────────────────────────

  test('Org A dashboard does NOT include Org B data', async () => {
    const resultA = await contractorDashboardService.getDashboard({ ctx: ctxA })
    const resultB = await contractorDashboardService.getDashboard({ ctx: ctxB })

    // Org A should not see Org B's opportunities
    const aTitles = resultA.pipelineByStatus.map(p => p.status)
    const bTitles = resultB.pipelineByStatus.map(p => p.status)

    // Both have 'estimating' but the counts should differ
    // Org A has at least 1 opportunity, Org B has at least 1
    const aEstimating = resultA.pipelineByStatus.find(p => p.status === 'estimating')?.count ?? 0
    const bEstimating = resultB.pipelineByStatus.find(p => p.status === 'estimating')?.count ?? 0
    expect(aEstimating).toBeGreaterThanOrEqual(1)
    expect(bEstimating).toBeGreaterThanOrEqual(1)

    // Org A's alerts should NOT include Org B's alert
    const aAlertTitles = resultA.alerts.map(a => a.title)
    expect(aAlertTitles).not.toContain('Org B alert')

    // Org B's alerts should NOT include Org A's alert
    const bAlertTitles = resultB.alerts.map(a => a.title)
    expect(bAlertTitles).not.toContain('Stale cement price')

    // Org A's recent activity should NOT include Org B's activity
    const aActivitySummaries = resultA.recentActivity.map(a => a.summary)
    expect(aActivitySummaries).not.toContain('Org B activity')

    // Org B's recent activity should NOT include Org A's activity
    const bActivitySummaries = resultB.recentActivity.map(a => a.summary)
    expect(bActivitySummaries).not.toContain('Test activity')
  }, 30000)

  // ── Blocked pricing count is accurate ───────────────────────────────────

  test('blockedPricingItems count matches actual incomplete lines', async () => {
    const result = await contractorDashboardService.getDashboard({ ctx: ctxA })

    // We created 1 blocked line (LINE_A with calculationStatus='incomplete')
    // There might be other blocked lines from other tests, so check >= 1
    expect(result.kpis.blockedPricingItems).toBeGreaterThanOrEqual(1)

    // Verify by directly counting (for validation only — the service uses the repo)
    const directCount = await db.estimateLine.count({
      where: {
        estimate: {
          organizationId: ORG_A,
          status: { in: ['draft', 'internal-review', 'adjudicated'] },
        },
        calculationStatus: 'incomplete',
      },
    })
    expect(result.kpis.blockedPricingItems).toBe(directCount)
  }, 30000)

  // ── Pipeline value calculation ──────────────────────────────────────────

  test('pipelineValue is summed from latest estimate sellPrices', async () => {
    const result = await contractorDashboardService.getDashboard({ ctx: ctxB })

    // Org B has 1 opportunity with 1 complete line (sellPrice=10000)
    // and no blocked lines, so pipelineValue should be 10000
    expect(result.kpis.pipelineValue).toBe(10000)
  }, 30000)

  // ── No raw Prisma in the service ─────────────────────────────────────────

  test('ContractorDashboardService has zero direct db.* calls', async () => {
    // This is a source-code audit — verify the service file doesn't import db
    const fs = await import('fs')
    const serviceCode = fs.readFileSync(
      new URL('../../src/application/contractor-dashboard-service.ts', import.meta.url),
      'utf-8',
    )
    expect(serviceCode).not.toContain('from \'@/lib/db\'')
    expect(serviceCode).not.toContain('import { db')
    expect(serviceCode).not.toContain('db.')
  }, 10000)

  // ── No raw Prisma in the dashboard route ────────────────────────────────

  test('dashboard route has zero direct db.* calls', async () => {
    const fs = await import('fs')
    const routeCode = fs.readFileSync(
      new URL('../../src/app/api/dashboard/route.ts', import.meta.url),
      'utf-8',
    )
    expect(routeCode).not.toContain('from \'@/lib/db\'')
    expect(routeCode).not.toContain('import { db')
    expect(routeCode).not.toContain('db.')
  }, 10000)
})
