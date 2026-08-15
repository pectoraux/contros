/**
 * OpportunityService integration tests — REAL adversarial tests with actual
 * Neon DB data.
 *
 * Run: bun test tests/integration/opportunity-service.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { opportunityService } from '../../src/application/opportunity-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-opp-org-a'
const ORG_B = 'test-opp-org-b'
const USER_A = 'test-opp-user-a'
const USER_B = 'test-opp-user-b'
const CLIENT_A = 'test-opp-client-a'
const CLIENT_B = 'test-opp-client-b'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  name: 'Test User A', email: 'a@opp-test.com',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  name: 'Test User B', email: 'b@opp-test.com',
}

describe('OpportunityService integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.scopeEvidence.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeAssumption.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeQuestion.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeItem.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })

    await db.organization.create({ data: { id: ORG_A, name: 'Opp Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@opp-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })

    await db.organization.create({ data: { id: ORG_B, name: 'Opp Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@opp-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.scopeEvidence.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeAssumption.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeQuestion.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopeItem.deleteMany({ where: { scopePackage: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } } })
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } })
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await db.$disconnect()
  }, 120000)

  beforeEach(async () => {
    // Clean up test-specific records between tests
    await db.scopeEvidence.deleteMany({ where: { scopePackage: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.scopeAssumption.deleteMany({ where: { scopePackage: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.scopeQuestion.deleteMany({ where: { scopePackage: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.scopeItem.deleteMany({ where: { scopePackage: { opportunity: { organizationId: ORG_A } } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: ORG_A } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
  }, 30000)

  // ── Client tests ──────────────────────────────────────────────────────────

  test('createClient creates a client and audit log', async () => {
    const result = await opportunityService.createClient({
      ctx: ctxA, name: 'Test Client 1', sector: 'public',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const client = await db.client.findUnique({ where: { id: result.clientId } })
    expect(client?.name).toBe('Test Client 1')
    expect(client?.sector).toBe('public')
    expect(client?.organizationId).toBe(ORG_A)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'Client', entityId: result.clientId },
    })
    expect(audit?.action).toBe('client.created')

    await db.client.delete({ where: { id: result.clientId } })
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Client' } })
  }, 30000)

  test('createClient rejects empty name', async () => {
    const result = await opportunityService.createClient({ ctx: ctxA, name: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  test('listClients returns only org A clients', async () => {
    // Create a client in org A and org B
    const resultA = await opportunityService.createClient({ ctx: ctxA, name: 'List Client A' })
    await opportunityService.createClient({ ctx: ctxB, name: 'List Client B' })

    const list = await opportunityService.listClients({ ctx: ctxA })
    expect(list.ok).toBe(true)
    if (!list.ok) return

    const names = list.clients.map((c) => c.name)
    expect(names).toContain('List Client A')
    expect(names).not.toContain('List Client B')

    // Cleanup
    if (resultA.ok) await db.client.delete({ where: { id: resultA.clientId } })
    const clientB = await db.client.findFirst({ where: { organizationId: ORG_B, name: 'List Client B' } })
    if (clientB) await db.client.delete({ where: { id: clientB.id } })
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] }, entityType: 'Client' } })
  }, 30000)

  // ── Opportunity create + auto scope package ──────────────────────────────

  test('createOpportunity auto-creates a 1:1 scope package', async () => {
    const result = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Test Opp 1', source: 'direct',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const opportunity = await db.opportunity.findUnique({
      where: { id: result.opportunityId },
      include: { scopePackage: true },
    })
    expect(opportunity?.title).toBe('Test Opp 1')
    expect(opportunity?.status).toBe('received')
    expect(opportunity?.scopePackage).not.toBeNull()
    expect(opportunity?.scopePackage?.completeness).toBe(0)
    expect(opportunity?.scopePackage?.origin).toBe('rfq')

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'Opportunity', entityId: result.opportunityId },
    })
    expect(audit?.action).toBe('opportunity.created')
  }, 30000)

  test('createOpportunity rejects wrong-org client', async () => {
    const result = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_B, title: 'Cross-org client',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  }, 30000)

  // ── Cross-tenant isolation ───────────────────────────────────────────────

  test('Org A cannot view Org B opportunity detail', async () => {
    // Create an opportunity in Org B
    const opp = await db.opportunity.create({
      data: {
        organizationId: ORG_B, clientId: CLIENT_B, title: 'Org B Opp',
        status: 'received',
      },
    })
    await db.scopePackage.create({ data: { opportunityId: opp.id, completeness: 0, origin: 'rfq' } })

    const result = await opportunityService.getOpportunityDetail({
      ctx: ctxA, opportunityId: opp.id,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    // Cleanup
    await db.scopePackage.deleteMany({ where: { opportunityId: opp.id } })
    await db.opportunity.delete({ where: { id: opp.id } })
  }, 30000)

  test('Org A cannot add scope items to Org B opportunity', async () => {
    const opp = await db.opportunity.create({
      data: { organizationId: ORG_B, clientId: CLIENT_B, title: 'Org B Opp 2', status: 'received' },
    })
    await db.scopePackage.create({ data: { opportunityId: opp.id, completeness: 0, origin: 'rfq' } })

    const result = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: opp.id, description: 'Cross-tenant item', status: 'known',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    // Verify no scope item was created
    const items = await db.scopeItem.findMany({
      where: { scopePackage: { opportunityId: opp.id } },
    })
    expect(items.length).toBe(0)

    // Cleanup
    await db.scopePackage.deleteMany({ where: { opportunityId: opp.id } })
    await db.opportunity.delete({ where: { id: opp.id } })
  }, 30000)

  // ── Status state machine ─────────────────────────────────────────────────

  test('Legal transition: received → qualifying → scope-development', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Transition Test',
    })
    if (!createResult.ok) return

    const r1 = await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: createResult.opportunityId, newStatus: 'qualifying',
    })
    expect(r1.ok).toBe(true)

    const r2 = await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: createResult.opportunityId, newStatus: 'scope-development',
    })
    expect(r2.ok).toBe(true)
  }, 30000)

  test('Illegal transition: received → submitted → rejected', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Illegal Transition Test',
    })
    if (!createResult.ok) return

    const result = await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: createResult.opportunityId, newStatus: 'submitted',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Illegal status transition')
  }, 30000)

  test('Cannot transition to estimating with empty scope', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Empty Scope Test',
    })
    if (!createResult.ok) return

    // Move to scope-development first
    await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: createResult.opportunityId, newStatus: 'scope-development',
    })

    // Try to move to estimating — should fail (no scope items)
    const result = await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: createResult.opportunityId, newStatus: 'estimating',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('no items')
    }
  }, 30000)

  test('Can transition to estimating after adding a scope item', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'With Scope Item Test',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    await opportunityService.transitionStatus({ ctx: ctxA, opportunityId: oppId, newStatus: 'scope-development' })
    await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Foundation works', status: 'known',
    })

    const result = await opportunityService.transitionStatus({
      ctx: ctxA, opportunityId: oppId, newStatus: 'estimating',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newStatus).toBe('estimating')
    }
  }, 30000)

  // ── Scope item CRUD + completeness ───────────────────────────────────────

  test('addScopeItem recomputes completeness', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Completeness Test 1',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    // Add a known item → completeness should be 1.0
    const r1 = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Known item', status: 'known',
    })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.score).toBe(1)

    // Add a missing item → completeness should be 0.5 (1 known / 2 total)
    const r2 = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Missing item', status: 'missing',
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.score).toBe(0.5)

    // Verify the scope package completeness was persisted
    const sp = await db.scopePackage.findFirst({ where: { opportunityId: oppId } })
    expect(sp?.completeness).toBe(0.5)
  }, 30000)

  test('updateScopeItem changes status and recomputes completeness', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Completeness Test 2',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    const addResult = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Item to update', status: 'missing',
    })
    if (!addResult.ok) return
    const itemId = addResult.itemId

    // Completeness should be 0 (0 known / 1 total)
    expect(addResult.score).toBe(0)

    // Update to known → completeness should be 1.0
    const updateResult = await opportunityService.updateScopeItem({
      ctx: ctxA, opportunityId: oppId, itemId, status: 'known',
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) expect(updateResult.score).toBe(1)
  }, 30000)

  test('removeScopeItem recomputes completeness', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Completeness Test 3',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    const r1 = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Known', status: 'known',
    })
    const r2 = await opportunityService.addScopeItem({
      ctx: ctxA, opportunityId: oppId, description: 'Missing', status: 'missing',
    })
    if (!r1.ok || !r2.ok) return
    // Completeness = 0.5 (1 known / 2 total)

    // Remove the missing item → completeness should be 1.0 (1 known / 1 total)
    const removeResult = await opportunityService.removeScopeItem({
      ctx: ctxA, opportunityId: oppId, itemId: r2.itemId,
    })
    expect(removeResult.ok).toBe(true)
    if (removeResult.ok) expect(removeResult.score).toBe(1)
  }, 30000)

  // ── Scope questions ──────────────────────────────────────────────────────

  test('addScopeQuestion and clarify it', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Question Test',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    const qResult = await opportunityService.addScopeQuestion({
      ctx: ctxA, opportunityId: oppId, question: 'What is the exact floor area?',
    })
    expect(qResult.ok).toBe(true)

    // Get scope workspace — should show 1 open question
    const ws = await opportunityService.getScopeWorkspace({ ctx: ctxA, opportunityId: oppId })
    expect(ws.ok).toBe(true)
    if (ws.ok) {
      const completeness = ws.completeness as { openQuestions: number }
      expect(completeness.openQuestions).toBe(1)
    }

    // Clarify the question
    if (qResult.ok) {
      const clarifyResult = await opportunityService.clarifyScopeQuestion({
        ctx: ctxA, opportunityId: oppId, questionId: qResult.questionId,
        status: 'clarified', resolution: 'Client confirmed 500 m2',
      })
      expect(clarifyResult.ok).toBe(true)
    }

    // Get workspace again — should show 0 open questions
    const ws2 = await opportunityService.getScopeWorkspace({ ctx: ctxA, opportunityId: oppId })
    expect(ws2.ok).toBe(true)
    if (ws2.ok) {
      const completeness = ws2.completeness as { openQuestions: number }
      expect(completeness.openQuestions).toBe(0)
    }
  }, 30000)

  // ── Assumptions ──────────────────────────────────────────────────────────

  test('addAssumption and acknowledge it', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Assumption Test',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    const aResult = await opportunityService.addAssumption({
      ctx: ctxA, opportunityId: oppId, text: 'Assume no rock excavation',
      riskLevel: 'high',
    })
    expect(aResult.ok).toBe(true)
    if (!aResult.ok) return

    // Verify it's unacknowledged
    const before = await db.scopeAssumption.findUnique({ where: { id: aResult.assumptionId } })
    expect(before?.acknowledged).toBe(false)
    expect(before?.riskLevel).toBe('high')

    // Acknowledge it
    const ackResult = await opportunityService.acknowledgeAssumption({
      ctx: ctxA, opportunityId: oppId, assumptionId: aResult.assumptionId,
    })
    expect(ackResult.ok).toBe(true)

    const after = await db.scopeAssumption.findUnique({ where: { id: aResult.assumptionId } })
    expect(after?.acknowledged).toBe(true)
  }, 30000)

  // ── Evidence ─────────────────────────────────────────────────────────────

  test('addEvidence creates an evidence record', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Evidence Test',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    const eResult = await opportunityService.addEvidence({
      ctx: ctxA, opportunityId: oppId, type: 'rfq', summary: 'Client RFQ document',
      reference: 'RFQ-2024-001',
    })
    expect(eResult.ok).toBe(true)
    if (!eResult.ok) return

    const evidence = await db.scopeEvidence.findUnique({ where: { id: eResult.evidenceId } })
    expect(evidence?.type).toBe('rfq')
    expect(evidence?.summary).toBe('Client RFQ document')
    expect(evidence?.reference).toBe('RFQ-2024-001')
  }, 30000)

  test('addEvidence rejects invalid type', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Evidence Type Test',
    })
    if (!createResult.ok) return

    const result = await opportunityService.addEvidence({
      ctx: ctxA, opportunityId: createResult.opportunityId,
      type: 'invalid-type', summary: 'test',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  // ── Opportunity detail ───────────────────────────────────────────────────

  test('getOpportunityDetail returns full graph with scope package', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Detail Test', description: 'A test opportunity',
    })
    if (!createResult.ok) return
    const oppId = createResult.opportunityId

    // Add some scope content
    await opportunityService.addScopeItem({ ctx: ctxA, opportunityId: oppId, description: 'Item 1', status: 'known' })
    await opportunityService.addScopeQuestion({ ctx: ctxA, opportunityId: oppId, question: 'Q1?' })

    const result = await opportunityService.getOpportunityDetail({ ctx: ctxA, opportunityId: oppId })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const opp = result.opportunity as {
      title: string
      status: string
      scopePackage: { completeness: number; items: unknown[]; questions: unknown[]; assumptions: unknown[]; evidence: unknown[] } | null
      client: { name: string }
      auditLogs: unknown[]
    }

    expect(opp.title).toBe('Detail Test')
    expect(opp.status).toBe('received')
    expect(opp.scopePackage).not.toBeNull()
    expect(opp.scopePackage?.items.length).toBe(1)
    expect(opp.scopePackage?.questions.length).toBe(1)
    expect(opp.scopePackage?.completeness).toBe(1) // 1 known / 1 total
    expect(opp.client.name).toBe('Client A')
    expect(opp.auditLogs.length).toBeGreaterThan(0)
  }, 30000)

  // ── updateOpportunity ───────────────────────────────────────────────────

  test('updateOpportunity changes metadata', async () => {
    const createResult = await opportunityService.createOpportunity({
      ctx: ctxA, clientId: CLIENT_A, title: 'Original Title',
    })
    if (!createResult.ok) return

    const updateResult = await opportunityService.updateOpportunity({
      ctx: ctxA, opportunityId: createResult.opportunityId,
      title: 'Updated Title', location: 'Accra, Ghana',
    })
    expect(updateResult.ok).toBe(true)

    const opp = await db.opportunity.findUnique({ where: { id: createResult.opportunityId } })
    expect(opp?.title).toBe('Updated Title')
    expect(opp?.location).toBe('Accra, Ghana')
  }, 30000)
})
