/**
 * Programme finalization + change summary integration tests — against Neon PostgreSQL.
 *
 * Tests the finalization UX milestone:
 *   - Finalize workspace → revision 1
 *   - Edit workspace → revision 1 unchanged
 *   - Finalize again → revision 2
 *   - Same workspace content → same content hash
 *   - Different schedule input → different content hash
 *   - Different sequence → different content hash, same CPM result
 *   - Tenant isolation → 404
 *   - Finalized revision read-only (immutability)
 *   - Audit event recorded
 *   - Concurrent finalization → unique sequential revisions
 *   - Change summary: categorizes schedule-affecting vs presentation changes
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { programmeService } from '../../src/application/programme-service'
import { computeChangeSummary } from '../../src/lib/programme/change-summary'
import type { ProgrammeSnapshot } from '../../src/lib/programme'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-fn-org-a'
const ORG_B = 'test-fn-org-b'
const USER_A = 'test-fn-user-a'
const USER_B = 'test-fn-user-b'
const CLIENT_A = 'test-fn-client-a'
const OPP_A = 'test-fn-opp-a'
const PROG_A = 'test-fn-programme-a'
const ACT_1 = 'test-fn-act-1'
const ACT_2 = 'test-fn-act-2'
const DEP_1 = 'test-fn-dep-1'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@fn.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@fn.test',
}

function makeSnapshot(overrides: Partial<ProgrammeSnapshot> = {}): ProgrammeSnapshot {
  return {
    programmeId: 'p',
    programmeName: 'P',
    revisionNo: 0,
    scheduleEngineVersion: 1,
    activities: [],
    dependencies: [],
    finalizedAt: '',
    ...overrides,
  }
}

describe('Programme finalization + change summary integration tests', () => {
  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-fn-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'FN Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@fn.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'FN Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@fn.test', role: 'estimator' } })

    await db.programme.create({ data: { id: PROG_A, organizationId: ORG_A, opportunityId: OPP_A, name: 'Programme A', status: 'draft' } })
    await db.activity.create({ data: { id: ACT_1, programmeId: PROG_A, name: 'Excavation', duration: 5, status: 'planned', sequence: 0 } })
    await db.activity.create({ data: { id: ACT_2, programmeId: PROG_A, name: 'Foundation', duration: 10, status: 'planned', sequence: 1 } })
    await db.activityDependency.create({ data: { id: DEP_1, programmeId: PROG_A, predecessorActivityId: ACT_1, successorActivityId: ACT_2, type: 'FS', lag: 0 } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.activityDependency.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.activity.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.programmeRevision.deleteMany({ where: { programme: { organizationId: { startsWith: 'test-fn-' } } } }).catch(() => {})
    await db.programme.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-fn-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Finalize workspace → revision 1 ────────────────────────────────────

  test('finalize workspace → revision 1', async () => {
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(1)
    expect(res.revisionId).toBeTruthy()
    expect(res.snapshotContentHash).toBeTruthy()
    expect(res.scheduleEngineVersion).toBe(1)
  }, 60000)

  // ── 2. Edit workspace → revision 1 unchanged ──────────────────────────────

  test('edit workspace → revision 1 unchanged', async () => {
    // Read revision 1's schedule.
    const revisions = await db.programmeRevision.findMany({ where: { programmeId: PROG_A } })
    const rev1 = revisions.find((r) => r.revisionNo === 1)!
    const revSchedBefore = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: rev1.id,
    })
    expect(revSchedBefore.ok).toBe(true)
    if (!revSchedBefore.ok) return
    const revDur = revSchedBefore.schedule.projectDuration

    // Edit the workspace.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 99,
    })

    // Revision 1 is unchanged.
    const revSchedAfter = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: rev1.id,
    })
    expect(revSchedAfter.ok).toBe(true)
    if (!revSchedAfter.ok) return
    expect(revSchedAfter.schedule.projectDuration).toBe(revDur)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 5,
    })
  }, 60000)

  // ── 3. Finalize again → revision 2 ────────────────────────────────────────

  test('finalize again → revision 2', async () => {
    // Make a change so revision 2 has different content.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      name: 'Site Prep',
    })

    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(2)
    expect(res.revisionId).toBeTruthy()
  }, 60000)

  // ── 4. Same workspace content → same content hash ─────────────────────────

  test('same workspace content → same content hash', async () => {
    // Finalize without any changes → revision 3 should have the same content
    // hash as revision 2 (same activities, dependencies, durations, sequences).
    const rev2 = await db.programmeRevision.findFirst({
      where: { programmeId: PROG_A, revisionNo: 2 },
    })
    expect(rev2).toBeTruthy()

    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(3)
    expect(res.snapshotContentHash).toBe(rev2!.snapshotContentHash)
  }, 60000)

  // ── 5. Different schedule input → different content hash ──────────────────

  test('different schedule input → different content hash', async () => {
    // Change a duration (schedule-affecting).
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      duration: 8,
    })

    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(4)

    // Revision 4's hash must differ from revision 3's (different duration).
    const rev3 = await db.programmeRevision.findFirst({
      where: { programmeId: PROG_A, revisionNo: 3 },
    })
    expect(res.snapshotContentHash).not.toBe(rev3!.snapshotContentHash)
  }, 60000)

  // ── 6. Different sequence → different content hash, same CPM result ────────

  test('different sequence → different content hash, same CPM result', async () => {
    // Read revision 4's schedule (before sequence change).
    const rev4 = await db.programmeRevision.findFirst({
      where: { programmeId: PROG_A, revisionNo: 4 },
    })
    const rev4Sched = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: rev4!.id,
    })
    expect(rev4Sched.ok).toBe(true)
    if (!rev4Sched.ok) return
    const rev4Dur = rev4Sched.schedule.projectDuration

    // Change sequence (presentation only — should NOT change CPM).
    // Swap ACT_1 and ACT_2 sequences.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: 1,
    })

    // Finalize revision 5.
    const res = await programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revisionNo).toBe(5)

    // Different content hash (sequence is part of the content).
    expect(res.snapshotContentHash).not.toBe(rev4!.snapshotContentHash)

    // Same CPM result (sequence doesn't affect scheduling).
    const rev5Sched = await programmeService.getProgrammeSchedule({
      ctx: ctxA, programmeId: PROG_A, revisionId: res.revisionId,
    })
    expect(rev5Sched.ok).toBe(true)
    if (!rev5Sched.ok) return
    expect(rev5Sched.schedule.projectDuration).toBe(rev4Dur)

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_1,
      sequence: 0,
    })
  }, 60000)

  // ── 7. Tenant isolation → 404 ─────────────────────────────────────────────

  test('cross-tenant: Org B cannot finalize Org A programme → 404', async () => {
    const res = await programmeService.finalizeProgramme({ ctx: ctxB, programmeId: PROG_A })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  test('cross-tenant: Org B cannot get change summary → 404', async () => {
    const res = await programmeService.getChangeSummary({ ctx: ctxB, programmeId: PROG_A })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 8. Finalized revision read-only (immutability) ────────────────────────

  test('finalized revision is read-only (no update/delete)', async () => {
    // The ProgrammeRevision model has no update or delete methods on
    // programmeRevisionRepo (X2 immutability). Verify by checking the
    // repository source — no update/delete methods exist.
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/repositories/programme-repositories.ts', 'utf8')
    const revSection = src.slice(
      src.indexOf('export const programmeRevisionRepo'),
      src.indexOf('// ─── Activity Repository'),
    )
    // No update or delete methods.
    expect(revSection).not.toMatch(/async update\(/)
    expect(revSection).not.toMatch(/async delete\(/)
    expect(revSection).not.toMatch(/async deleteMany\(/)
    // Only createFinalized + read methods.
    expect(revSection).toMatch(/async createFinalized\(/)
    expect(revSection).toMatch(/async getForOrganization\(/)
  }, 60000)

  // ── 9. Audit event recorded ───────────────────────────────────────────────

  test('audit event recorded for finalization', async () => {
    const auditEntries = await db.auditLog.findMany({
      where: { organizationId: ORG_A, action: 'programme.revision-finalized' },
      orderBy: { createdAt: 'desc' },
    })
    expect(auditEntries.length).toBeGreaterThanOrEqual(5) // revisions 1-5

    const latest = auditEntries[0]
    const after = JSON.parse(latest.afterJson!)
    expect(after.programmeId).toBe(PROG_A)
    expect(after.revisionId).toBeTruthy()
    expect(after.revisionNo).toBe(5)
    expect(after.snapshotContentHash).toBeTruthy()
    expect(after.scheduleEngineVersion).toBe(1)
    expect(latest.actorId).toBe(USER_A)
  }, 60000)

  // ── 10. Concurrent finalization → unique sequential revisions ─────────────

  test('concurrent finalization → unique sequential revisions', async () => {
    // Make a change so the content differs from revision 5.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_2,
      duration: 12,
    })

    // Fire two finalizations concurrently.
    const [res1, res2] = await Promise.all([
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
      programmeService.finalizeProgramme({ ctx: ctxA, programmeId: PROG_A }),
    ])

    // Both should succeed (the Programme-row lock serializes them).
    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)

    if (res1.ok && res2.ok) {
      // They must have different revision numbers (sequential, not duplicate).
      expect(res1.revisionNo).not.toBe(res2.revisionNo)
      // One should be 6, the other 7.
      expect([6, 7]).toContain(res1.revisionNo)
      expect([6, 7]).toContain(res2.revisionNo)

      // Both should have the same content hash (same workspace content).
      // The second finalization saw no changes after the first, so it
      // finalized the same content.
      expect(res1.snapshotContentHash).toBe(res2.snapshotContentHash)
    }

    // Restore.
    await programmeService.updateActivity({
      ctx: ctxA, programmeId: PROG_A, activityId: ACT_2,
      duration: 10,
    })
  }, 120000)

  // ── 11. Change summary: schedule-affecting vs presentation ────────────────

  test('change summary is valid after finalization', async () => {
    const summaryRes = await programmeService.getChangeSummary({ ctx: ctxA, programmeId: PROG_A })
    expect(summaryRes.ok).toBe(true)
    if (!summaryRes.ok) return

    // The summary should be valid. After the concurrent finalization + restore,
    // there may be changes (duration 12→10) relative to the last finalized
    // revision. The exact state depends on which revision won the concurrent
    // race, but the structure should be valid.
    expect(summaryRes.summary).toBeDefined()
    expect(summaryRes.summary.counts).toBeDefined()
    expect(summaryRes.latestRevisionNo).toBeGreaterThanOrEqual(6)
  }, 60000)

  // ── 12. Pure computeChangeSummary: same snapshots → no changes ────────────

  test('pure diff: same snapshots → no changes', () => {
    const snap = makeSnapshot({
      activities: [
        { id: 'a', name: 'A', duration: 5, sequence: 0, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
      ],
      dependencies: [],
    })
    const summary = computeChangeSummary(snap, snap)
    expect(summary.hasChanges).toBe(false)
    expect(summary.activities.length).toBe(0)
    expect(summary.dependencies.length).toBe(0)
  })

  // ── 13. Pure computeChangeSummary: duration change is schedule-affecting ──

  test('pure diff: duration change → schedule-affecting', () => {
    const base = makeSnapshot({
      activities: [
        { id: 'a', name: 'A', duration: 5, sequence: 0, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
      ],
    })
    const head = makeSnapshot({
      activities: [
        { id: 'a', name: 'A', duration: 8, sequence: 0, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
      ],
    })
    const summary = computeChangeSummary(base, head)
    expect(summary.hasChanges).toBe(true)
    expect(summary.hasScheduleChanges).toBe(true)
    expect(summary.hasPresentationChanges).toBe(false)
    expect(summary.activities.length).toBe(1)
    expect(summary.activities[0].kind).toBe('duration-changed')
    expect(summary.activities[0].scheduleAffecting).toBe(true)
  })

  // ── 14. Pure computeChangeSummary: sequence change is presentation only ──

  test('pure diff: sequence change → presentation only, not schedule-affecting', () => {
    const base = makeSnapshot({
      activities: [
        { id: 'a', name: 'A', duration: 5, sequence: 0, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
        { id: 'b', name: 'B', duration: 3, sequence: 1, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
      ],
    })
    const head = makeSnapshot({
      activities: [
        { id: 'a', name: 'A', duration: 5, sequence: 1, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
        { id: 'b', name: 'B', duration: 3, sequence: 0, constructionRefs: { estimateLineId: null, workDefinitionVersionId: null, workPackageId: null }, plannedQuantity: null, status: 'planned', predecessorDependencies: [] },
      ],
    })
    const summary = computeChangeSummary(base, head)
    expect(summary.hasChanges).toBe(true)
    expect(summary.hasScheduleChanges).toBe(false)
    expect(summary.hasPresentationChanges).toBe(true)
    // Both activities reordered.
    expect(summary.activities.length).toBe(2)
    expect(summary.activities.every((a) => a.kind === 'reordered')).toBe(true)
    expect(summary.activities.every((a) => !a.scheduleAffecting)).toBe(true)
  })
})
