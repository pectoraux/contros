/**
 * Programme schedule read service integration tests — against Neon PostgreSQL.
 *
 * Proves:
 *   1. Revision mode: finalized revision → deterministic ScheduleResult.
 *   2. Workspace mode: current mutable workspace → deterministic preview.
 *   3. Same snapshot → same ScheduleResult (determinism).
 *   4. Tenant isolation: Org B cannot read Org A's schedule.
 *   5. Revision does not change after workspace edits.
 *   6. Workspace preview changes after activity edit.
 *   7. Missing programme → 404.
 *   8. Non-finalized revision → 422.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-ps-org-a'
const ORG_B = 'test-ps-org-b'
const USER_A = 'test-ps-user-a'
const USER_B = 'test-ps-user-b'
const CLIENT_A = 'test-ps-client-a'
const OPP_A = 'test-ps-opp-a'
const PROG_A = 'test-ps-programme-a'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@ps.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@ps.test',
}

describe('Programme schedule read service integration tests', () => {
  let revisionId: string

  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-ps-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'PS Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@ps.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'PS Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@ps.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: 'test-ps-act-1', programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned' } })
    await db.activity.create({ data: { id: 'test-ps-act-2', programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned' } })
    await db.activityDependency.create({ data: { id: 'test-ps-dep-1', programmeId: PROG_A, predecessorActivityId: 'test-ps-act-1', successorActivityId: 'test-ps-act-2', type: 'FS', lag: 0 } })

    // Finalize a revision.
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    if (!res.ok) throw new Error(`Setup failed: ${res.error}`)
    revisionId = res.revisionId
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ps-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-ps-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Revision mode ─────────────────────────────────────────────────────

  test('revision mode: finalized revision → deterministic ScheduleResult', async () => {
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mode).toBe('revision')
    expect(res.revisionId).toBe(revisionId)
    expect(res.schedule.projectDuration).toBe(15) // 5 + 10 = 15 days
    expect(res.schedule.activities).toHaveLength(2)
    expect(res.schedule.criticalPath).toContain('test-ps-act-1')
    expect(res.schedule.criticalPath).toContain('test-ps-act-2')
    expect(res.schedule.hasCycle).toBe(false)
  }, 60000)

  // ── 2. Workspace mode ────────────────────────────────────────────────────

  test('workspace mode: current mutable workspace → deterministic preview', async () => {
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mode).toBe('workspace')
    expect(res.schedule.projectDuration).toBe(15)
    expect(res.schedule.activities).toHaveLength(2)
  }, 60000)

  // ── 3. Determinism ───────────────────────────────────────────────────────

  test('same revision → same ScheduleResult (determinism)', async () => {
    const res1 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId })
    const res2 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId })
    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)
    if (!res1.ok || !res2.ok) return
    expect(JSON.stringify(res1.schedule)).toBe(JSON.stringify(res2.schedule))
  }, 60000)

  // ── 4. Tenant isolation ──────────────────────────────────────────────────

  test('tenant isolation: Org B cannot read Org A schedule', async () => {
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxB, programmeId: PROG_A })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  test('tenant isolation: Org B cannot read Org A revision', async () => {
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxB, programmeId: PROG_A, revisionId })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 5. Revision does not change after workspace edits ────────────────────

  test('revision schedule does not change after workspace edits', async () => {
    const res1 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId })
    expect(res1.ok).toBe(true)

    // Edit the workspace.
    await db.activity.update({ where: { id: 'test-ps-act-1' }, data: { duration: 999 } })

    const res2 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId })
    expect(res2.ok).toBe(true)
    if (!res1.ok || !res2.ok) return
    // The revision's schedule is unchanged.
    expect(JSON.stringify(res1.schedule)).toBe(JSON.stringify(res2.schedule))

    // Restore.
    await db.activity.update({ where: { id: 'test-ps-act-1' }, data: { duration: 5 } })
  }, 60000)

  // ── 6. Workspace preview changes after edit ──────────────────────────────

  test('workspace preview changes after activity edit', async () => {
    const res1 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(res1.ok).toBe(true)

    await db.activity.update({ where: { id: 'test-ps-act-1' }, data: { duration: 20 } })

    const res2 = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(res2.ok).toBe(true)
    if (!res1.ok || !res2.ok) return
    // The workspace preview changed (different project duration).
    expect(res1.schedule.projectDuration).not.toBe(res2.schedule.projectDuration)
    // 20 + 10 = 30 days.
    expect(res2.schedule.projectDuration).toBe(30)

    // Restore.
    await db.activity.update({ where: { id: 'test-ps-act-1' }, data: { duration: 5 } })
  }, 60000)

  // ── 7. Missing programme → 404 ───────────────────────────────────────────

  test('missing programme → 404', async () => {
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: 'nonexistent' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 8. Non-finalized revision → 422 ──────────────────────────────────────

  test('non-finalized revision → 422', async () => {
    // Create a draft revision directly.
    const draftRev = await db.programmeRevision.create({
      data: { programmeId: PROG_A, revisionNo: 999, snapshotJson: '{}', snapshotContentHash: 'placeholder', scheduleEngineVersion: 1, status: 'draft', finalizedById: USER_A },
    })
    const res = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A, revisionId: draftRev.id })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/not finalized/i)
    await db.programmeRevision.delete({ where: { id: draftRev.id } })
  }, 60000)
}, 600000)
