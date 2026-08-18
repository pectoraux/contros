/**
 * Programme dependency editing integration tests — against Neon PostgreSQL.
 *
 * The second controlled schedule mutation: adding a dependency edge.
 *
 * Proves the server validates (inside the Programme-row lock):
 *   1. Happy path: add FS dependency → schedule changes deterministically.
 *   2. Finalized ProgrammeRevision is unchanged after adding a dependency.
 *   3. Cross-tenant: Org B cannot add a dependency to Org A's programme → 404.
 *   4. Cross-programme: predecessor from Programme B → 404.
 *   5. Self-reference (activity → itself) → 422.
 *   6. Missing activity (nonexistent ID) → 404.
 *   7. Invalid lag (NaN, Infinity) → 422.
 *   8. Invalid type ('XX') → 422.
 *   9. Cycle rejection (A→B exists, add B→A) → 422.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-dep-org-a'
const ORG_B = 'test-dep-org-b'
const USER_A = 'test-dep-user-a'
const USER_B = 'test-dep-user-b'
const CLIENT_A = 'test-dep-client-a'
const OPP_A = 'test-dep-opp-a'
const PROG_A = 'test-dep-programme-a'
const ACT_1 = 'test-dep-act-1' // Excavation (5d)
const ACT_2 = 'test-dep-act-2' // Foundation (10d)
const ACT_3 = 'test-dep-act-3' // Structure (20d) — no initial dependency
const DEP_1 = 'test-dep-dep-1' // FS: ACT_1 → ACT_2 (lag 0)

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@dep.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@dep.test',
}

describe('Programme dependency editing integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-dep-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'Dep Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@dep.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'Dep Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@dep.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_3, programmeId: PROG_A, name: 'Structure', duration: 20, status: 'planned' } })
    // FS: Excavation → Foundation (lag 0). Structure has no predecessor initially.
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dep-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-dep-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Happy path: add dependency → schedule changes ─────────────────────

  test('add FS dependency → schedule result changes deterministically', async () => {
    // Before: ACT_3 has no predecessors.
    //   ACT_1: ES=0 EF=5   (no preds)
    //   ACT_2: ES=5 EF=15  (pred ACT_1, FS, 0)
    //   ACT_3: ES=0 EF=20  (no preds)
    //   projectDuration = max(5, 15, 20) = 20
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.schedule.projectDuration).toBe(20)
    const act3Before = before.schedule.activities.find((a) => a.id === ACT_3)
    expect(act3Before!.earlyStart).toBe(0)
    expect(act3Before!.earlyFinish).toBe(20)

    // Add: FS ACT_2 → ACT_3 (lag 0). Now ACT_3 starts after ACT_2 finishes.
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_2, successorActivityId: ACT_3,
      type: 'FS', lag: 0,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    //   ACT_3: ES=15 EF=35  (pred ACT_2, FS, 0 → ES = EF_ACT_2 + lag = 15)
    //   projectDuration = max(5, 15, 35) = 35
    expect(res.schedule.projectDuration).toBe(35)
    const act3After = res.schedule.activities.find((a) => a.id === ACT_3)
    expect(act3After!.earlyStart).toBe(15)
    expect(act3After!.earlyFinish).toBe(35)

    // Clean up: remove the added dependency so other tests start clean.
    await db.activityDependency.deleteMany({
      where: { programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3 },
    })
  }, 60000)

  // ── 2. Finalized revision unchanged ──────────────────────────────────────

  test('finalized ProgrammeRevision is unchanged after adding a dependency', async () => {
    // Finalize the current workspace (ACT_1→ACT_2, ACT_3 independent).
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
    const revDepCount = revSched.schedule.activities.reduce(
      (sum, a) => sum + a.predecessors.length, 0,
    )

    // Add a dependency to the workspace.
    await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_2, successorActivityId: ACT_3,
      type: 'FS', lag: 0,
    })

    // The revision's schedule is unchanged.
    const revSched2 = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched2.ok).toBe(true)
    if (!revSched2.ok) return
    expect(revSched2.schedule.projectDuration).toBe(revDuration)
    const revDepCount2 = revSched2.schedule.activities.reduce(
      (sum, a) => sum + a.predecessors.length, 0,
    )
    expect(revDepCount2).toBe(revDepCount)

    // Clean up the added dependency.
    await db.activityDependency.deleteMany({
      where: { programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3 },
    })
  }, 60000)

  // ── 3. Cross-tenant → rejected ───────────────────────────────────────────

  test('cross-tenant: Org B cannot add a dependency to Org A programme', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxB, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_2,
      type: 'SS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 4. Cross-programme predecessor → rejected ────────────────────────────

  test('cross-programme: predecessor from Programme B → 404', async () => {
    // Create Programme B in Org A with one activity.
    const prog2 = await db.programme.create({
      data: { id: 'test-dep-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    await db.activity.create({
      data: { id: 'test-dep-act-cross', programmeId: prog2.id, name: 'Cross', duration: 3, status: 'planned' },
    })

    // Attempt: predecessor from Programme B, successor from Programme A.
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: 'test-dep-act-cross', // Programme B
      successorActivityId: ACT_3,                   // Programme A
      type: 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // Clean up.
    await db.activity.delete({ where: { id: 'test-dep-act-cross' } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 5. Self-reference → rejected ─────────────────────────────────────────

  test('self-reference: an activity cannot depend on itself → 422', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_1,
      type: 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/self/i)
  }, 60000)

  // ── 6. Missing activity → rejected ───────────────────────────────────────

  test('missing activity: nonexistent predecessor ID → 404', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: 'nonexistent-activity-id',
      successorActivityId: ACT_3,
      type: 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 7. Invalid lag → rejected ────────────────────────────────────────────

  test('NaN lag → 422', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_3,
      type: 'FS', lag: NaN,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  test('Infinity lag → 422', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_3,
      type: 'FS', lag: Infinity,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 8. Invalid type → rejected ───────────────────────────────────────────

  test('invalid type "XX" → 422', async () => {
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_3,
      type: 'XX' as 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 9. Cycle rejection → 422 ─────────────────────────────────────────────

  test('cycle: add B→A when A→B exists → 422', async () => {
    // The workspace has ACT_1 → ACT_2 (FS, DEP_1). Adding ACT_2 → ACT_1
    // (FS) would create a cycle: ACT_1 → ACT_2 → ACT_1. The cycle check
    // runs inside the Programme-row lock and must reject this.
    const res = await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_2, successorActivityId: ACT_1,
      type: 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/cycle/i)

    // Verify no dependency was persisted (the transaction rolled back).
    const persisted = await db.activityDependency.findFirst({
      where: { programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_1 },
    })
    expect(persisted).toBeNull()
  }, 60000)
})
