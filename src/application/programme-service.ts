/**
 * ProgrammeService — application service for programme lifecycle and
 * schedule finalization.
 *
 * The schedule analogue of EstimateService → EstimateRevision.
 *
 *   RequestContext
 *       ↓
 *   ProgrammeService.finalizeProgramme()
 *       ↓
 *   tenant-scoped Programme + Activities + Dependencies (repository)
 *       ↓
 *   pure snapshot builder (from mutable workspace)
 *       ↓
 *   validateProgrammeSnapshot (pure)
 *       ↓
 *   serializeSnapshot (canonical JSON)
 *       ↓
 *   computeSnapshotContentHash (SHA-256)
 *       ↓
 *   ProgrammeRevisionRepository.createFinalized (IN TRANSACTION)
 *       ↓
 *   audit
 *
 * CRITICAL CONCURRENCY (A1): the revision-number read + revision creation
 * happen in the SAME transaction via getLatestRevisionNoInTransaction +
 * createFinalized. Two concurrent finalizations cannot both calculate the
 * same revisionNo.
 *
 * The service NEVER accepts a caller-supplied snapshot, hash, revision number,
 * or schedule-engine version as authoritative. All are derived:
 *   revisionNo           ← getLatestRevisionNoInTransaction() + 1
 *   snapshot             ← current mutable Programme graph
 *   scheduleEngineVersion ← CURRENT_SCHEDULE_ENGINE_VERSION
 *   snapshotContentHash  ← computeSnapshotContentHash(snapshot)
 *
 * FROZEN pattern: RequestContext → Service → Repository → Engine → Transaction → Audit
 */

import { dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  programmeRepository,
  programmeRevisionRepo,
  activityRepository,
  activityDependencyRepository,
  auditLogRepository,
} from '@/repositories'
import {
  validateProgrammeSnapshot,
  serializeSnapshot,
  deserializeSnapshot,
  computeSnapshotContentHash,
  replaySchedule,
  CURRENT_SCHEDULE_ENGINE_VERSION,
  type ProgrammeSnapshot,
  type ProgrammeActivity,
  type ActivityDependency,
} from '@/lib/programme'
import type { ScheduleResult } from '@/lib/engines/schedule-engine'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface FinalizeProgrammeInput {
  ctx: RequestContext
  programmeId: string
}

export type FinalizeProgrammeResult =
  | {
      ok: true
      revisionId: string
      revisionNo: number
      snapshotContentHash: string
      scheduleEngineVersion: number
    }
  | Err

// ─── Service ────────────────────────────────────────────────────────────────

