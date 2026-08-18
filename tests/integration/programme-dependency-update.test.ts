/**
 * Programme dependency update integration tests — against Neon PostgreSQL.
 *
 * The third controlled schedule mutation: updating a dependency's type and
 * lag. The dependency ROW ID is the stable identity (U1); type and lag are
 * MUTABLE PROPERTIES. This updates the SAME row — it never creates a
 * competing edge.
 *
 * Proves the server validates (inside the Programme-row lock):
 *   1. Happy path: FS/0 → SS/5 → schedule changes, exactly one edge remains.
 *   2. Finalized ProgrammeRevision is unchanged after updating a dependency.
 *   3. Cross-tenant: Org B cannot update Org A's dependency → 404.
 *   4. Cross-programme: dependency from Programme B → 404.
 *   5. Missing dependency (nonexistent ID) → 404.
 *   6. NaN lag → 422.
 *   7. Infinity lag → 422.
 *   8. Invalid type 'XX' → 422.
 *   9. Concurrent update + finalization → both succeed, serialized by lock.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-du-org-a'
const ORG_B = 'test-du-org-b'
const USER_A = 'test-du-user-a'
const USER_B = 'test-du-user-b'
const CLIENT_A = 'test-du-client-a'
const OPP_A = 'test-du-opp-a'
const PROG_A = 'test-du-programme-a'
const ACT_1 = 'test-du-act-1' // Excavation (5d)
const ACT_2 = 'test-du-act-2' // Foundation (10d)
const ACT_3 = 'test-du-act-3' // Structure (20d)
const DEP_1 = 'test-du-dep-1' // FS: ACT_1 → ACT_2 (lag 0)

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@du.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@du.test',
}

describe('Programme dependency update integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-du-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'DU Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@du.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'DU Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@du.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_3, programmeId: PROG_A, name: 'Structure', duration: 20, status: 'planned' } })
    // FS: Excavation → Foundation (lag 0). Structure has no predecessor.
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-du-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-du-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Happy path: FS/0 → SS/5 → schedule changes ────────────────────────

  test('update FS/0 → SS/5 → schedule changes, exactly one edge remains', async () => {
    // Before: ACT_1 → ACT_2 (FS, lag 0).
    //   ACT_1: ES=0 EF=5   (no preds)
    //   ACT_2: ES=5 EF=15  (pred ACT_1, FS, 0 → ES = EF_pred + lag = 5)
    //   ACT_3: ES=0 EF=20  (no preds)
    //   projectDuration = max(5, 15, 20) = 20
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.schedule.projectDuration).toBe(20)
    const act2Before = before.schedule.activities.find((a) => a.id === ACT_2)
    expect(act2Before!.earlyStart).toBe(5)

    // Update: change DEP_1 from FS/0 to SS/5.
    // SS: ES_successor = ES_predecessor + lag = 0 + 5 = 5 (same as before,
    // but now it's Start-to-Start, so ACT_2 can start 5 days after ACT_1
    // starts, regardless of when ACT_1 finishes).
    // For this graph, SS/5 gives ES_ACT_2 = 5, same as FS/0.
    // To get a VISIBLE change, use SS/2: ES_ACT_2 = 0 + 2 = 2.
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'SS', lag: 2,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // ACT_2: ES=2 EF=12 (SS: ES = ES_pred + lag = 0 + 2 = 2)
    const act2After = res.schedule.activities.find((a) => a.id === ACT_2)
    expect(act2After!.earlyStart).toBe(2)
    expect(act2After!.earlyFinish).toBe(12)

    // Verify exactly ONE edge remains (the same row, updated — not a new one).
    const edges = await db.activityDependency.findMany({
      where: { programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2 },
    })
    expect(edges.length).toBe(1)
    expect(edges[0].id).toBe(DEP_1) // same row ID
    expect(edges[0].type).toBe('SS')
    expect(edges[0].lag).toBe(2)

    // Restore to FS/0 for subsequent tests.
    await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'FS', lag: 0,
    })
  }, 60000)

  // ── 2. Finalized revision unchanged ──────────────────────────────────────

  test('finalized ProgrammeRevision is unchanged after updating a dependency', async () => {
    // Finalize the current workspace (ACT_1→ACT_2 FS/0, ACT_3 independent).
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

    // Update the workspace dependency.
    await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'SS', lag: 10,
    })

    // The revision's schedule is unchanged.
    const revSched2 = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched2.ok).toBe(true)
    if (!revSched2.ok) return
    expect(revSched2.schedule.projectDuration).toBe(revDuration)

    // Restore.
    await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'FS', lag: 0,
    })
  }, 60000)

  // ── 3. Cross-tenant → rejected ───────────────────────────────────────────

  test('cross-tenant: Org B cannot update Org A dependency → 404', async () => {
    const res = await programmeService.updateDependency({
      ctx: ctxB, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'SS', lag: 5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 4. Cross-programme dependency → rejected ─────────────────────────────

  test('cross-programme: dependency from Programme B → 404', async () => {
    // Create Programme B in Org A with one activity + one dependency.
    const prog2 = await db.programme.create({
      data: { id: 'test-du-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    await db.activity.create({ data: { id: 'test-du-act-b1', programmeId: prog2.id, name: 'B1', duration: 3, status: 'planned' } })
    await db.activity.create({ data: { id: 'test-du-act-b2', programmeId: prog2.id, name: 'B2', duration: 4, status: 'planned' } })
    const dep2 = await db.activityDependency.create({
      data: { id: 'test-du-dep-b', programmeId: prog2.id, predecessorActivityId: 'test-du-act-b1', successorActivityId: 'test-du-act-b2', type: 'FS', lag: 0 },
    })

    // Attempt: update Programme B's dependency via Programme A's context.
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: dep2.id,
      type: 'SS', lag: 5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // Verify Programme B's dependency is unchanged.
    const dep2After = await db.activityDependency.findUnique({ where: { id: dep2.id } })
    expect(dep2After!.type).toBe('FS')
    expect(dep2After!.lag).toBe(0)

    // Clean up.
    await db.activityDependency.delete({ where: { id: dep2.id } }).catch(() => {})
    await db.activity.deleteMany({ where: { programmeId: prog2.id } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 5. Missing dependency → rejected ─────────────────────────────────────

  test('missing dependency: nonexistent ID → 404', async () => {
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: 'nonexistent-dependency-id',
      type: 'SS', lag: 5,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 6. Invalid lag → rejected ────────────────────────────────────────────

  test('NaN lag → 422', async () => {
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'FS', lag: NaN,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    // Verify unchanged.
    const dep = await db.activityDependency.findUnique({ where: { id: DEP_1 } })
    expect(dep!.lag).toBe(0)
  }, 60000)

  test('Infinity lag → 422', async () => {
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'FS', lag: Infinity,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 7. Invalid type → rejected ───────────────────────────────────────────

  test('invalid type "XX" → 422', async () => {
    const res = await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'XX' as 'FS', lag: 0,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    // Verify unchanged.
    const dep = await db.activityDependency.findUnique({ where: { id: DEP_1 } })
    expect(dep!.type).toBe('FS')
  }, 60000)

  // ── 8. Concurrent update + finalization → serialized ─────────────────────

  test('concurrent update + finalization → both succeed, serialized by Programme lock', async () => {
    // Run updateDependency and finalizeProgramme concurrently. Both take the
    // Programme-row lock; they must serialize. Both should succeed; the
    // revision must be internally consistent (its snapshot reflects either
    // the pre-update or post-update state, never a mixed state).
    const [updateRes, finalizeRes] = await Promise.all([
      programmeService.updateDependency({
        ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
        type: 'SS', lag: 7,
      }),
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
    ])

    // Both should succeed.
    expect(updateRes.ok).toBe(true)
    expect(finalizeRes.ok).toBe(true)

    // The finalized revision must be internally consistent: its snapshot
    // reflects either the pre-update (FS/0) or post-update (SS/7) state.
    if (finalizeRes.ok) {
      const revSched = await programmeService.getProgrammeSchedule({
        ctx: ctxA, programmeId: PROG_A, revisionId: finalizeRes.revisionId,
      })
      expect(revSched.ok).toBe(true)
      if (revSched.ok) {
        // The revision's schedule must be valid (no partial state).
        expect(revSched.schedule.hasCycle).toBe(false)
        // The revision must have exactly the dependencies that existed at
        // finalization time — either FS/0 or SS/7, not both.
        const act2 = revSched.schedule.activities.find((a) => a.id === ACT_2)
        expect(act2).toBeDefined()
        // Either ES=5 (FS/0) or ES=7 (SS/7) — both are valid, no mixed state.
        expect([5, 7]).toContain(act2!.earlyStart)
      }
    }

    // Restore to FS/0.
    await programmeService.updateDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_1,
      type: 'FS', lag: 0,
    })
  }, 120000)
})
