/**
 * Programme activity rename + ordering integration tests — against Neon PostgreSQL.
 *
 * R1 — Activity rename + explicit ordering. `sequence` is a mutable
 * PRESENTATION property, NOT a scheduling input. The CPM engine receives
 * activities by identity + dependency graph; sequence only affects display
 * order and snapshot determinism. Ordering is NOT scheduling.
 *
 * Proves:
 *   1. Rename → name changes, schedule UNCHANGED.
 *   2. Reorder (swap-on-set) → sequences swap, schedule UNCHANGED.
 *   3. Reorder to unoccupied sequence → sequence changes, schedule UNCHANGED.
 *   4. Invalid sequence (NaN, negative, non-integer) → 422.
 *   5. Empty name → 422.
 *   6. Neither name nor sequence → 422.
 *   7. Cross-tenant → 404.
 *   8. Cross-programme → 404.
 *   9. Finalized revision unchanged after rename/reorder.
 *  10. Concurrent activity edit + finalization → serialized by Programme lock.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-ar-org-a'
const ORG_B = 'test-ar-org-b'
const USER_A = 'test-ar-user-a'
const USER_B = 'test-ar-user-b'
const CLIENT_A = 'test-ar-client-a'
const OPP_A = 'test-ar-opp-a'
const PROG_A = 'test-ar-programme-a'
const ACT_1 = 'test-ar-act-1' // Excavation (5d, seq 0)
const ACT_2 = 'test-ar-act-2' // Foundation (10d, seq 1)
const ACT_3 = 'test-ar-act-3' // Structure (20d, seq 2)
const DEP_1 = 'test-ar-dep-1' // FS: ACT_1 → ACT_2 (lag 0)
const DEP_2 = 'test-ar-dep-2' // FS: ACT_2 → ACT_3 (lag 0)

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@ar.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@ar.test',
}

describe('Programme activity rename + ordering integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-ar-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'AR Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@ar.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'AR Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@ar.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned', sequence: 0 } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned', sequence: 1 } })
    await db.activity.create({ data: { id: ACT_3, programmeId: PROG_A, name: 'Structure', duration: 20, status: 'planned', sequence: 2 } })
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
    await db.activityDependency.create({ data: { id: DEP_2, programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-ar-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-ar-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Rename → schedule UNCHANGED ───────────────────────────────────────

  test('rename activity → name changes, schedule UNCHANGED', async () => {
    // Before: duration = 5+10+20 = 35 (FS chain).
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    const beforeDur = before.schedule.projectDuration
    const beforeAct1Name = before.schedule.activities[0].name

    // Rename ACT_1.
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: 'Site Clearance',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Name changed.
    expect(res.schedule.activities[0].name).toBe('Site Clearance')
    // Schedule UNCHANGED — ordering is NOT scheduling.
    expect(res.schedule.projectDuration).toBe(beforeDur)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: beforeAct1Name,
    })
  }, 60000)

  // ── 2. Reorder (swap-on-set) → sequences swap, schedule UNCHANGED ────────

  test('reorder: set ACT_1 sequence to 1 (occupied by ACT_2) → swap', async () => {
    // Before: ACT_1=seq0, ACT_2=seq1, ACT_3=seq2.
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    const beforeDur = before.schedule.projectDuration

    // Set ACT_1's sequence to 1 (occupied by ACT_2). Swap-on-set:
    // ACT_1 gets seq1, ACT_2 gets ACT_1's old seq0.
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: 1,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Verify sequences swapped.
    const act1 = await db.activity.findUnique({ where: { id: ACT_1 } })
    const act2 = await db.activity.findUnique({ where: { id: ACT_2 } })
    expect(act1!.sequence).toBe(1)
    expect(act2!.sequence).toBe(0)

    // Schedule UNCHANGED — ordering is NOT scheduling.
    expect(res.schedule.projectDuration).toBe(beforeDur)

    // Restore: swap back by setting ACT_1 to 0 (now occupied by ACT_2).
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: 0,
    })
  }, 60000)

  // ── 3. Reorder to unoccupied sequence → sequence changes ─────────────────

  test('reorder: set ACT_3 sequence to 10 (unoccupied) → sequence changes', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_3,
      sequence: 10,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const act3 = await db.activity.findUnique({ where: { id: ACT_3 } })
    expect(act3!.sequence).toBe(10)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_3,
      sequence: 2,
    })
  }, 60000)

  // ── 4. Invalid sequence → 422 ────────────────────────────────────────────

  test('NaN sequence → 422', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: NaN,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  test('negative sequence → 422', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: -1,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  test('non-integer sequence (1.5) → 422', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: 1.5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 5. Empty name → 422 ──────────────────────────────────────────────────

  test('empty name → 422', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: '   ',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 6. Neither name nor sequence → 422 ───────────────────────────────────

  test('neither name nor sequence → 422', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/at least one/i)
  }, 60000)

  // ── 7. Cross-tenant → 404 ────────────────────────────────────────────────

  test('cross-tenant: Org B cannot rename Org A activity → 404', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxB, programmeId: PROG_A, activityId: ACT_1,
      name: 'Hacked',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 8. Cross-programme → 404 ─────────────────────────────────────────────

  test('cross-programme: activity from Programme B → 404', async () => {
    const prog2 = await db.programme.create({
      data: { id: 'test-ar-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    await db.activity.create({
      data: { id: 'test-ar-act-b1', programmeId: prog2.id, name: 'B1', duration: 3, status: 'planned', sequence: 0 },
    })

    // Attempt: update Programme B's activity via Programme A's context.
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: 'test-ar-act-b1',
      name: 'Hacked',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // Clean up.
    await db.activity.delete({ where: { id: 'test-ar-act-b1' } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 9. Finalized revision unchanged ──────────────────────────────────────

  test('finalized ProgrammeRevision unchanged after rename/reorder', async () => {
    // Finalize the current workspace.
    const fin = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(fin.ok).toBe(true)
    if (!fin.ok) return

    // Read the revision's schedule.
    const revSched = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched.ok).toBe(true)
    if (!revSched.ok) return
    const revDur = revSched.schedule.projectDuration
    const revAct1Name = revSched.schedule.activities[0].name

    // Rename + reorder the workspace.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: 'Changed Name', sequence: 2,
    })

    // The revision's schedule is unchanged.
    const revSched2 = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched2.ok).toBe(true)
    if (!revSched2.ok) return
    expect(revSched2.schedule.projectDuration).toBe(revDur)
    expect(revSched2.schedule.activities[0].name).toBe(revAct1Name)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: 'Excavation', sequence: 0,
    })
  }, 60000)

  // ── 10. Concurrent activity edit + finalization → serialized ─────────────

  test('concurrent activity edit + finalization → serialized by Programme lock', async () => {
    const [editRes, finalizeRes] = await Promise.all([
      programmeService.updateActivity({
        ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
        name: 'Concurrent Rename',
      }),
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
    ])

    // Both should succeed.
    expect(editRes.ok).toBe(true)
    expect(finalizeRes.ok).toBe(true)

    // The finalized revision must be internally consistent.
    if (finalizeRes.ok) {
      const revSched = await programmeService.getProgrammeSchedule({
        ctx: ctxA, programmeId: PROG_A, revisionId: finalizeRes.revisionId,
      })
      expect(revSched.ok).toBe(true)
      if (revSched.ok) {
        expect(revSched.schedule.hasCycle).toBe(false)
      }
    }

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: 'Excavation',
    })
  }, 120000)

  // ── 11. Combined atomic: duration + name + sequence in one transaction ───

  test('combined atomic: duration + name + sequence → all succeed in one transaction', async () => {
    // Before: ACT_1 = Excavation, dur=5, seq=0.
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    const beforeDur = before.schedule.projectDuration // 35

    // Combined PATCH: duration 5→8, name→'Site Prep', sequence 0→2 (swap with ACT_3).
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 8, name: 'Site Prep', sequence: 2,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // All three fields changed.
    const act1 = await db.activity.findUnique({ where: { id: ACT_1 } })
    expect(act1!.name).toBe('Site Prep')
    expect(act1!.duration).toBe(8)
    expect(act1!.sequence).toBe(2)

    // ACT_3 (was seq 2) swapped to ACT_1's old seq (0).
    const act3 = await db.activity.findUnique({ where: { id: ACT_3 } })
    expect(act3!.sequence).toBe(0)

    // Schedule recomputed (duration changed): 8+10+20 = 38.
    expect(res.schedule.projectDuration).toBe(38)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 5, name: 'Excavation', sequence: 0,
    })
    // Restore ACT_3's sequence (it was swapped to 0, needs to go back to 2).
    await db.activity.update({ where: { id: ACT_3 }, data: { sequence: 2 } })
  }, 60000)

  // ── 12. Atomic partial failure: invalid sequence + valid duration → both rejected ─

  test('atomic: invalid sequence + valid duration → 422, duration UNCHANGED', async () => {
    // Before: ACT_1 = dur 5.
    const before = await db.activity.findUnique({ where: { id: ACT_1 } })
    expect(before!.duration).toBe(5)

    // Combined PATCH: valid duration (5→10) + INVALID sequence (-1).
    // The pre-DB validation catches the invalid sequence → 422 BEFORE any
    // DB write. Duration must NOT have changed.
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 10, sequence: -1,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)

    // Duration UNCHANGED — the atomic transaction did not commit.
    const after = await db.activity.findUnique({ where: { id: ACT_1 } })
    expect(after!.duration).toBe(5)
  }, 60000)

  // ── 13. Atomic: duration + name only (no sequence) → both succeed ────────

  test('combined atomic: duration + name (no sequence) → both succeed', async () => {
    const res = await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_2,
      duration: 15, name: 'Footings',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const act2 = await db.activity.findUnique({ where: { id: ACT_2 } })
    expect(act2!.name).toBe('Footings')
    expect(act2!.duration).toBe(15)

    // Schedule recomputed: 5+15+20 = 40.
    expect(res.schedule.projectDuration).toBe(40)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_2,
      duration: 10, name: 'Foundation',
    })
  }, 60000)
})
