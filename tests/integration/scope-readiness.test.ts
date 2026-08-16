/**
 * Scope Workspace + Bid Readiness integration tests.
 *
 * Verifies:
 * - Scope workspace returns mapped items, detects blockers
 * - Bid readiness gate correctly blocks on incomplete scope, blocked pricing,
 *   missing documents, and unresolved alerts
 * - Tenant isolation
 * - Architecture audit (no Prisma in routes/services)
 *
 * Run: bun test tests/integration/scope-readiness.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { scopeWorkspaceService } from '../../src/application/scope-workspace-service'
import { bidReadinessService } from '../../src/application/bid-readiness-service'
import type { RequestContext } from '../../src/lib/context'
import { readFileSync } from 'fs'

const db = new PrismaClient()

const ORG_A = 'test-sr-org-a'
const ORG_B = 'test-sr-org-b'
const USER_A = 'test-sr-user-a'
const CLIENT_A = 'test-sr-client-a'
const OPP_A = 'test-sr-opp-a'
const OPP_B = 'test-sr-opp-b'
const EST_A = 'test-sr-est-a'
const WD_A = 'test-sr-wd-a'
const WDV_A = 'test-sr-wdv-a'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'director', isDemo: false,
  name: 'User A', email: 'a@sr-test.com', actorType: 'human',
}
const ctxB: RequestContext = {
  userId: 'test-sr-user-b', organizationId: ORG_B, role: 'director', isDemo: false,
  name: 'User B', email: 'b@sr-test.com', actorType: 'human',
}

describe('Scope Workspace + Bid Readiness integration tests', () => {
  beforeAll(async () => {
    // Clean up
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.scopeItem.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopeQuestion.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopeAssumption.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, 'test-sr-user-b'] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})

    // Create Org A
    await db.organization.create({ data: { id: ORG_A, name: 'SR Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@sr-test.com', role: 'director' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'SR Opp A', status: 'estimating' } })

    // Create scope package with items
    await db.scopePackage.create({ data: { opportunityId: OPP_A, completeness: 0.67, origin: 'rfq' } })
    const sp = await db.scopePackage.findFirst({ where: { opportunityId: OPP_A } })
    if (!sp) throw new Error('Scope package not created')

    // Known item (mapped to estimate line)
    await db.scopeItem.create({ data: { scopePackageId: sp.id, description: 'Blockwork', status: 'known', category: 'masonry' } })
    // Missing item
    await db.scopeItem.create({ data: { scopePackageId: sp.id, description: 'Electrical specs', status: 'missing', category: 'mep' } })
    // Open question
    await db.scopeQuestion.create({ data: { scopePackageId: sp.id, question: 'Fire alarm responsibility?', status: 'open' } })
    // Unacknowledged high-risk assumption
    await db.scopeAssumption.create({ data: { scopePackageId: sp.id, text: 'Assume no rock excavation', riskLevel: 'high', acknowledged: false } })

    // Create WD + WDV
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-SR', name: 'SR WD', unit: 'm2' } })
    const recipe = JSON.stringify([
      { resourceKind: 'material', resourceCode: 'RES-SR', resourceName: 'Material', unit: 'ton', quantityPerUnit: 0.1, priceObservation: { price: 100, provenance: 'supplier-quote', observedAt: '2025-01-01' } },
    ])
    await db.workDefinitionVersion.create({
      data: { id: WDV_A, workDefinitionId: WD_A, version: 1, costRecipeJson: recipe, approvalState: 'approved', wastage: 0.05, hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.workDefinition.update({ where: { id: WD_A }, data: { currentVersionId: WDV_A } })

    // Create estimate with one complete + one incomplete line
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.estimateLine.create({
      data: {
        id: 'sr-line-1', estimateId: EST_A,
        workDefinitionId: WD_A, workDefinitionVersionId: WDV_A,
        description: 'Blockwork', quantity: 100, unit: 'm2',
        executionStrategy: 'self-perform', calculationStatus: 'complete',
        sellPrice: 5000, unitRate: 50, directCost: 4000,
      },
    })
    await db.estimateLine.create({
      data: {
        id: 'sr-line-2', estimateId: EST_A,
        description: 'Electrical', quantity: 200, unit: 'm',
        executionStrategy: 'undecided', calculationStatus: 'incomplete',
        sellPrice: 0, unitRate: 0, directCost: 0,
      },
    })

    // Create a knowledge alert
    await db.knowledgeAlert.create({
      data: { organizationId: ORG_A, type: 'unapproved-rate', severity: 'warning', title: 'Unapproved rate' },
    })

    // Create Org B (for tenant isolation)
    await db.organization.create({ data: { id: ORG_B, name: 'SR Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: 'test-sr-user-b', organizationId: ORG_B, name: 'User B', email: 'b@sr-test.com', role: 'director' } })
    await db.client.create({ data: { id: 'test-sr-client-b', organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({ data: { id: OPP_B, organizationId: ORG_B, clientId: 'test-sr-client-b', title: 'SR Opp B', status: 'estimating' } })
    await db.scopePackage.create({ data: { opportunityId: OPP_B, completeness: 1.0, origin: 'rfq' } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.scopeItem.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopeQuestion.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopeAssumption.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, 'test-sr-user-b'] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── Scope Workspace tests ───────────────────────────────────────────────

  test('scope workspace returns mapped items with completeness', async () => {
    const result = await scopeWorkspaceService.getScopeWorkspace({ ctx: ctxA, opportunityId: OPP_A })

    expect(result.completenessPct).toBe(67)
    expect(result.totalItems).toBe(2)
    expect(result.knownItems).toBe(1)
    expect(result.missingItems).toBe(1)
    expect(result.openQuestions).toBe(1)
    expect(result.unacknowledgedHighRiskAssumptions).toBe(1)
  }, 30000)

  test('scope workspace detects blockers', async () => {
    const result = await scopeWorkspaceService.getScopeWorkspace({ ctx: ctxA, opportunityId: OPP_A })

    expect(result.blockers.length).toBeGreaterThan(0)
    // Should have a MISSING_QUANTITY blocker (missing scope item)
    expect(result.blockers.some(b => b.type === 'MISSING_QUANTITY')).toBe(true)
    // Should have an OPEN_QUESTION blocker
    expect(result.blockers.some(b => b.type === 'OPEN_QUESTION')).toBe(true)
    // Should have an UNACKNOWLEDGED_HIGH_RISK_ASSUMPTION blocker
    expect(result.blockers.some(b => b.type === 'UNACKNOWLEDGED_HIGH_RISK_ASSUMPTION')).toBe(true)
  }, 30000)

  test('scope workspace tenant isolation — Org B cannot see Org A scope', async () => {
    const result = await scopeWorkspaceService.getScopeWorkspace({ ctx: ctxB, opportunityId: OPP_A })

    // Org B should get empty result (no scope package found for cross-tenant)
    expect(result.totalItems).toBe(0)
    expect(result.blockers.length).toBeGreaterThan(0) // "No scope package" blocker
  }, 30000)

  // ── Bid Readiness tests ─────────────────────────────────────────────────

  test('bid readiness returns ready=false for incomplete opportunity', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxA, opportunityId: OPP_A })

    expect(result.ready).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  }, 30000)

  test('bid readiness detects blocked pricing (calculationStatus, NOT sellPrice)', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxA, opportunityId: OPP_A })

    // Should have a PRICING blocker for the incomplete line
    const pricingBlockers = result.blockers.filter(b => b.category === 'PRICING')
    expect(pricingBlockers.length).toBeGreaterThan(0)
    expect(pricingBlockers.some(b => b.code === 'BLOCKED_PRICE')).toBe(true)

    // The score should be 50% (1 of 2 lines complete)
    expect(result.score.pricing).toBe(50)
  }, 30000)

  test('bid readiness detects incomplete scope', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxA, opportunityId: OPP_A })

    const scopeBlockers = result.blockers.filter(b => b.category === 'SCOPE')
    expect(scopeBlockers.length).toBeGreaterThan(0)
    expect(result.score.scope).toBe(67) // completeness = 0.67
  }, 30000)

  test('bid readiness detects missing documents (no bid → no deliverables)', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxA, opportunityId: OPP_A })

    expect(result.score.documents).toBe(0) // No bid → no deliverables
  }, 30000)

  test('bid readiness tenant isolation — Org B cannot see Org A readiness', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxB, opportunityId: OPP_A })

    // Org B should see no estimate (cross-tenant)
    const pricingBlockers = result.blockers.filter(b => b.category === 'PRICING')
    expect(pricingBlockers.some(b => b.message.includes('No estimate exists'))).toBe(true)
  }, 30000)

  test('bid readiness for complete Org B opportunity returns high scores', async () => {
    const result = await bidReadinessService.getReadiness({ ctx: ctxB, opportunityId: OPP_B })

    // Org B has 100% scope completeness, no questions, no assumptions
    expect(result.score.scope).toBe(100)
    // No estimate → pricing blockers
    expect(result.ready).toBe(false)
  }, 30000)

  // ── Architecture audit ─────────────────────────────────────────────────

  test('scope-workspace-service has zero db.* calls', () => {
    const code = readFileSync('src/application/scope-workspace-service.ts', 'utf-8')
    expect(code).not.toContain('from \'@/lib/db\'')
    expect(code).not.toContain('db.')
  }, 5000)

  test('bid-readiness-service has zero db.* calls', () => {
    const code = readFileSync('src/application/bid-readiness-service.ts', 'utf-8')
    expect(code).not.toContain('from \'@/lib/db\'')
    expect(code).not.toContain('db.')
  }, 5000)

  test('scope-workspace route has zero db.* calls', () => {
    const code = readFileSync('src/app/api/opportunities/[id]/scope-workspace/route.ts', 'utf-8')
    expect(code).not.toContain('from \'@/lib/db\'')
    expect(code).not.toContain('db.')
  }, 5000)

  test('readiness route has zero db.* calls', () => {
    const code = readFileSync('src/app/api/opportunities/[id]/readiness/route.ts', 'utf-8')
    expect(code).not.toContain('from \'@/lib/db\'')
    expect(code).not.toContain('db.')
  }, 5000)
})
