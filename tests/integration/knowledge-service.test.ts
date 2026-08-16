/**
 * KnowledgeService integration tests — REAL adversarial tests with actual
 * Neon DB data.
 *
 * Run: bun test tests/integration/knowledge-service.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { knowledgeService } from '../../src/application/knowledge-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-kn-org-a'
const ORG_B = 'test-kn-org-b'
const USER_A = 'test-kn-user-a'
const USER_B = 'test-kn-user-b'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false, actorType: 'human',
  name: 'Test User A', email: 'a@kn-test.com',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false, actorType: 'human',
  name: 'Test User B', email: 'b@kn-test.com',
}

describe('KnowledgeService integration tests', () => {
  beforeAll(async () => {
    // Clean up any leftover data
    await db.calibrationProposal.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.productivityObservation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.resourcePriceObservation.deleteMany({ where: { resource: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.resource.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'KN Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@kn-test.com', role: 'estimator' } })

    await db.organization.create({ data: { id: ORG_B, name: 'KN Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@kn-test.com', role: 'estimator' } })
  }, 120000)

  afterAll(async () => {
    await db.calibrationProposal.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.productivityObservation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.resourcePriceObservation.deleteMany({ where: { resource: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.resource.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  beforeEach(async () => {
    await db.calibrationProposal.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.productivityObservation.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.resourcePriceObservation.deleteMany({ where: { resource: { organizationId: ORG_A } } }).catch(() => {})
    await db.knowledgeAlert.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: ORG_A } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.resource.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
  }, 30000)

  // ── Work Definition lifecycle ────────────────────────────────────────────

  test('createWorkDefinition creates a WD in draft state with audit', async () => {
    const result = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-STRUCT-001', name: 'Foundation Concrete', unit: 'm3',
      category: 'structural',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const wd = await db.workDefinition.findUnique({ where: { id: result.workDefinitionId } })
    expect(wd?.code).toBe('WD-STRUCT-001')
    expect(wd?.name).toBe('Foundation Concrete')
    expect(wd?.approvalState).toBe('draft')
    expect(wd?.organizationId).toBe(ORG_A)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'WorkDefinition', entityId: result.workDefinitionId },
    })
    expect(audit?.action).toBe('work-definition.created')
  }, 30000)

  test('createVersion creates a draft version with monotonic numbering', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-ROOF-001', name: 'Roofing Sheets', unit: 'm2',
    })
    if (!wdResult.ok) return

    const v1 = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 50,
    })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(v1.versionNo).toBe(1)

    const v2 = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 55,
    })
    expect(v2.ok).toBe(true)
    if (!v2.ok) return
    expect(v2.versionNo).toBe(2)

    // Verify both versions exist and are drafts
    const versions = await db.workDefinitionVersion.findMany({
      where: { workDefinitionId: wdResult.workDefinitionId },
      orderBy: { version: 'asc' },
    })
    expect(versions.length).toBe(2)
    expect(versions[0]?.version).toBe(1)
    expect(versions[0]?.approvalState).toBe('draft')
    expect(versions[1]?.version).toBe(2)
    expect(versions[1]?.approvalState).toBe('draft')
  }, 30000)

  test('approveVersion freezes a version as immutable + sets currentVersionId', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-MAS-001', name: 'Masonry Blockwork', unit: 'm2',
    })
    if (!wdResult.ok) return

    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', methodStatementFragment: 'Lay blocks in stretcher bond',
    })
    if (!vResult.ok) return

    const approveResult = await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(approveResult.ok).toBe(true)
    if (!approveResult.ok) return
    expect(approveResult.versionNo).toBe(1)

    // Verify the version is approved
    const version = await db.workDefinitionVersion.findUnique({
      where: { id: approveResult.versionId },
    })
    expect(version?.approvalState).toBe('approved')
    expect(version?.approvedAt).not.toBeNull()
    expect(version?.approvedById).toBe(USER_A)

    // Verify the WD is approved + currentVersionId is set
    const wd = await db.workDefinition.findUnique({
      where: { id: wdResult.workDefinitionId },
    })
    expect(wd?.approvalState).toBe('approved')
    expect(wd?.currentVersionId).toBe(approveResult.versionId)

    // Verify audit
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'work-definition.version-approved' },
    })
    expect(audit).not.toBeNull()
  }, 30000)

  // ── INVARIANT 4: Approved versions are immutable ──────────────────────────

  test('INVARIANT 4: approved version cannot be modified via approve (idempotent)', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-IMM-001', name: 'Immutability Test', unit: 'nr',
    })
    if (!wdResult.ok) return

    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '{"original":true}',
    })
    if (!vResult.ok) return

    // Approve
    const approve1 = await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })
    if (!approve1.ok) return

    // Approve again — should be idempotent (no error, no duplicate audit)
    const approve2 = await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      versionId: approve1.versionId,
    })
    expect(approve2.ok).toBe(true)

    // Verify only one audit log entry for approval
    const audits = await db.auditLog.findMany({
      where: { organizationId: ORG_A, action: 'work-definition.version-approved' },
    })
    expect(audits.length).toBe(1)
  }, 30000)

  test('INVARIANT 4: approved version snapshot is immutable — no update method exists', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-IMM-002', name: 'Snapshot Immutability', unit: 'm',
    })
    if (!wdResult.ok) return

    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '{"version":"original"}',
    })
    if (!vResult.ok) return

    const approveResult = await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })
    if (!approveResult.ok) return

    // Verify the snapshot is frozen — try to update it directly via the repo
    // (the repository does NOT expose an update method for approved versions,
    // but we verify the DB-level immutability by checking the snapshot is unchanged)
    const version = await db.workDefinitionVersion.findUnique({
      where: { id: approveResult.versionId },
    })
    expect(version?.costRecipeJson).toBe('{"version":"original"}')
    expect(version?.approvalState).toBe('approved')

    // Creating a new version (v2) does NOT change v1
    const v2Result = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '{"version":"updated"}',
    })
    if (!v2Result.ok) return

    const v1After = await db.workDefinitionVersion.findUnique({
      where: { id: approveResult.versionId },
    })
    expect(v1After?.costRecipeJson).toBe('{"version":"original"}') // unchanged
  }, 30000)

  // ── Deprecation ──────────────────────────────────────────────────────────

  test('deprecateWorkDefinition marks WD as deprecated (immutable history preserved)', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-DEP-001', name: 'Deprecation Test', unit: 'nr',
    })
    if (!wdResult.ok) return

    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    if (!vResult.ok) return
    await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })

    const depResult = await knowledgeService.deprecateWorkDefinition({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(depResult.ok).toBe(true)

    const wd = await db.workDefinition.findUnique({
      where: { id: wdResult.workDefinitionId },
    })
    expect(wd?.approvalState).toBe('deprecated')

    // Approved version is still there (immutable history)
    const versions = await db.workDefinitionVersion.findMany({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })
    expect(versions.length).toBe(1)
    expect(versions[0]?.approvalState).toBe('approved')
  }, 30000)

  // ── Cross-tenant isolation ────────────────────────────────────────────────

  test('Org B cannot list Org A WorkDefinitions', async () => {
    await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CT-001', name: 'Org A Secret WD', unit: 'm2',
    })

    const result = await knowledgeService.listWorkDefinitions({ ctx: ctxB })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const wds = result.workDefinitions as { code: string }[]
    expect(wds.find((w) => w.code === 'WD-CT-001')).toBeUndefined()
  }, 30000)

  test('Org B cannot get Org A WorkDefinition', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CT-002', name: 'Org A WD', unit: 'm2',
    })
    if (!wdResult.ok) return

    const result = await knowledgeService.getWorkDefinition({
      ctx: ctxB, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  }, 30000)

  test('Org B cannot create version on Org A WorkDefinition', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CT-003', name: 'Org A WD 3', unit: 'm2',
    })
    if (!wdResult.ok) return

    const result = await knowledgeService.createVersion({
      ctx: ctxB, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    // Verify no version was created
    const versions = await db.workDefinitionVersion.findMany({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })
    expect(versions.length).toBe(0)
  }, 30000)

  test('Org B cannot approve Org A WorkDefinition version', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CT-004', name: 'Org A WD 4', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    if (!vResult.ok) return

    const result = await knowledgeService.approveVersion({
      ctx: ctxB, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    // Verify version is still draft (not approved)
    const version = await db.workDefinitionVersion.findFirst({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })
    expect(version?.approvalState).toBe('draft')
  }, 30000)

  // ── Resources + Price Observations ────────────────────────────────────────

  test('createResource creates a resource with audit', async () => {
    const result = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-MAT-CEM', name: 'Cement', unit: 'bag', kind: 'material',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const resource = await db.resource.findUnique({ where: { id: result.resourceId } })
    expect(resource?.code).toBe('RES-MAT-CEM')
    expect(resource?.kind).toBe('material')
    expect(resource?.organizationId).toBe(ORG_A)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'Resource', entityId: result.resourceId },
    })
    expect(audit?.action).toBe('resource.created')
  }, 30000)

  test('createResource rejects invalid kind', async () => {
    const result = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-BAD', name: 'Bad', unit: 'nr', kind: 'invalid-kind',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  test('recordPriceObservation creates an append-only observation with provenance', async () => {
    // Create a resource first
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-LAB-MAS', name: 'Mason Labour', unit: 'day', kind: 'labour',
    })
    if (!resResult.ok) return

    const obsResult = await knowledgeService.recordPriceObservation({
      ctx: ctxA, resourceId: resResult.resourceId,
      price: 150, provenance: 'supplier-quote', sourceReference: 'Q-2024-001',
    })
    expect(obsResult.ok).toBe(true)
    if (!obsResult.ok) return

    const obs = await db.resourcePriceObservation.findUnique({
      where: { id: obsResult.observationId },
    })
    expect(obs?.price).toBe(150)
    expect(obs?.provenance).toBe('supplier-quote')
    expect(obs?.sourceReference).toBe('Q-2024-001')
    expect(obs?.recordedById).toBe(USER_A)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'resource.price-observed' },
    })
    expect(audit).not.toBeNull()
  }, 30000)

  test('recordPriceObservation rejects invalid provenance', async () => {
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-BAD-OBS', name: 'Bad Obs', unit: 'nr', kind: 'material',
    })
    if (!resResult.ok) return

    const result = await knowledgeService.recordPriceObservation({
      ctx: ctxA, resourceId: resResult.resourceId,
      price: 100, provenance: 'invalid-provenance',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  test('Org B cannot record price observation on Org A resource', async () => {
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-CT-001', name: 'Cross-tenant Resource', unit: 'nr', kind: 'material',
    })
    if (!resResult.ok) return

    const result = await knowledgeService.recordPriceObservation({
      ctx: ctxB, resourceId: resResult.resourceId,
      price: 999, provenance: 'supplier-quote',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    // Verify no observation was created
    const obs = await db.resourcePriceObservation.findMany({
      where: { resourceId: resResult.resourceId },
    })
    expect(obs.length).toBe(0)
  }, 30000)

  // ── Knowledge Alerts ─────────────────────────────────────────────────────

  test('listKnowledgeAlerts returns org-scoped alerts', async () => {
    // Create alerts in both orgs directly
    await db.knowledgeAlert.create({
      data: { organizationId: ORG_A, type: 'stale-price', severity: 'warning', title: 'Org A Alert' },
    })
    await db.knowledgeAlert.create({
      data: { organizationId: ORG_B, type: 'stale-price', severity: 'warning', title: 'Org B Alert' },
    })

    const result = await knowledgeService.listKnowledgeAlerts({ ctx: ctxA })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const alerts = result.alerts as { title: string }[]
    expect(alerts.find((a) => a.title === 'Org A Alert')).toBeDefined()
    expect(alerts.find((a) => a.title === 'Org B Alert')).toBeUndefined()

    // Cleanup
    await db.knowledgeAlert.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  }, 30000)

  test('acknowledgeAlert marks alert as acknowledged + audit', async () => {
    const alert = await db.knowledgeAlert.create({
      data: { organizationId: ORG_A, type: 'unapproved-rate', severity: 'blocker', title: 'Test Alert' },
    })

    const result = await knowledgeService.acknowledgeAlert({ ctx: ctxA, alertId: alert.id })
    expect(result.ok).toBe(true)

    const updated = await db.knowledgeAlert.findUnique({ where: { id: alert.id } })
    expect(updated?.acknowledged).toBe(true)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'knowledge-alert.acknowledged', entityId: alert.id },
    })
    expect(audit).not.toBeNull()
  }, 30000)

  test('Org B cannot acknowledge Org A alert', async () => {
    const alert = await db.knowledgeAlert.create({
      data: { organizationId: ORG_A, type: 'stale-price', severity: 'warning', title: 'Org A Only' },
    })

    const result = await knowledgeService.acknowledgeAlert({ ctx: ctxB, alertId: alert.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)

    const updated = await db.knowledgeAlert.findUnique({ where: { id: alert.id } })
    expect(updated?.acknowledged).toBe(false)
  }, 30000)

  // ── Validation ───────────────────────────────────────────────────────────

  test('createWorkDefinition rejects missing required fields', async () => {
    const result = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: '', name: 'Missing Code', unit: 'm2',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  test('createVersion rejects missing costRecipeJson', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-VAL-001', name: 'Validation Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const result = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  test('approveVersion with no draft returns 400', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-VAL-002', name: 'No Draft Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    // No version created — try to approve
    const result = await knowledgeService.approveVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  }, 30000)

  // ── Transaction rollback ─────────────────────────────────────────────────

  test('P0: WorkDefinition version insert rolls back when audit log fails', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-RB-001', name: 'Rollback Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const versionCountBefore = await db.workDefinitionVersion.count({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })

    // Force a transaction failure by using an invalid actorId
    const { dbTx } = await import('../../src/lib/db')
    const { workDefinitionRepository, workDefinitionVersionRepository, auditLogRepository } = await import('../../src/repositories')

    let threw = false
    try {
      await dbTx.$transaction(async (tx) => {
        const latestVersionNo = await workDefinitionRepository.getLatestVersionNumberInTransaction(
          tx, ORG_A, wdResult.workDefinitionId,
        )
        const version = await workDefinitionVersionRepository.createDraftInTransaction(
          tx, ORG_A, wdResult.workDefinitionId,
          { version: latestVersionNo + 1, costRecipeJson: '[]' },
        )
        if (!version) throw new Error('version creation failed')

        // This will fail: non-existent actorId violates FK
        await auditLogRepository.createInTransaction(tx, ORG_A, 'nonexistent-user-id', {
          action: 'work-definition.version-created',
          entityType: 'WorkDefinitionVersion',
          entityId: version.id,
          summary: 'This should roll back',
        })
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)

    const versionCountAfter = await db.workDefinitionVersion.count({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })
    expect(versionCountAfter).toBe(versionCountBefore) // rolled back
  }, 30000)

  // ── Actor policy (INVARIANT 5: AI cannot commit) ─────────────────────────

  test('INVARIANT 5: AI actor cannot approveVersion', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-AI-001', name: 'AI Actor Test', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    if (!vResult.ok) return

    // Create an AI actor context
    const ctxAI: RequestContext = { ...ctxA, actorType: 'ai' }

    const result = await knowledgeService.approveVersion({
      ctx: ctxAI, workDefinitionId: wdResult.workDefinitionId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('human actor')
    }

    // Verify the version is still draft (not approved)
    const version = await db.workDefinitionVersion.findFirst({
      where: { workDefinitionId: wdResult.workDefinitionId },
    })
    expect(version?.approvalState).toBe('draft')
  }, 30000)

  test('INVARIANT 5: AI actor cannot recordPriceObservation', async () => {
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-AI-001', name: 'AI Price Test', unit: 'bag', kind: 'material',
    })
    if (!resResult.ok) return

    const ctxAI: RequestContext = { ...ctxA, actorType: 'ai' }

    const result = await knowledgeService.recordPriceObservation({
      ctx: ctxAI, resourceId: resResult.resourceId,
      price: 100, provenance: 'supplier-quote',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('human actor')
    }

    // Verify no observation was created
    const obs = await db.resourcePriceObservation.findMany({
      where: { resourceId: resResult.resourceId },
    })
    expect(obs.length).toBe(0)
  }, 30000)

  test('INVARIANT 5: AI actor cannot recordProductivityObservation', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-AI-PROD', name: 'AI Prod Test', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 50,
    })
    if (!vResult.ok) return

    const ctxAI: RequestContext = { ...ctxA, actorType: 'ai' }

    const result = await knowledgeService.recordProductivityObservation({
      ctx: ctxAI, workDefinitionVersionId: vResult.versionId,
      quantityCompleted: 100, daysTaken: 2, crewSize: 5, plannedProductivity: 50,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
    }
  }, 30000)

  test('INVARIANT 5: AI actor CAN create calibration proposals (suggest, not commit)', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-AI-PROP', name: 'AI Proposal Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const ctxAI: RequestContext = { ...ctxA, actorType: 'ai' }

    const result = await knowledgeService.createCalibrationProposal({
      ctx: ctxAI, workDefinitionId: wdResult.workDefinitionId,
      type: 'productivity-update',
      currentValue: '50', proposedValue: '55',
      rationale: 'AI detected consistent productivity improvement in recent bids',
    })
    expect(result.ok).toBe(true)
  }, 30000)

  test('INVARIANT 5: AI actor cannot reviewCalibrationProposal', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-AI-REV', name: 'AI Review Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    // AI creates a proposal
    const ctxAI: RequestContext = { ...ctxA, actorType: 'ai' }
    const propResult = await knowledgeService.createCalibrationProposal({
      ctx: ctxAI, workDefinitionId: wdResult.workDefinitionId,
      type: 'price-update', currentValue: '100', proposedValue: '110',
      rationale: 'Price increase observed',
    })
    if (!propResult.ok) return

    // AI tries to approve it — should fail
    const reviewResult = await knowledgeService.reviewCalibrationProposal({
      ctx: ctxAI, proposalId: propResult.proposalId, decision: 'approved',
    })
    expect(reviewResult.ok).toBe(false)
    if (!reviewResult.ok) {
      expect(reviewResult.status).toBe(403)
    }

    // Human CAN approve it
    const humanReview = await knowledgeService.reviewCalibrationProposal({
      ctx: ctxA, proposalId: propResult.proposalId, decision: 'approved',
    })
    expect(humanReview.ok).toBe(true)
  }, 30000)

  // ── Productivity observations ────────────────────────────────────────────

  test('recordProductivityObservation computes variance and persists', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-PROD-001', name: 'Productivity Test', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 50, // 50 m2 per crew-day
    })
    if (!vResult.ok) return

    // Record: 100 m2 completed in 3 days with 5-person crew
    // crew-days = 3 × 5 = 15 crew-days
    // actualProductivity = 100 / 15 = 6.67 m2/crew-day (planned 50)
    // variance = (6.67 - 50) / 50 = -0.867 (much worse than planned)
    const result = await knowledgeService.recordProductivityObservation({
      ctx: ctxA, workDefinitionVersionId: vResult.versionId,
      quantityCompleted: 100, daysTaken: 3, crewSize: 5,
      plannedProductivity: 50,
      sourceReference: 'Project ABC',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.variancePct).toBeLessThan(0) // worse than planned

    const obs = await db.productivityObservation.findUnique({
      where: { id: result.observationId },
    })
    expect(obs?.actualProductivity).toBeCloseTo(100 / (3 * 5), 2) // 100 / 15 crew-days = 6.67
    expect(obs?.plannedProductivity).toBe(50)
    expect(obs?.organizationId).toBe(ORG_A)
    expect(obs?.recordedById).toBe(USER_A)
  }, 30000)

  test('recordProductivityObservation uses crew-day calculation (quantity / days × crewSize)', async () => {
    // P0 fix: productivity = quantity / (days × crewSize), NOT quantity / days.
    // Example from reviewer: 120 m², 4 days, 3-person crew → 10 m²/crew-day (NOT 30 m²/day)
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CREW-001', name: 'Crew-Day Test', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 10, // 10 m2/crew-day
    })
    if (!vResult.ok) return

    // 120 m2, 4 days, 3-person crew → crew-days = 12, actual = 120/12 = 10
    const result = await knowledgeService.recordProductivityObservation({
      ctx: ctxA, workDefinitionVersionId: vResult.versionId,
      quantityCompleted: 120, daysTaken: 4, crewSize: 3,
      plannedProductivity: 10,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const obs = await db.productivityObservation.findUnique({
      where: { id: result.observationId },
    })
    // actualProductivity = 120 / (4 × 3) = 10 m²/crew-day
    expect(obs?.actualProductivity).toBeCloseTo(10, 2)
    // variance = (10 - 10) / 10 = 0 (on target)
    expect(obs?.variancePct).toBeCloseTo(0, 2)
  }, 30000)

  // ── Knowledge health engine ──────────────────────────────────────────────

  test('generateHealthAlerts detects stale prices', async () => {
    // Create a resource + price observation that's old
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-STALE-001', name: 'Stale Price Resource', unit: 'bag', kind: 'material',
    })
    if (!resResult.ok) return

    // Insert a price observation with an old date directly
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 120) // 120 days ago (> 90 threshold)
    await db.resourcePriceObservation.create({
      data: {
        resourceId: resResult.resourceId,
        price: 25, provenance: 'supplier-quote',
        observedAt: oldDate,
      },
    })

    const result = await knowledgeService.generateHealthAlerts({ ctx: ctxA, persist: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const staleAlerts = result.alerts.filter((a) => a.type === 'stale-price')
    expect(staleAlerts.length).toBeGreaterThan(0)
    const matching = staleAlerts.find((a) => a.entityId === resResult.resourceId)
    expect(matching).toBeDefined()
    expect(matching?.severity).toBe('warning')
  }, 30000)

  test('generateHealthAlerts does NOT alert on unused draft WDV (no EstimateLine reference)', async () => {
    // Create a WD with a draft version (not approved) but NO estimate line referencing it.
    // This should NOT generate an unapproved-rate alert — the detector scans
    // actual EstimateLine → WDV usage, not all WDVs.
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-UNUSED-001', name: 'Unused Draft WD', unit: 'm2',
    })
    if (!wdResult.ok) return
    await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    // Version is draft — but NOT referenced by any estimate line.

    const result = await knowledgeService.generateHealthAlerts({ ctx: ctxA, persist: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const matching = result.alerts.find(
      (a) => a.type === 'unapproved-rate' && a.title.includes('WD-UNUSED-001'),
    )
    expect(matching).toBeUndefined() // no alert for unused draft
  }, 30000)

  test('generateHealthAlerts DOES alert on draft WDV referenced by EstimateLine', async () => {
    // Create a WD + draft version, then create an estimate line that references it.
    // This SHOULD generate an unapproved-rate blocker.
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-USED-001', name: 'Used Draft WD', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]',
    })
    if (!vResult.ok) return

    // Create an opportunity + estimate + estimate line referencing this draft WDV
    const client = await db.client.create({
      data: { organizationId: ORG_A, name: 'Test Client UNAPP' },
    })
    const opp = await db.opportunity.create({
      data: { organizationId: ORG_A, clientId: client.id, title: 'UNAPP Test Opp', status: 'estimating' },
    })
    await db.scopePackage.create({ data: { opportunityId: opp.id, completeness: 0, origin: 'rfq' } })
    const estimate = await db.estimate.create({
      data: { organizationId: ORG_A, opportunityId: opp.id, status: 'draft' },
    })
    await db.estimateLine.create({
      data: {
        estimateId: estimate.id,
        workDefinitionId: wdResult.workDefinitionId,
        workDefinitionVersionId: vResult.versionId,
        description: 'Line referencing draft WDV',
        quantity: 100, unit: 'm2',
        executionStrategy: 'self-perform',
        calculationStatus: 'complete',
      },
    })

    const result = await knowledgeService.generateHealthAlerts({ ctx: ctxA, persist: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const unapprovedAlerts = result.alerts.filter((a) => a.type === 'unapproved-rate')
    expect(unapprovedAlerts.length).toBeGreaterThan(0)
    const matching = unapprovedAlerts.find((a) => a.title.includes('WD-USED-001'))
    expect(matching).toBeDefined()
    expect(matching?.severity).toBe('blocker')

    // Cleanup
    await db.estimateLine.deleteMany({ where: { estimateId: estimate.id } })
    await db.estimate.deleteMany({ where: { id: estimate.id } })
    await db.scopePackage.deleteMany({ where: { opportunityId: opp.id } })
    await db.opportunity.deleteMany({ where: { id: opp.id } })
    await db.client.deleteMany({ where: { id: client.id } })
  }, 45000)

  test('generateHealthAlerts detects productivity variance', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-VAR-001', name: 'Variance Test', unit: 'm2',
    })
    if (!wdResult.ok) return
    const vResult = await knowledgeService.createVersion({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      costRecipeJson: '[]', productivityRule: 50,
    })
    if (!vResult.ok) return

    // Record an observation with >25% variance (blocker threshold).
    // 120 m2, 3 days, 4-person crew → crew-days = 12
    // actual = 120/12 = 10 m2/crew-day vs 50 planned = -80% variance (blocker)
    await knowledgeService.recordProductivityObservation({
      ctx: ctxA, workDefinitionVersionId: vResult.versionId,
      quantityCompleted: 120, daysTaken: 3, crewSize: 4, // 10 m2/crew-day vs 50 planned = -80%
      plannedProductivity: 50,
    })

    const result = await knowledgeService.generateHealthAlerts({ ctx: ctxA, persist: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const varAlerts = result.alerts.filter((a) => a.type === 'productivity-variance')
    expect(varAlerts.length).toBeGreaterThan(0)
    const matching = varAlerts.find((a) => a.entityId === vResult.versionId)
    expect(matching).toBeDefined()
    expect(matching?.severity).toBe('blocker') // 30% > 25% threshold
  }, 30000)

  test('generateHealthAlerts persist=true creates KnowledgeAlert records', async () => {
    // Create a stale price
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-PERSIST-001', name: 'Persist Test', unit: 'bag', kind: 'material',
    })
    if (!resResult.ok) return
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 120)
    await db.resourcePriceObservation.create({
      data: {
        resourceId: resResult.resourceId,
        price: 30, provenance: 'supplier-quote',
        observedAt: oldDate,
      },
    })

    const result = await knowledgeService.generateHealthAlerts({ ctx: ctxA, persist: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.persisted).toBeGreaterThan(0)

    // Verify alerts were persisted to the DB
    const alerts = await db.knowledgeAlert.findMany({
      where: { organizationId: ORG_A, type: 'stale-price' },
    })
    expect(alerts.length).toBeGreaterThan(0)

    // Verify audit log
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'knowledge-health.alerts-generated' },
    })
    expect(audit).not.toBeNull()

    // Cleanup
    await db.knowledgeAlert.deleteMany({ where: { organizationId: ORG_A } })
  }, 30000)

  // ── Calibration proposals ────────────────────────────────────────────────

  test('createCalibrationProposal creates a pending proposal (no auto-mutate)', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CAL-001', name: 'Calibration Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const result = await knowledgeService.createCalibrationProposal({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      type: 'productivity-update',
      currentValue: '50', proposedValue: '55',
      rationale: 'Observed 10% productivity improvement in recent projects',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const proposal = await db.calibrationProposal.findUnique({
      where: { id: result.proposalId },
    })
    expect(proposal?.status).toBe('pending')
    expect(proposal?.type).toBe('productivity-update')
    expect(proposal?.currentValue).toBe('50')
    expect(proposal?.proposedValue).toBe('55')
    expect(proposal?.organizationId).toBe(ORG_A)

    // INVARIANT 4: the WorkDefinition is NOT mutated by the proposal
    const wd = await db.workDefinition.findUnique({
      where: { id: wdResult.workDefinitionId },
    })
    expect(wd?.approvalState).toBe('draft') // unchanged
  }, 30000)

  test('reviewCalibrationProposal approves and records reviewer', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CAL-002', name: 'Review Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const propResult = await knowledgeService.createCalibrationProposal({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      type: 'price-update', currentValue: '100', proposedValue: '110',
      rationale: 'Supplier price increase',
    })
    if (!propResult.ok) return

    const reviewResult = await knowledgeService.reviewCalibrationProposal({
      ctx: ctxA, proposalId: propResult.proposalId, decision: 'approved',
    })
    expect(reviewResult.ok).toBe(true)

    const proposal = await db.calibrationProposal.findUnique({
      where: { id: propResult.proposalId },
    })
    expect(proposal?.status).toBe('approved')
    expect(proposal?.reviewedById).toBe(USER_A)
    expect(proposal?.reviewedAt).not.toBeNull()
  }, 30000)

  test('reviewCalibrationProposal rejects already-reviewed proposal', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CAL-003', name: 'Double Review Test', unit: 'm2',
    })
    if (!wdResult.ok) return

    const propResult = await knowledgeService.createCalibrationProposal({
      ctx: ctxA, workDefinitionId: wdResult.workDefinitionId,
      type: 'method-update', currentValue: 'old', proposedValue: 'new',
      rationale: 'Method improvement',
    })
    if (!propResult.ok) return

    // First review — approved
    await knowledgeService.reviewCalibrationProposal({
      ctx: ctxA, proposalId: propResult.proposalId, decision: 'approved',
    })

    // Second review — should fail (already reviewed)
    const result = await knowledgeService.reviewCalibrationProposal({
      ctx: ctxA, proposalId: propResult.proposalId, decision: 'rejected',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('already been reviewed')
    }
  }, 30000)

  test('Org B cannot create calibration proposal on Org A WorkDefinition', async () => {
    const wdResult = await knowledgeService.createWorkDefinition({
      ctx: ctxA, code: 'WD-CAL-CT', name: 'Cross-tenant Cal', unit: 'm2',
    })
    if (!wdResult.ok) return

    const result = await knowledgeService.createCalibrationProposal({
      ctx: ctxB, workDefinitionId: wdResult.workDefinitionId,
      type: 'price-update', currentValue: '100', proposedValue: '110',
      rationale: 'Cross-tenant attempt',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  }, 30000)

  // ── Price semantics (INVARIANT 6) ────────────────────────────────────────

  test('INVARIANT 6: recordPriceObservation rounds price to 2 decimal places', async () => {
    const resResult = await knowledgeService.createResource({
      ctx: ctxA, code: 'RES-RND-001', name: 'Rounding Test', unit: 'bag', kind: 'material',
    })
    if (!resResult.ok) return

    // 123.456 should be rounded to 123.46 (banker's rounding)
    const result = await knowledgeService.recordPriceObservation({
      ctx: ctxA, resourceId: resResult.resourceId,
      price: 123.456, provenance: 'supplier-quote',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const obs = await db.resourcePriceObservation.findUnique({
      where: { id: result.observationId },
    })
    expect(obs?.price).toBe(123.46) // rounded via round2
  }, 30000)
})
