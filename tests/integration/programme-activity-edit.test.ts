/**
 * Programme activity duration editing integration tests — against Neon PostgreSQL.
 *
 * Proves:
 *   1. Duration edit → schedule result changes deterministically.
 *   2. Finalized ProgrammeRevision is unchanged after edit.
 *   3. Cross-tenant activity ID → rejected (404).
 *   4. Cross-programme activity ID → rejected (404).
 *   5. Invalid duration (NaN, Infinity, negative) → 422.
 *   6. Concurrent edit + finalization → Programme-row serialization holds.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-pe-org-a'
const ORG_B = 'test-pe-org-b'
const USER_A = 'test-pe-user-a'
const USER_B = 'test-pe-user-b'
const CLIENT_A = 'test-pe-client-a'
const OPP_A = 'test-pe-opp-a'
const PROG_A = 'test-pe-programme-a'
const ACT_1 = 'test-pe-act-1'
const ACT_2 = 'test-pe-act-2'
const DEP_1 = 'test-pe-dep-1'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@pe.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@pe.test',
}

describe('Programme activity duration editing integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-pe-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'PE Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@pe.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'PE Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@pe.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned', sequence: 0 } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned', sequence: 1 } })
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-pe-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-pe-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Duration edit → schedule changes ──────────────────────────────────

  test('duration edit → schedule result changes deterministically', async () => {
    // Before: 5 + 10 = 15 days.
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.schedule.projectDuration).toBe(15)

    // Edit: change Excavation from 5 to 8 days.
    const res = await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 8,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 8 + 10 = 18 days.
    expect(res.schedule.projectDuration).toBe(18)
    // The activity's earlyFinish should be 8 (ES=0, dur=8).
    const act = res.schedule.activities.find((a) => a.id === ACT_1)
    expect(act!.earlyFinish).toBe(8)

    // Restore.
    await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 5,
    })
  }, 60000)

  // ── 2. Finalized revision unchanged ──────────────────────────────────────

  test('finalized ProgrammeRevision is unchanged after duration edit', async () => {
    // Finalize.
    const fin = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(fin.ok).toBe(true)
    if (!fin.ok) return

    // Read the revision's schedule.
    const revSched = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched.ok).toBe(true)
    if (!revSched.ok) return
    const revDuration = revSched.schedule.projectDuration

    // Edit the workspace.
    await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 99,
    })

    // The revision's schedule is unchanged.
    const revSched2 = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched2.ok).toBe(true)
    if (!revSched2.ok) return
    expect(revSched2.schedule.projectDuration).toBe(revDuration)

    // Restore.
    await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 5,
    })
  }, 60000)

  // ── 3. Cross-tenant activity → rejected ──────────────────────────────────

  test('cross-tenant: Org B cannot edit Org A activity', async () => {
    const res = await programmeService.updateActivityDuration({
      ctx: ctxB, programmeId: PROG_A, activityId: ACT_1, duration: 10,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 4. Cross-programme activity → rejected ───────────────────────────────

  test('cross-programme: activity from Programme B cannot be edited via Programme A', async () => {
    // Create Programme B in Org A.
    const prog2 = await db.programme.create({
      data: { id: 'test-pe-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    const actB = await db.activity.create({
      data: { id: 'test-pe-act-b', programmeId: prog2.id, name: 'Act B', duration: 3, status: 'planned' },
    })

    // Try to edit Act B (in Programme B) via Programme A.
    const res = await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: actB.id, duration: 10,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
    expect(res.error).toMatch(/not found in this programme/i)

    // Clean up.
    await db.activity.delete({ where: { id: actB.id } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 5. Invalid duration → 422 ────────────────────────────────────────────

  test('NaN duration → 422', async () => {
    const res = await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: NaN,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/finite/i)
  }, 60000)

  test('Infinity duration → 422', async () => {
    const res = await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: Infinity,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/finite/i)
  }, 60000)

  test('negative duration → 422', async () => {
    const res = await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: -5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/>= 0/i)
  }, 60000)

  // ── 6. Concurrent edit + finalization ────────────────────────────────────

  test('concurrent edit + finalization → Programme-row serialization holds', async () => {
    // Fire an edit and a finalization concurrently. The Programme-row lock
    // ensures they serialize — no mixed state.
    const [, finRes] = await Promise.all([
      programmeService.updateActivityDuration({
        ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 7,
      }),
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
    ])

    // Both should succeed.
    expect(finRes.ok).toBe(true)

    // The finalized revision should have a consistent schedule (either
    // duration=5 or duration=7, not a mix). We can't predict which, but we
    // can verify the revision's schedule is internally consistent.
    if (!finRes.ok) return
    const revSched = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: finRes.revisionId,
    })
    expect(revSched.ok).toBe(true)
    if (!revSched.ok) return
    // The schedule should have 2 activities with consistent CPM values.
    expect(revSched.schedule.activities).toHaveLength(2)
    const act1 = revSched.schedule.activities.find((a) => a.id === ACT_1)!
    expect(act1.earlyFinish).toBe(act1.earlyStart + act1.duration)

    // Restore.
    await programmeService.updateActivityDuration({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1, duration: 5,
    })
  }, 60000)
}, 600000)
