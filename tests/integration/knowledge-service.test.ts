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
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  name: 'Test User A', email: 'a@kn-test.com',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  name: 'Test User B', email: 'b@kn-test.com',
}

describe('KnowledgeService integration tests', () => {
  beforeAll(async () => {
    // Clean up any leftover data
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
})
