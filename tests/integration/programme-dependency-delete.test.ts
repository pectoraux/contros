/**
 * Programme dependency delete integration tests — against Neon PostgreSQL.
 *
 * The fourth controlled schedule mutation: deleting a dependency edge.
 * Removes the edge from the workspace graph; the scheduling engine then
 * derives the OUTPUTS from the reduced graph.
 *
 * Proves:
 *   1. Valid delete → 200, schedule recalculates, edge removed.
 *   2. Finalized ProgrammeRevision is unchanged after deleting a dependency.
 *   3. Cross-tenant: Org B cannot delete Org A's dependency → 404.
 *   4. Cross-programme: dependency from Programme B → 404.
 *   5. Missing dependency (nonexistent ID) → 404.
 *   6. Concurrent delete + finalization → serialized by Programme lock.
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-dd-org-a'
const ORG_B = 'test-dd-org-b'
const USER_A = 'test-dd-user-a'
const USER_B = 'test-dd-user-b'
const CLIENT_A = 'test-dd-client-a'
const OPP_A = 'test-dd-opp-a'
const PROG_A = 'test-dd-programme-a'
const ACT_1 = 'test-dd-act-1' // Excavation (5d)
const ACT_2 = 'test-dd-act-2' // Foundation (10d)
const ACT_3 = 'test-dd-act-3' // Structure (20d)
const DEP_1 = 'test-dd-dep-1' // FS: ACT_1 → ACT_2 (lag 0)
const DEP_2 = 'test-dd-dep-2' // FS: ACT_2 → ACT_3 (lag 0)

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@dd.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@dd.test',
}

describe('Programme dependency delete integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-dd-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'DD Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@dd.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'DD Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@dd.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned' } })
    await db.activity.create({ data: { id: ACT_3, programmeId: PROG_A, name: 'Structure', duration: 20, status: 'planned' } })
    // FS chain: ACT_1 → ACT_2 → ACT_3 (all lag 0). Duration = 5+10+20 = 35.
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
    await db.activityDependency.create({ data: { id: DEP_2, programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-dd-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-dd-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Valid delete → schedule recalculates ──────────────────────────────

  test('valid delete → 200, schedule recalculates, edge removed', async () => {
    // Before: ACT_1 → ACT_2 → ACT_3 (FS chain). Duration = 35.
    //   ACT_1: ES=0 EF=5, ACT_2: ES=5 EF=15, ACT_3: ES=15 EF=35.
    const before = await programmeService.getProgrammeSchedule({ ctx: ctxA, programmeId: PROG_A })
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.schedule.projectDuration).toBe(35)
    expect(before.dependencies.length).toBe(2)

    // Delete DEP_2 (ACT_2 → ACT_3). Now ACT_3 has no predecessor.
    const res = await programmeService.deleteDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_2,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // After: ACT_3 starts at 0 (no preds). Duration = max(15, 20) = 20.
    expect(res.schedule.projectDuration).toBe(20)
    const act3 = res.schedule.activities.find((a) => a.id === ACT_3)
    expect(act3!.earlyStart).toBe(0)
    expect(act3!.earlyFinish).toBe(20)
    expect(res.dependencies.length).toBe(1)

    // Verify the edge is gone from the DB.
    const dep2After = await db.activityDependency.findUnique({ where: { id: DEP_2 } })
    expect(dep2After).toBeNull()

    // Restore: re-create DEP_2 for subsequent tests.
    await db.activityDependency.create({
      data: { id: DEP_2, programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 },
    })
  }, 60000)

  // ── 2. Finalized revision unchanged ──────────────────────────────────────

  test('finalized ProgrammeRevision is unchanged after deleting a dependency', async () => {
    // Finalize the current workspace (FS chain, 35 days).
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
    const revDepCount = revSched.dependencies.length

    // Delete a dependency from the workspace.
    await programmeService.deleteDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_2,
    })

    // The revision's schedule is unchanged.
    const revSched2 = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: fin.revisionId,
    })
    expect(revSched2.ok).toBe(true)
    if (!revSched2.ok) return
    expect(revSched2.schedule.projectDuration).toBe(revDuration)
    expect(revSched2.dependencies.length).toBe(revDepCount)

    // Restore: re-create DEP_2.
    await db.activityDependency.create({
      data: { id: DEP_2, programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 },
    })
  }, 60000)

  // ── 3. Cross-tenant → rejected ───────────────────────────────────────────

  test('cross-tenant: Org B cannot delete Org A dependency → 404', async () => {
    const res = await programmeService.deleteDependency({
      ctx: ctxB, programmeId: PROG_A, dependencyId: DEP_1,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // Verify unchanged.
    const dep1 = await db.activityDependency.findUnique({ where: { id: DEP_1 } })
    expect(dep1).not.toBeNull()
  }, 60000)

  // ── 4. Cross-programme → rejected ────────────────────────────────────────

  test('cross-programme: dependency from Programme B → 404', async () => {
    // Create Programme B in Org A with one activity + one dependency.
    const prog2 = await db.programme.create({
      data: { id: 'test-dd-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    await db.activity.create({ data: { id: 'test-dd-act-b1', programmeId: prog2.id, name: 'B1', duration: 3, status: 'planned' } })
    await db.activity.create({ data: { id: 'test-dd-act-b2', programmeId: prog2.id, name: 'B2', duration: 4, status: 'planned' } })
    const dep2 = await db.activityDependency.create({
      data: { id: 'test-dd-dep-b', programmeId: prog2.id, predecessorActivityId: 'test-dd-act-b1', successorActivityId: 'test-dd-act-b2', type: 'FS', lag: 0 },
    })

    // Attempt: delete Programme B's dependency via Programme A's context.
    const res = await programmeService.deleteDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: dep2.id,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // Verify Programme B's dependency is unchanged.
    const dep2After = await db.activityDependency.findUnique({ where: { id: dep2.id } })
    expect(dep2After).not.toBeNull()

    // Clean up.
    await db.activityDependency.delete({ where: { id: dep2.id } }).catch(() => {})
    await db.activity.deleteMany({ where: { programmeId: prog2.id } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 5. Missing dependency → rejected ─────────────────────────────────────

  test('missing dependency: nonexistent ID → 404', async () => {
    const res = await programmeService.deleteDependency({
      ctx: ctxA, programmeId: PROG_A, dependencyId: 'nonexistent-dependency-id',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 6. Concurrent delete + finalization → serialized ─────────────────────

  test('concurrent delete + finalization → both succeed, serialized by Programme lock', async () => {
    // Run deleteDependency and finalizeProgramme concurrently. Both take
    // the Programme-row lock; they must serialize. Both should succeed;
    // the revision must be internally consistent.
    const [deleteRes, finalizeRes] = await Promise.all([
      programmeService.deleteDependency({
        ctx: ctxA, programmeId: PROG_A, dependencyId: DEP_2,
      }),
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
    ])

    // Both should succeed.
    expect(deleteRes.ok).toBe(true)
    expect(finalizeRes.ok).toBe(true)

    // The finalized revision must be internally consistent: its snapshot
    // reflects either the pre-delete (2 edges) or post-delete (1 edge)
    // state, never a mixed state.
    if (finalizeRes.ok) {
      const revSched = await programmeService.getProgrammeSchedule({
        ctx: ctxA, programmeId: PROG_A, revisionId: finalizeRes.revisionId,
      })
      expect(revSched.ok).toBe(true)
      if (revSched.ok) {
        expect(revSched.schedule.hasCycle).toBe(false)
        // The revision must have either 1 or 2 dependencies — not a
        // partial state.
        expect([1, 2]).toContain(revSched.dependencies.length)
      }
    }

    // Restore: re-create DEP_2 if it was deleted.
    const dep2Exists = await db.activityDependency.findUnique({ where: { id: DEP_2 } })
    if (!dep2Exists) {
      await db.activityDependency.create({
        data: { id: DEP_2, programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 },
      })
    }
  }, 120000)
})
