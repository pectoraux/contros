/**
 * Programme finalization 422 + revision comparison integration tests —
 * against Neon PostgreSQL.
 *
 * Part 1: Finalization error contract — invalid workspace → 422 (not 500).
 * Part 2: Revision-to-revision comparison — historical "what changed?".
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-rc-org-a'
const ORG_B = 'test-rc-org-b'
const USER_A = 'test-rc-user-a'
const USER_B = 'test-rc-user-b'
const CLIENT_A = 'test-rc-client-a'
const OPP_A = 'test-rc-opp-a'
const PROG_A = 'test-rc-programme-a'
const ACT_1 = 'test-rc-act-1'
const ACT_2 = 'test-rc-act-2'
const ACT_3 = 'test-rc-act-3'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@rc.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@rc.test',
}

describe('Programme finalization 422 + revision comparison integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-rc-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'RC Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@rc.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'RC Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@rc.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned', sequence: 0 } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned', sequence: 1 } })
    await db.activity.create({ data: { id: ACT_3, programmeId: PROG_A, name: 'Structure', duration: 20, status: 'planned', sequence: 2 } })
    // FS chain: ACT_1 → ACT_2 → ACT_3
    await db.activityDependency.create({ data: { id: 'test-rc-dep-1', programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
    await db.activityDependency.create({ data: { id: 'test-rc-dep-2', programmeId: PROG_A, predecessorActivityId: ACT_2, successorActivityId: ACT_3, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-rc-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-rc-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── Part 1: Finalization 422 error contract ──────────────────────────────

  // ── 1. Finalize valid workspace → revision 1 ─────────────────────────────

  test('finalize valid workspace → revision 1', async () => {
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(1)
  }, 60000)

  // ── 2. Finalize with cycle → 422 (not 500) ───────────────────────────────

  test('finalize with cyclic workspace → 422 (typed validation error, not 500)', async () => {
    // Create a cycle: ACT_3 → ACT_1 (ACT_1 → ACT_2 → ACT_3 → ACT_1).
    // The addDependency service rejects cycles, so we insert directly via
    // Prisma to simulate a corrupted workspace state.
    await db.activityDependency.create({
      data: {
        id: 'test-rc-dep-cycle',
        programmeId: PROG_A,
        predecessorActivityId: ACT_3,
        successorActivityId: ACT_1,
        type: 'FS',
        lag: 0,
      },
    })

    // Attempt to finalize — should return 422, not throw.
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/cycle|validation failed/i)

    // Clean up the cycle dependency.
    await db.activityDependency.delete({ where: { id: 'test-rc-dep-cycle' } })
  }, 60000)

  // ── 3. Cross-tenant finalize → 404 ───────────────────────────────────────

  test('cross-tenant finalize → 404', async () => {
    const res = await programmeService.finalizeProgramme({ ctx: ctxB, programmeId: PROG_A })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── Part 2: Revision-to-revision comparison ──────────────────────────────

  // ── 4. Make changes and finalize revision 2 ──────────────────────────────

  let rev1Id: string
  let rev2Id: string

  test('make schedule + presentation changes, finalize revision 2', async () => {
    // Get revision 1's ID.
    const rev1 = await db.programmeRevision.findFirst({
      where: { programmeId: PROG_A, revisionNo: 1 },
    })
    expect(rev1).toBeTruthy()
    rev1Id = rev1!.id

    // Make changes:
    // - Schedule: change ACT_1 duration 5→8 (schedule-affecting)
    // - Presentation: rename ACT_2 'Foundation'→'Footings'
    // - Schedule: add a dependency ACT_1→ACT_3 (FS, lag 0)
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 8, name: 'Excavation', // duration change + keep name
    })
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_2,
      name: 'Footings', // rename only
    })
    await programmeService.addDependency({
      ctx: ctxA, programmeId: PROG_A,
      predecessorActivityId: ACT_1, successorActivityId: ACT_3,
      type: 'FS', lag: 0,
    })

    // Finalize revision 2.
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(2)
    rev2Id = res.revisionId
  }, 60000)

  // ── 5. Compare revision 1 → revision 2 ───────────────────────────────────

  test('compare revision 1 → revision 2: schedule + presentation changes', async () => {
    const res = await programmeService.compareRevisions({
      ctx: ctxA, programmeId: PROG_A,
      fromRevisionId: rev1Id, toRevisionId: rev2Id,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Metadata.
    expect(res.from.revisionNo).toBe(1)
    expect(res.to.revisionNo).toBe(2)
    expect(res.from.snapshotContentHash).not.toBe(res.to.snapshotContentHash)

    // Summary.
    expect(res.summary.hasChanges).toBe(true)
    expect(res.summary.hasScheduleChanges).toBe(true) // duration + dependency added
    expect(res.summary.hasPresentationChanges).toBe(true) // rename

    // Activity changes.
    // ACT_1: duration 5→8 (schedule)
    const act1Change = res.summary.activities.find((c) => c.activityId === ACT_1)
    expect(act1Change).toBeDefined()
    expect(act1Change!.kind).toBe('duration-changed')
    expect(act1Change!.category).toBe('schedule')
    expect(act1Change!.oldValue).toBe(5)
    expect(act1Change!.newValue).toBe(8)

    // ACT_2: renamed (presentation)
    const act2Change = res.summary.activities.find((c) => c.activityId === ACT_2)
    expect(act2Change).toBeDefined()
    expect(act2Change!.kind).toBe('renamed')
    expect(act2Change!.category).toBe('presentation')
    expect(act2Change!.oldValue).toBe('Foundation')
    expect(act2Change!.newValue).toBe('Footings')

    // Dependency changes: ACT_1→ACT_3 added (schedule)
    const depAdded = res.summary.dependencies.find(
      (d) => d.predecessorActivityId === ACT_1 && d.successorActivityId === ACT_3,
    )
    expect(depAdded).toBeDefined()
    expect(depAdded!.kind).toBe('added')
    expect(depAdded!.category).toBe('schedule')
    expect(depAdded!.predecessorName).toBe('Excavation')
    expect(depAdded!.successorName).toBe('Structure')

    // Counts.
    expect(res.summary.counts.activitiesDurationChanged).toBe(1)
    expect(res.summary.counts.activitiesRenamed).toBe(1)
    expect(res.summary.counts.dependenciesAdded).toBe(1)
  }, 60000)

  // ── 6. Compare revision 2 → revision 1 (reverse) ─────────────────────────

  test('compare revision 2 → revision 1 (reverse): changes are mirrored', async () => {
    const res = await programmeService.compareRevisions({
      ctx: ctxA, programmeId: PROG_A,
      fromRevisionId: rev2Id, toRevisionId: rev1Id,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // The dependency that was "added" in 1→2 is now "removed" in 2→1.
    const depRemoved = res.summary.dependencies.find(
      (d) => d.predecessorActivityId === ACT_1 && d.successorActivityId === ACT_3,
    )
    expect(depRemoved).toBeDefined()
    expect(depRemoved!.kind).toBe('removed')

    // Duration: 8→5 (reversed).
    const act1Change = res.summary.activities.find((c) => c.activityId === ACT_1)
    expect(act1Change!.oldValue).toBe(8)
    expect(act1Change!.newValue).toBe(5)
  }, 60000)

  // ── 7. Compare revision to itself → no changes ───────────────────────────

  test('compare revision 1 → revision 1: no changes', async () => {
    const res = await programmeService.compareRevisions({
      ctx: ctxA, programmeId: PROG_A,
      fromRevisionId: rev1Id, toRevisionId: rev1Id,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.summary.hasChanges).toBe(false)
    expect(res.summary.activities.length).toBe(0)
    expect(res.summary.dependencies.length).toBe(0)
  }, 60000)

  // ── 8. Cross-tenant comparison → 404 ─────────────────────────────────────

  test('cross-tenant comparison → 404', async () => {
    const res = await programmeService.compareRevisions({
      ctx: ctxB, programmeId: PROG_A,
      fromRevisionId: rev1Id, toRevisionId: rev2Id,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 9. Mismatched programme → 404 ────────────────────────────────────────

  test('mismatched programme → 404', async () => {
    // Create a second programme in Org A with its own revision.
    const prog2 = await db.programme.create({
      data: { id: 'test-rc-programme-b', organizationId: ORG_A, name: 'Programme B', status: 'draft' },
    })
    await db.activity.create({ data: { id: 'test-rc-act-b1', programmeId: prog2.id, name: 'B1', duration: 3, status: 'planned', sequence: 0 } })
    const revB = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: prog2.id })
    expect(revB.ok).toBe(true)

    // Attempt: compare rev1 (PROG_A) with revB (prog2) via PROG_A's context.
    // This should fail — revB doesn't belong to PROG_A.
    if (revB.ok) {
      const res = await programmeService.compareRevisions({
        ctx: ctxA, programmeId: PROG_A,
        fromRevisionId: rev1Id, toRevisionId: revB.revisionId,
      })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.status).toBe(404)
    }

    // Clean up.
    await db.activity.deleteMany({ where: { programmeId: prog2.id } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programmeId: prog2.id } }).catch(() => {})
    await db.programme.delete({ where: { id: prog2.id } }).catch(() => {})
  }, 60000)

  // ── 10. Construction category: plannedQuantity change ────────────────────

  test('construction category: plannedQuantity change between revisions', async () => {
    // Change ACT_1's planned quantity (construction category — doesn't affect CPM).
    // We need to set it via direct DB update since updateActivity doesn't
    // currently expose plannedQuantity.
    await db.activity.update({
      where: { id: ACT_1 },
      data: { plannedQuantity: 150 },
    })

    // Finalize revision 3.
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Compare revision 2 → revision 3.
    const cmp = await programmeService.compareRevisions({
      ctx: ctxA, programmeId: PROG_A,
      fromRevisionId: rev2Id, toRevisionId: res.revisionId,
    })
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) return

    // The planned quantity change should be in the construction category.
    expect(cmp.summary.hasConstructionChanges).toBe(true)
    const qtyChange = cmp.summary.activities.find((c) => c.kind === 'planned-quantity-changed')
    expect(qtyChange).toBeDefined()
    expect(qtyChange!.category).toBe('construction')
    expect(qtyChange!.scheduleAffecting).toBe(false)

    // Restore.
    await db.activity.update({ where: { id: ACT_1 }, data: { plannedQuantity: null } })
  }, 60000)
})