export const programmeService = {
  /**
   * Finalize a Programme — freeze the current mutable workspace (activities
   * + dependencies) into an immutable ProgrammeRevision.
   *
   * Q1: The ENTIRE finalization happens inside a SINGLE TRANSACTION:
   *   1. SELECT FOR UPDATE on the Programme row (lock).
   *   2. Read Activities + Dependencies (under the lock — snapshot-at-lock).
   *   3. Build the ProgrammeSnapshot.
   *   4. Validate the snapshot.
   *   5. Compute the SHA-256 content hash (from the content projection).
   *   6. Read the latest revisionNo (under the lock).
   *   7. Create the finalized ProgrammeRevision.
   *   8. Write the audit log.
   *
   * This ensures the finalized snapshot is a transactionally consistent view
   * of the workspace — no concurrent Activity mutation can produce a
   * partially-mixed snapshot, because the Programme row lock serializes
   * finalization against mutations (Q2: activityRepository.update also takes
   * the Programme lock).
   *
   * The service NEVER accepts a caller-supplied snapshot, hash, revisionNo,
   * or scheduleEngineVersion. All are derived from the workspace and the
   * constant CURRENT_SCHEDULE_ENGINE_VERSION.
   */
  async finalizeProgramme(
    input: FinalizeProgrammeInput,
  ): Promise<FinalizeProgrammeResult> {
    const { ctx, programmeId } = input

    // Pre-flight: verify the programme exists (tenant-scoped). This is a
    // read-only check before the transaction — the authoritative read is
    // inside the transaction under the lock.
    const programmeExists = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programmeExists) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // Q1: The entire finalization happens inside one transaction.
    const result = await dbTx.$transaction(async (tx) => {
      // Q1: Lock the Programme row FIRST — before reading any workspace data.
      // This serializes against concurrent finalizations AND against
      // activityRepository.update (Q2) which also takes this lock.
      await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} FOR UPDATE`

      // Q1: Read Activities + Dependencies UNDER THE LOCK.
      // This is the authoritative snapshot — no concurrent mutation can
      // produce a partially-mixed state.
      const [activities, dependencies] = await Promise.all([
        activityRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
        activityDependencyRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
      ])

      // Build the snapshot from the locked workspace state.
      const snapshotActivities: ProgrammeActivity[] = activities.map((a) => ({
        id: a.id,
        name: a.name,
        duration: a.duration,
        constructionRefs: {
          estimateLineId: a.estimateLineId,
          workDefinitionVersionId: a.workDefinitionVersionId,
          workPackageId: null,
        },
        plannedQuantity: a.plannedQuantity,
        status: a.status as 'planned' | 'in-progress' | 'complete',
        predecessorDependencies: [],
      }))

      const snapshotDependencies: ActivityDependency[] = dependencies.map((d) => ({
        id: d.id,
        predecessorActivityId: d.predecessorActivityId,
        successorActivityId: d.successorActivityId,
        type: d.type as 'FS' | 'SS' | 'FF' | 'SF',
        lag: d.lag,
      }))

      const snapshot: ProgrammeSnapshot = {
        programmeId,
        programmeName: programmeExists.name,
        revisionNo: 0, // assigned below; NOT part of the content hash (P1)
        scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
        activities: snapshotActivities,
        dependencies: snapshotDependencies,
        finalizedAt: '', // assigned below; NOT part of the content hash (P1)
      }

      // Validate the snapshot.
      const validation = validateProgrammeSnapshot(snapshot)
      if (!validation.ok) {
        throw new Error(`Programme snapshot validation failed: ${validation.errors.join('; ')}`)
      }

      // Compute the content hash from the content projection (P1).
      const snapshotContentHash = computeSnapshotContentHash(snapshot)

      // Read the latest revisionNo (under the lock).
      const latestRevisionNo = await programmeRevisionRepo.getLatestRevisionNoInTransaction(
        tx,
        ctx.organizationId,
        programmeId,
      )
      const revisionNo = latestRevisionNo + 1

      // Build the final snapshot with real metadata for persistence.
      const finalSnapshot: ProgrammeSnapshot = {
        ...snapshot,
        revisionNo,
        finalizedAt: new Date().toISOString(),
      }
      const finalSnapshotJson = serializeSnapshot(finalSnapshot)

      // Create the finalized revision.
      const revision = await programmeRevisionRepo.createFinalized(tx, {
        programmeId,
        revisionNo,
        snapshotJson: finalSnapshotJson,
        snapshotContentHash,
        scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
        finalizedById: ctx.userId,
      })

      // Audit.
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'programme.revision-finalized',
        entityType: 'ProgrammeRevision',
        entityId: revision.id,
        summary: `Programme revision ${revisionNo} finalized: ${programmeExists.name} (${programmeId})`,
        afterJson: JSON.stringify({
          programmeId,
          revisionId: revision.id,
          revisionNo,
          snapshotContentHash,
          scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
          activityCount: snapshotActivities.length,
          dependencyCount: snapshotDependencies.length,
        }),
      })

      return revision
    }).catch((e: unknown) => {
      // If the error is a validation error, return a 422.
      if (e instanceof Error && e.message.includes('validation failed')) {
        return { _validationError: e.message }
      }
      throw e
    })

    // Handle validation errors thrown from inside the transaction.
    if (result && '_validationError' in result) {
      return {
        ok: false,
        error: (result as { _validationError: string })._validationError,
        status: 422,
      }
    }

    return {
      ok: true,
      revisionId: result.id,
      revisionNo: result.revisionNo,
      snapshotContentHash: result.snapshotContentHash,
      scheduleEngineVersion: result.scheduleEngineVersion,
    }
  },

  /**
   * Get a programme workspace (mutable activities + dependencies + revisions).
   */
  async getProgramme(ctx: RequestContext, programmeId: string) {
    return programmeRepository.getForOrganization(ctx.organizationId, programmeId)
  },

  /**
   * List programmes for an organization (optionally per opportunity).
   */
  async listProgrammes(ctx: RequestContext, opportunityId?: string) {
    return programmeRepository.listForOrganization(ctx.organizationId, opportunityId)
  },

  /**
   * S1: Get the CPM schedule for a programme — either from an immutable
   * ProgrammeRevision (historical truth) or from the current mutable workspace
   * (live preview).
   *
   * revisionId supplied → immutable ProgrammeRevision:
   *   deserialize snapshotJson → replaySchedule() → ScheduleResult
   *
   * revisionId absent → current mutable workspace:
   *   construct snapshot in memory → validate → replaySchedule() → ScheduleResult
   *
   * The browser renders schedule truth; it does not create schedule truth.
   * The CPM engine (replaySchedule) owns all date/float/critical-path logic.
   * The UI must NOT reproduce FS/SS/FF/SF/lag calculations.
   */
  async getProgrammeSchedule(
    input: {
      ctx: RequestContext
      programmeId: string
      revisionId?: string
    },
  ): Promise<
    | {
        ok: true
        mode: 'revision' | 'workspace'
        revisionId?: string
        revisionNo?: number
        snapshotContentHash?: string
        scheduleEngineVersion: number
        schedule: ScheduleResult
        programmeName: string
      }
    | Err
  > {
    const { ctx, programmeId, revisionId } = input

    // ── Revision mode: immutable historical truth ──────────────────────────
    if (revisionId) {
      const revision = await programmeRevisionRepo.getForOrganization(
        ctx.organizationId,
        revisionId,
      )
      if (!revision) {
        return { ok: false, error: 'Programme revision not found in this organization', status: 404 }
      }
      if (revision.status !== 'finalized') {
        return { ok: false, error: 'Programme revision is not finalized', status: 422 }
      }

      const snapshot = deserializeSnapshot(revision.snapshotJson)
      const schedule = replaySchedule(snapshot)

      return {
        ok: true,
        mode: 'revision',
        revisionId: revision.id,
        revisionNo: revision.revisionNo,
        snapshotContentHash: revision.snapshotContentHash,
        scheduleEngineVersion: revision.scheduleEngineVersion,
        schedule,
        programmeName: revision.programme.name,
      }
    }

    // ── Workspace mode: current mutable preview ────────────────────────────
    const programme = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programme) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // Build a snapshot from the current mutable workspace (NOT under a lock —
    // this is a read-only preview, not a finalization. The schedule may
    // change if the workspace is edited concurrently, which is acceptable for
    // a live preview.)
    const activities: ProgrammeActivity[] = programme.activities.map((a) => ({
      id: a.id,
      name: a.name,
      duration: a.duration,
      constructionRefs: {
        estimateLineId: a.estimateLineId,
        workDefinitionVersionId: a.workDefinitionVersionId,
        workPackageId: null,
      },
      plannedQuantity: a.plannedQuantity,
      status: a.status as 'planned' | 'in-progress' | 'complete',
      predecessorDependencies: [],
    }))

    const dependencies: ActivityDependency[] = programme.dependencies.map((d) => ({
      id: d.id,
      predecessorActivityId: d.predecessorActivityId,
      successorActivityId: d.successorActivityId,
      type: d.type as 'FS' | 'SS' | 'FF' | 'SF',
      lag: d.lag,
    }))

    const snapshot: ProgrammeSnapshot = {
      programmeId: programme.id,
      programmeName: programme.name,
      revisionNo: 0,
      scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
      activities,
      dependencies,
      finalizedAt: '',
    }

    // Validate before replaying — if the workspace has cycles or invalid
    // values, return an error rather than a partial schedule.
    const validation = validateProgrammeSnapshot(snapshot)
    if (!validation.ok) {
      return {
        ok: false,
        error: `Workspace schedule is invalid: ${validation.errors.join('; ')}`,
        status: 422,
      }
    }

    const schedule = replaySchedule(snapshot)

    return {
      ok: true,
      mode: 'workspace',
      scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
      schedule,
      programmeName: programme.name,
    }
  },
}
