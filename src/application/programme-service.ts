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
  type DependencyType,
  type ChangeSummary,
  computeChangeSummary,
} from '@/lib/programme'
import type { ScheduleResult } from '@/lib/engines/schedule-engine'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

/**
 * D2: UI-facing view of a dependency edge. Carries the row ID (stable
 * identity for PATCH) + predecessor/successor activity IDs + names + the
 * mutable type/lag properties. The schedule engine's SchedulePredecessor
 * only carries the predecessor activity ID, so this view gives the UI the
 * stable row identity it needs to PATCH type/lag.
 */
export interface DependencyView {
  id: string
  programmeId: string
  predecessorActivityId: string
  predecessorName: string
  successorActivityId: string
  successorName: string
  type: DependencyType
  lag: number
}

/**
 * D1: Internal error class for dependency validation failures thrown inside
 * the locked transaction. The service catches these and converts them to
 * typed { ok: false, error, status } results. Other thrown errors (e.g. X3
 * cross-programme from the repo) propagate as 500s — they indicate a
 * service-level check was bypassed, which is a programming error.
 */
class DependencyValidationError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'DependencyValidationError'
  }
}

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

      // R1: defensive sort by (sequence, id) so the snapshot hash is
      // deterministic regardless of DB row order. The repository already
      // orders by (sequence, id), but we sort here too so the snapshot is
      // stable even if a future caller bypasses the ordered repository.
      const sortedActivities = [...activities].sort(
        (a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1),
      )

      // Build the snapshot from the locked workspace state.
      const snapshotActivities: ProgrammeActivity[] = sortedActivities.map((a) => ({
        id: a.id,
        name: a.name,
        duration: a.duration,
        sequence: a.sequence,
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
   * F1: Get a change summary comparing the current workspace against the
   * latest finalized ProgrammeRevision. This is the "what changed since
   * last revision?" surface for the finalization UX.
   *
   * The summary categorizes changes as:
   *   - "schedule-affecting" — duration or dependency changes (change CPM outputs)
   *   - "presentation" — name or sequence changes (do NOT change CPM outputs)
   *
   * If no finalized revision exists, returns a summary with all activities/
   * dependencies as "added" (the workspace is entirely new).
   *
   * PURE DIFF: the underlying computeChangeSummary is a pure function; this
   * method just loads the two snapshots (latest revision + current workspace)
   * and enriches the result with activity names for display.
   */
  async getChangeSummary(
    input: {
      ctx: RequestContext
      programmeId: string
    },
  ): Promise<
    | {
        ok: true
        summary: ChangeSummary
        latestRevisionNo: number | null
      }
    | Err
  > {
    const { ctx, programmeId } = input

    const programme = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programme) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // Build the workspace snapshot (same logic as getProgrammeSchedule workspace mode).
    const workspaceActivities: ProgrammeActivity[] = programme.activities.map((a) => ({
      id: a.id,
      name: a.name,
      duration: a.duration,
      sequence: a.sequence,
      constructionRefs: {
        estimateLineId: a.estimateLineId,
        workDefinitionVersionId: a.workDefinitionVersionId,
        workPackageId: null,
      },
      plannedQuantity: a.plannedQuantity,
      status: a.status as 'planned' | 'in-progress' | 'complete',
      predecessorDependencies: [],
    }))

    const workspaceDependencies: ActivityDependency[] = programme.dependencies.map((d) => ({
      id: d.id,
      predecessorActivityId: d.predecessorActivityId,
      successorActivityId: d.successorActivityId,
      type: d.type as DependencyType,
      lag: d.lag,
    }))

    const workspaceSnapshot: ProgrammeSnapshot = {
      programmeId,
      programmeName: programme.name,
      revisionNo: 0,
      scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
      activities: workspaceActivities,
      dependencies: workspaceDependencies,
      finalizedAt: '',
    }

    // Get the latest finalized revision (if any).
    const revisions = programme.revisions
    const latestRevision = revisions.length > 0
      ? revisions[0] // revisions are ordered by revisionNo desc
      : null

    let baseSnapshot: ProgrammeSnapshot
    if (latestRevision) {
      baseSnapshot = deserializeSnapshot(latestRevision.snapshotJson)
    } else {
      // No previous revision — the base is an empty programme.
      // All workspace activities/dependencies will appear as "added".
      baseSnapshot = {
        programmeId,
        programmeName: programme.name,
        revisionNo: 0,
        scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
        activities: [],
        dependencies: [],
        finalizedAt: '',
      }
    }

    // Compute the pure diff.
    const summary = computeChangeSummary(baseSnapshot, workspaceSnapshot)

    // Enrich dependency change names from the workspace activities.
    const nameById = new Map(workspaceActivities.map((a) => [a.id, a.name]))
    for (const dc of summary.dependencies) {
      dc.predecessorName = nameById.get(dc.predecessorActivityId) ?? dc.predecessorActivityId
      dc.successorName = nameById.get(dc.successorActivityId) ?? dc.successorActivityId
    }

    return {
      ok: true,
      summary,
      latestRevisionNo: latestRevision?.revisionNo ?? null,
    }
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
        /**
         * D2: the dependency edges with their row IDs + predecessor/successor
         * names + type/lag. The schedule engine's SchedulePredecessor only
         * carries the predecessor activity ID (not the dependency row ID),
         * so this array gives the UI the stable row identity it needs to
         * PATCH type/lag. Returned for both revision and workspace modes.
         */
        dependencies: DependencyView[]
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
      // T1: Validate that the revision belongs to the requested programme.
      // A caller in the same org could otherwise request Programme B's revision
      // while passing Programme A's ID — an identity mismatch that should fail
      // safely with 404 rather than returning the wrong programme's schedule.
      if (revision.programmeId !== programmeId) {
        return { ok: false, error: 'Programme revision does not belong to this programme', status: 404 }
      }

      const snapshot = deserializeSnapshot(revision.snapshotJson)
      const schedule = replaySchedule(snapshot)

      // D2: build the dependency views from the snapshot. The snapshot
      // carries the full graph (activities + dependencies), so we can map
      // row IDs + names for the UI.
      const activityNameById = new Map(
        snapshot.activities.map((a) => [a.id, a.name]),
      )
      const dependencyViews: DependencyView[] = snapshot.dependencies.map((d) => ({
        id: d.id,
        programmeId: snapshot.programmeId,
        predecessorActivityId: d.predecessorActivityId,
        predecessorName: activityNameById.get(d.predecessorActivityId) ?? '?',
        successorActivityId: d.successorActivityId,
        successorName: activityNameById.get(d.successorActivityId) ?? '?',
        type: d.type,
        lag: d.lag,
      }))

      return {
        ok: true,
        mode: 'revision',
        revisionId: revision.id,
        revisionNo: revision.revisionNo,
        snapshotContentHash: revision.snapshotContentHash,
        scheduleEngineVersion: revision.scheduleEngineVersion,
        schedule,
        programmeName: revision.programme.name,
        dependencies: dependencyViews,
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
    //
    // R1: defensive sort by (sequence, id) so display order and snapshot
    // hash are stable regardless of DB row order. The repository already
    // orders by (sequence, id); this sort is a defense-in-depth guarantee.
    const sortedWorkspaceActivities = [...programme.activities].sort(
      (a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1),
    )

    const activities: ProgrammeActivity[] = sortedWorkspaceActivities.map((a) => ({
      id: a.id,
      name: a.name,
      duration: a.duration,
      sequence: a.sequence,
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

    // D2: build the dependency views from the workspace graph. The
    // programme.activities include names; programme.dependencies carry the
    // row IDs. This gives the UI the stable row identity for PATCH.
    const activityNameById = new Map(
      programme.activities.map((a) => [a.id, a.name]),
    )
    const dependencyViews: DependencyView[] = programme.dependencies.map((d) => ({
      id: d.id,
      programmeId: programme.id,
      predecessorActivityId: d.predecessorActivityId,
      predecessorName: activityNameById.get(d.predecessorActivityId) ?? '?',
      successorActivityId: d.successorActivityId,
      successorName: activityNameById.get(d.successorActivityId) ?? '?',
      type: d.type as DependencyType,
      lag: d.lag,
    }))

    return {
      ok: true,
      mode: 'workspace',
      scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
      schedule,
      programmeName: programme.name,
      dependencies: dependencyViews,
    }
  },

  /**
   * V2: Update an activity's duration — the first controlled schedule mutation.
   *
   * The user edits workspace INPUTS (duration); the scheduling engine derives
   * schedule OUTPUTS (start, finish, float, critical path). The UI never
   * edits computed CPM dates directly.
   *
   * Flow:
   *   RequestContext → tenant + programme validation → Programme-row lock
   *   → update Activity.duration → return updated workspace schedule
   *
   * The Programme-row lock (via activityRepository.update) serializes against
   * concurrent finalization — a finalization running in parallel sees either
   * the pre-edit or post-edit duration, never a mixed state.
   *
   * Validation:
   *   - duration must be finite (Number.isFinite)
   *   - duration must be >= 0
   *   - The activity must belong to the requested programme (same org)
   *
   * Returns the updated ScheduleResult so the UI can re-render immediately.
   */
  async updateActivityDuration(
    input: {
      ctx: RequestContext
      programmeId: string
      activityId: string
      duration: number
    },
  ): Promise<
    | {
        ok: true
        schedule: ScheduleResult
        programmeName: string
        dependencies: DependencyView[]
      }
    | Err
  > {
    const { ctx, programmeId, activityId, duration } = input

    // Validate the duration BEFORE touching the database.
    if (!Number.isFinite(duration)) {
      return { ok: false, error: 'Duration must be a finite number', status: 422 }
    }
    if (duration < 0) {
      return { ok: false, error: 'Duration must be >= 0', status: 422 }
    }

    // Verify the programme exists (tenant-scoped).
    const programme = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programme) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // Verify the activity belongs to this programme.
    const activity = programme.activities.find((a) => a.id === activityId)
    if (!activity) {
      return { ok: false, error: 'Activity not found in this programme', status: 404 }
    }

    // Update the activity (activityRepository.update takes the Programme-row lock).
    await activityRepository.update(ctx.organizationId, activityId, { duration })

    // Re-fetch the schedule to return the updated CPM result.
    const scheduleResult = await this.getProgrammeSchedule({
      ctx,
      programmeId,
    })
    if (!scheduleResult.ok) {
      return scheduleResult
    }

    return {
      ok: true,
      schedule: scheduleResult.schedule,
      programmeName: scheduleResult.programmeName,
      dependencies: scheduleResult.dependencies,
    }
  },

  /**
   * D1: Add a dependency edge — the second controlled schedule mutation.
   *
   * The user adds workspace INPUTS (a precedence edge: predecessor,
   * successor, type, lag); the scheduling engine derives schedule OUTPUTS
   * (start, finish, float, critical path). The UI never edits computed CPM
   * dates directly.
   *
   * Flow (snapshot-at-lock — mirrors finalizeProgramme):
   *   RequestContext
   *       ↓
   *   validate type ∈ {FS,SS,FF,SF} + finite lag  (pure, pre-DB)
   *       ↓
   *   pre-flight: programme exists (tenant-scoped read)
   *       ↓
   *   TRANSACTION:
   *     SELECT FOR UPDATE on Programme row  (lock)
   *     read activities + dependencies UNDER THE LOCK
   *     verify both activities exist in programme  → 404
   *     check self-reference (pred === succ)       → 422
   *     build would-be snapshot (current deps + new edge)
   *     validateProgrammeSnapshot (cycle + finite) → 422 on cycle
   *     activityDependencyRepository.createInTransaction  (X3 + persist)
   *       ↓
   *   getProgrammeSchedule (workspace preview with the new edge)
   *       ↓
   *   updated ScheduleResult
   *
   * CONCURRENCY: the cycle check is authoritative because it runs INSIDE the
   * Programme-row lock. Two concurrent addDependency calls that would jointly
   * form a cycle cannot both pass: the second sees the first's committed edge
   * under the lock. This is the snapshot-at-lock discipline (Q1) applied to
   * dependency creation.
   *
   * Validation summary (the server must validate all of these):
   *   same tenant        — programmeRepository.getForOrganization (tenant scope)
   *   same programme     — X3 in createInTransaction (pred+succ both in programme)
   *   activities exist   — service checks under the lock → 404
   *   no self-reference  — service checks (pred !== succ) → 422
   *   finite lag         — service checks pre-DB (Number.isFinite) → 422
   *   valid type         — service checks pre-DB (∈ {FS,SS,FF,SF}) → 422
   *   no cycle           — validateProgrammeSnapshot under the lock → 422
   *   no duplicate edge  — U1: service checks under the lock → 409
   *
   * U1 — DEPENDENCY IDENTITY: a dependency is identified by the ordered pair
   * (predecessor, successor) within a programme. type and lag are MUTABLE
   * PROPERTIES, not part of the identity. Adding A→B when A→B already exists
   * (even with a different type/lag) is rejected with 409 Conflict. The
   * caller must PATCH the existing edge. The DB enforces this via
   * @@unique([programmeId, predecessorActivityId, successorActivityId]).
   */
  async addDependency(
    input: {
      ctx: RequestContext
      programmeId: string
      predecessorActivityId: string
      successorActivityId: string
      type: DependencyType
      lag: number
    },
  ): Promise<
    | {
        ok: true
        schedule: ScheduleResult
        programmeName: string
        dependencies: DependencyView[]
      }
    | Err
  > {
    const {
      ctx,
      programmeId,
      predecessorActivityId,
      successorActivityId,
      type,
      lag,
    } = input

    // ── Pre-DB validation (pure) ──────────────────────────────────────────
    const VALID_TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF']
    if (!VALID_TYPES.includes(type)) {
      return { ok: false, error: `Invalid dependency type: ${type}`, status: 422 }
    }
    if (!Number.isFinite(lag)) {
      return { ok: false, error: 'Lag must be a finite number', status: 422 }
    }

    // Pre-flight: verify the programme exists (tenant-scoped). The
    // authoritative read is inside the transaction under the lock.
    const programmeExists = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programmeExists) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // ── Transaction: lock → read → validate → persist ─────────────────────
    try {
      await dbTx.$transaction(async (tx) => {
        // Lock the Programme row FIRST (snapshot-at-lock, Q1).
        await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} FOR UPDATE`

        // Read activities + dependencies UNDER THE LOCK.
        const [activities, dependencies] = await Promise.all([
          activityRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
          activityDependencyRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
        ])

        // Verify both activities exist in this programme.
        const predExists = activities.some((a) => a.id === predecessorActivityId)
        const succExists = activities.some((a) => a.id === successorActivityId)
        if (!predExists || !succExists) {
          throw new DependencyValidationError(
            !predExists
              ? `Predecessor activity "${predecessorActivityId}" not found in this programme`
              : `Successor activity "${successorActivityId}" not found in this programme`,
            404,
          )
        }

        // Check self-reference.
        if (predecessorActivityId === successorActivityId) {
          throw new DependencyValidationError(
            'An activity cannot depend on itself',
            422,
          )
        }

        // U1 — DEPENDENCY IDENTITY: check for an existing duplicate edge.
        // A dependency relationship is identified by the ordered pair
        // (predecessor, successor) within a programme. Between any two
        // activities there is exactly ONE dependency relationship; type and
        // lag are MUTABLE PROPERTIES, not part of the identity.
        //
        // If an A→B edge already exists (regardless of its current type/lag),
        // reject with 409 Conflict. The caller must PATCH the existing edge
        // to change its type or lag — not create a competing one.
        //
        // This check runs inside the Programme-row lock, so it is
        // authoritative: a concurrent addDependency cannot create a duplicate
        // between the check and the insert.
        const existingEdge = dependencies.find(
          (d) =>
            d.predecessorActivityId === predecessorActivityId &&
            d.successorActivityId === successorActivityId,
        )
        if (existingEdge) {
          throw new DependencyValidationError(
            `A dependency from "${predecessorActivityId}" to "${successorActivityId}" already exists (type: ${existingEdge.type}, lag: ${existingEdge.lag}). Update the existing dependency to change its type or lag.`,
            409,
          )
        }

        // Build the WOULD-BE snapshot (current graph + the new edge) and
        // validate it. validateProgrammeSnapshot catches:
        //   - cycles (via the schedule engine's cycle detection)
        //   - non-finite values (defensive — already checked above)
        //   - dangling refs (defensive — already checked above)
        //   - self-reference (defensive — already checked above)
        // The cycle check is the novel validation here.
        const wouldBeDependencies: ActivityDependency[] = [
          ...dependencies.map((d) => ({
            id: d.id,
            predecessorActivityId: d.predecessorActivityId,
            successorActivityId: d.successorActivityId,
            type: d.type as DependencyType,
            lag: d.lag,
          })),
          {
            id: '__pending__',
            predecessorActivityId,
            successorActivityId,
            type,
            lag,
          },
        ]

        const wouldBeActivities: ProgrammeActivity[] = activities.map((a) => ({
          id: a.id,
          name: a.name,
          duration: a.duration,
          sequence: a.sequence,
          constructionRefs: {
            estimateLineId: a.estimateLineId,
            workDefinitionVersionId: a.workDefinitionVersionId,
            workPackageId: null,
          },
          plannedQuantity: a.plannedQuantity,
          status: a.status as 'planned' | 'in-progress' | 'complete',
          predecessorDependencies: [],
        }))

        const wouldBeSnapshot: ProgrammeSnapshot = {
          programmeId,
          programmeName: programmeExists.name,
          revisionNo: 0,
          scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
          activities: wouldBeActivities,
          dependencies: wouldBeDependencies,
          finalizedAt: '',
        }

        const validation = validateProgrammeSnapshot(wouldBeSnapshot)
        if (validation.hasCycle) {
          throw new DependencyValidationError(
            'Dependency would create a cycle — schedule is infeasible',
            422,
          )
        }
        if (!validation.ok) {
          // Defensive: should not happen if the checks above passed.
          throw new DependencyValidationError(
            `Dependency validation failed: ${validation.errors.join('; ')}`,
            422,
          )
        }

        // Persist — createInTransaction does the authoritative X3
        // same-programme enforcement + insert.
        await activityDependencyRepository.createInTransaction(tx, programmeId, {
          predecessorActivityId,
          successorActivityId,
          type,
          lag,
        })
      })
    } catch (e) {
      if (e instanceof DependencyValidationError) {
        return { ok: false, error: e.message, status: e.status }
      }
      // U1 backstop: if the DB-level unique constraint
      // @@unique([programmeId, predecessorActivityId, successorActivityId])
      // fires (P2002), convert it to a clean 409. This should never happen
      // in normal flow — the service checks for duplicates under the lock
      // before persisting. But if a caller bypasses the service (direct repo
      // call) or a race slips through, the DB constraint is the final guard.
      if (
        e !== null &&
        typeof e === 'object' &&
        'code' in e &&
        (e as { code: string }).code === 'P2002'
      ) {
        return {
          ok: false,
          error:
            'A dependency between these two activities already exists. Update the existing dependency to change its type or lag.',
          status: 409,
        }
      }
      throw e
    }

    // Re-fetch the schedule to return the updated CPM result.
    const scheduleResult = await this.getProgrammeSchedule({
      ctx,
      programmeId,
    })
    if (!scheduleResult.ok) {
      return scheduleResult
    }

    return {
      ok: true,
      schedule: scheduleResult.schedule,
      programmeName: scheduleResult.programmeName,
      dependencies: scheduleResult.dependencies,
    }
  },

  /**
   * D2: Update a dependency's type and/or lag — the third controlled
   * schedule mutation.
   *
   * The dependency ROW ID is the stable identity (U1); type and lag are
   * MUTABLE PROPERTIES. This method updates the SAME row — it never creates
   * a competing edge. To change the ordered pair (predecessor/successor),
   * delete + create.
   *
   * Flow (snapshot-at-lock — mirrors addDependency + finalizeProgramme):
   *   RequestContext
   *       ↓
   *   validate type ∈ {FS,SS,FF,SF} + finite lag  (pure, pre-DB)
   *       ↓
   *   pre-flight: programme exists (tenant-scoped read)
   *       ↓
   *   TRANSACTION:
   *     SELECT FOR UPDATE on Programme row  (lock)
   *     read activities + dependencies UNDER THE LOCK
   *     find existing dependency by row ID
   *       → not found in this programme → 404
   *     build would-be snapshot (current graph, with this edge's type/lag
   *       replaced by the new values)
   *     validateProgrammeSnapshot (cycle + finite) → 422 on cycle
   *     activityDependencyRepository.updateInTransaction  (identity + persist)
   *       ↓
   *   getProgrammeSchedule (workspace preview with the updated edge)
   *       ↓
   *   updated ScheduleResult
   *
   * CONCURRENCY: the cycle check is authoritative because it runs INSIDE the
   * Programme-row lock. A concurrent updateDependency or addDependency that
   * would jointly form a cycle cannot both pass: the second sees the first's
   * committed edge under the lock. This is the snapshot-at-lock discipline
   * (Q1) applied to dependency mutation.
   *
   * Validation summary:
   *   same tenant        — programmeRepository.getForOrganization (tenant scope)
   *   same programme     — updateInTransaction checks dependency.programmeId === programmeId
   *   dependency exists  — service checks under the lock → 404
   *   at least one field — service checks pre-DB (type or lag provided) → 422
   *   finite lag         — service checks pre-DB (if lag provided, Number.isFinite) → 422
   *   valid type         — service checks pre-DB (if type provided, ∈ {FS,SS,FF,SF}) → 422
   *   no cycle           — validateProgrammeSnapshot under the lock → 422
   *
   * U1 NOTE: predecessor/successor are NOT updatable. They ARE the identity.
   * This method only changes type and/or lag. The would-be graph uses the
   * existing predecessor/successor with the merged type/lag.
   *
   * PARTIAL UPDATE: type and lag are INDEPENDENTLY MUTABLE properties. The
   * caller may supply either, both, or (reject) neither. The service loads
   * the existing edge under the lock, merges the supplied values, then
   * validates and persists the complete resulting edge:
   *
   *   { type: 'SS' }              → change type, keep existing lag
   *   { lag: 3 }                  → change lag, keep existing type
   *   { type: 'SS', lag: 3 }      → change both
   *   {}                          → 422 (nothing to update)
   */
  async updateDependency(
    input: {
      ctx: RequestContext
      programmeId: string
      dependencyId: string
      type?: DependencyType
      lag?: number
    },
  ): Promise<
    | {
        ok: true
        schedule: ScheduleResult
        programmeName: string
        dependencies: DependencyView[]
      }
    | Err
  > {
    const { ctx, programmeId, dependencyId, type, lag } = input

    // ── Pre-DB validation (pure) ──────────────────────────────────────────
    // At least one property must be supplied.
    if (type === undefined && lag === undefined) {
      return { ok: false, error: 'At least one of type or lag must be provided', status: 422 }
    }
    const VALID_TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF']
    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return { ok: false, error: `Invalid dependency type: ${type}`, status: 422 }
    }
    if (lag !== undefined && !Number.isFinite(lag)) {
      return { ok: false, error: 'Lag must be a finite number', status: 422 }
    }

    // Pre-flight: verify the programme exists (tenant-scoped). The
    // authoritative read is inside the transaction under the lock.
    const programmeExists = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programmeExists) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // ── Transaction: lock → read → merge → validate → persist ─────────────
    try {
      await dbTx.$transaction(async (tx) => {
        // Lock the Programme row FIRST (snapshot-at-lock, Q1).
        await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} FOR UPDATE`

        // Read activities + dependencies UNDER THE LOCK.
        const [activities, dependencies] = await Promise.all([
          activityRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
          activityDependencyRepository.listForProgrammeInTransaction(tx, ctx.organizationId, programmeId),
        ])

        // Find the existing dependency by row ID. U1: the row ID is the
        // stable identity; the ordered pair (predecessor, successor) is
        // fixed for this edge.
        const existingEdge = dependencies.find((d) => d.id === dependencyId)
        if (!existingEdge) {
          throw new DependencyValidationError(
            `Dependency "${dependencyId}" not found in programme "${programmeId}"`,
            404,
          )
        }

        // MERGE: the supplied values override the existing ones. Unsupplied
        // fields keep their current value. This is the partial-update merge.
        const mergedType = type ?? (existingEdge.type as DependencyType)
        const mergedLag = lag ?? existingEdge.lag

        // Build the WOULD-BE snapshot: current graph, but with this edge's
        // type/lag replaced by the MERGED values. The predecessor/successor
        // are unchanged (they ARE the identity — U1).
        const wouldBeDependencies: ActivityDependency[] = dependencies.map((d) =>
          d.id === dependencyId
            ? {
                id: d.id,
                predecessorActivityId: d.predecessorActivityId,
                successorActivityId: d.successorActivityId,
                type: mergedType,   // MERGED
                lag: mergedLag,     // MERGED
              }
            : {
                id: d.id,
                predecessorActivityId: d.predecessorActivityId,
                successorActivityId: d.successorActivityId,
                type: d.type as DependencyType,
                lag: d.lag,
              },
        )

        const wouldBeActivities: ProgrammeActivity[] = activities.map((a) => ({
          id: a.id,
          name: a.name,
          duration: a.duration,
          sequence: a.sequence,
          constructionRefs: {
            estimateLineId: a.estimateLineId,
            workDefinitionVersionId: a.workDefinitionVersionId,
            workPackageId: null,
          },
          plannedQuantity: a.plannedQuantity,
          status: a.status as 'planned' | 'in-progress' | 'complete',
          predecessorDependencies: [],
        }))

        const wouldBeSnapshot: ProgrammeSnapshot = {
          programmeId,
          programmeName: programmeExists.name,
          revisionNo: 0,
          scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
          activities: wouldBeActivities,
          dependencies: wouldBeDependencies,
          finalizedAt: '',
        }

        // Validate the would-be graph. The cycle check is the novel
        // validation: changing type/lag can turn a non-cyclic graph into
        // a cyclic one (e.g. SS with a large lag could create a feedback
        // loop through another edge).
        const validation = validateProgrammeSnapshot(wouldBeSnapshot)
        if (validation.hasCycle) {
          throw new DependencyValidationError(
            'Updated dependency would create a cycle — schedule is infeasible',
            422,
          )
        }
        if (!validation.ok) {
          // Defensive: should not happen if the checks above passed.
          throw new DependencyValidationError(
            `Dependency validation failed: ${validation.errors.join('; ')}`,
            422,
          )
        }

        // Persist — updateInTransaction does the authoritative identity
        // check (dependency.programmeId === programmeId) + update with
        // the MERGED values.
        await activityDependencyRepository.updateInTransaction(
          tx,
          programmeId,
          dependencyId,
          { type: mergedType, lag: mergedLag },
        )
      })
    } catch (e) {
      if (e instanceof DependencyValidationError) {
        return { ok: false, error: e.message, status: e.status }
      }
      throw e
    }

    // Re-fetch the schedule to return the updated CPM result.
    const scheduleResult = await this.getProgrammeSchedule({
      ctx,
      programmeId,
    })
    if (!scheduleResult.ok) {
      return scheduleResult
    }

    return {
      ok: true,
      schedule: scheduleResult.schedule,
      programmeName: scheduleResult.programmeName,
      dependencies: scheduleResult.dependencies,
    }
  },

  /**
   * D3: Delete a dependency edge — the fourth controlled schedule mutation.
   *
   * Removes the edge from the workspace graph. The scheduling engine
   * (replaySchedule) then derives the OUTPUTS (start, finish, float,
   * critical path) from the reduced graph.
   *
   * Flow (snapshot-at-lock):
   *   RequestContext
   *       ↓
   *   pre-flight: programme exists (tenant-scoped read)
   *       ↓
   *   TRANSACTION:
   *     SELECT FOR UPDATE on Programme row  (lock)
   *     deleteInTransaction (identity check + delete)
   *       → not found in this programme → 404
   *       ↓
   *   getProgrammeSchedule (workspace preview without the deleted edge)
   *       ↓
   *   updated ScheduleResult + dependencies
   *
   * CONCURRENCY: the delete serializes against concurrent finalization and
   * other mutations via the Programme-row lock.
   *
   * Validation summary:
   *   same tenant        — programmeRepository.getForOrganization (tenant scope)
   *   same programme     — deleteInTransaction checks dependency.programmeId === programmeId
   *   dependency exists  — deleteInTransaction returns null → 404
   */
  async deleteDependency(
    input: {
      ctx: RequestContext
      programmeId: string
      dependencyId: string
    },
  ): Promise<
    | {
        ok: true
        schedule: ScheduleResult
        programmeName: string
        dependencies: DependencyView[]
      }
    | Err
  > {
    const { ctx, programmeId, dependencyId } = input

    // Pre-flight: verify the programme exists (tenant-scoped). The
    // authoritative read is inside the transaction under the lock.
    const programmeExists = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programmeExists) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // ── Transaction: lock → delete ────────────────────────────────────────
    try {
      await dbTx.$transaction(async (tx) => {
        // Lock the Programme row FIRST (snapshot-at-lock, Q1).
        await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} FOR UPDATE`

        // Delete — deleteInTransaction does the authoritative identity
        // check (dependency.programmeId === programmeId) + delete.
        const deleted = await activityDependencyRepository.deleteInTransaction(
          tx,
          programmeId,
          dependencyId,
        )
        if (!deleted) {
          throw new DependencyValidationError(
            `Dependency "${dependencyId}" not found in programme "${programmeId}"`,
            404,
          )
        }
      })
    } catch (e) {
      if (e instanceof DependencyValidationError) {
        return { ok: false, error: e.message, status: e.status }
      }
      throw e
    }

    // Re-fetch the schedule to return the updated CPM result.
    const scheduleResult = await this.getProgrammeSchedule({
      ctx,
      programmeId,
    })
    if (!scheduleResult.ok) {
      return scheduleResult
    }

    return {
      ok: true,
      schedule: scheduleResult.schedule,
      programmeName: scheduleResult.programmeName,
      dependencies: scheduleResult.dependencies,
    }
  },

  /**
   * R1/V2: Update an activity's name, sequence, and/or duration — the
   * unified controlled schedule mutation. Combines rename (R1), reorder
   * (R1), and duration edit (V2) into a SINGLE atomic transaction.
   *
   * Architectural rule (NON-NEGOTIABLE):
   *   - `sequence` is a mutable PRESENTATION property, NOT a scheduling
   *     input. The CPM engine (`replaySchedule`) receives activities by
   *     identity + dependency graph. `sequence` only affects:
   *       - display order in the Gantt
   *       - snapshot determinism (sorted by (sequence, id) before hashing)
   *   - Ordering is NOT scheduling. The user can rearrange the programme
   *     sequence, but `replaySchedule()` still determines dates, float, and
   *     critical path exclusively from duration + dependency inputs.
   *   - `name` is a semantic label on the Activity row. It MUST NOT alter
   *     EstimateLine, WorkDefinitionVersion, ProgrammeRevision, or any
   *     commercial value.
   *   - `duration` IS a scheduling input — changing it DOES recompute the
   *     schedule outputs (start, finish, float, critical path).
   *
   * ATOMIC: all supplied fields (name, sequence, duration) are updated in
   * ONE transaction under the Programme-row lock. If any validation fails
   * inside the transaction, the whole thing rolls back — no partial state.
   *
   *   one HTTP PATCH = one Programme transaction = atomic workspace mutation
   *
   * Swap-on-set semantics for sequence conflicts: when PATCHing
   * `{ sequence: N }`, if another activity in the same programme already
   * has sequence N, the service ATOMICALLY SWAPS — the target activity gets
   * N, the conflicting activity gets the target's old sequence. All in one
   * transaction under the Programme-row lock. This gives clean UX for
   * "move up/down" without requiring a separate swap endpoint.
   *
   * PARTIAL PATCH contract (mirrors updateDependency):
   *   { name: "New Name" }           → rename only (schedule UNCHANGED)
   *   { sequence: 2 }                → reorder only (swap-on-set; schedule UNCHANGED)
   *   { duration: 5 }                → duration only (schedule RECOMPUTED)
   *   { name: "X", sequence: 2 }     → rename + reorder (schedule UNCHANGED)
   *   { duration: 5, name: "X" }     → duration + rename (schedule RECOMPUTED)
   *   { duration: 5, sequence: 2 }   → duration + reorder (schedule RECOMPUTED)
   *   { duration: 5, name: "X", sequence: 2 } → all three
   *   {}                             → 422 (nothing to update)
   *
   * Flow (snapshot-at-lock — mirrors updateDependency):
   *   RequestContext
   *       ↓
   *   validate name + sequence + duration (if provided)  (pure, pre-DB)
   *       ↓
   *   pre-flight: programme exists (tenant-scoped read)
   *       ↓
   *   TRANSACTION (ATOMIC — all fields in one transaction):
   *     SELECT FOR UPDATE on Programme row  (lock)
   *     read activities UNDER THE LOCK (sorted by sequence, id)
   *     find existing activity by row ID
   *       → not found in this programme → 404
   *     if `sequence` provided and differs from current:
   *       find conflicting activity in this programme with that sequence
   *         if conflict: SWAP — set conflicting's sequence to target's
   *                      old sequence, and target's sequence to the
   *                      requested value (both updates in this transaction)
   *         if no conflict: set target's sequence to the requested value
   *     if `name` provided: update target's name
   *     if `duration` provided: update target's duration
   *     activityRepository.updateInTransaction  (identity + persist, no lock)
   *       ↓
   *   getProgrammeSchedule (workspace preview with all updates applied)
   *       ↓
   *   updated ScheduleResult
   *
   * CONCURRENCY: the swap-on-set logic runs INSIDE the Programme-row lock.
   * Two concurrent reorderings cannot both succeed in producing a duplicate
   * sequence — the second sees the first's committed state under the lock
   * and re-evaluates its swap against the updated sequences. The DB-level
   * `@@unique([programmeId, sequence])` constraint is the final guard.
   *
   * Validation summary:
   *   same tenant        — programmeRepository.getForOrganization (tenant scope)
   *   same programme     — updateInTransaction checks activity.programmeId === programmeId
   *   activity exists    — service checks under the lock → 404
   *   at least one field — service checks pre-DB (name/sequence/duration provided) → 422
   *   valid name         — service checks pre-DB (if name provided, non-empty) → 422
   *   valid sequence     — service checks pre-DB (if sequence provided,
   *                        Number.isInteger && >= 0) → 422
   *   valid duration     — service checks pre-DB (if duration provided,
   *                        Number.isFinite && >= 0) → 422
   *
   * SCHEDULE: if `duration` is supplied, the schedule IS recomputed (duration
   * is a scheduling input). If only `name`/`sequence` are supplied, the
   * schedule is UNCHANGED — ordering and naming are NOT scheduling.
   */
  async updateActivity(
    input: {
      ctx: RequestContext
      programmeId: string
      activityId: string
      name?: string
      sequence?: number
      duration?: number
    },
  ): Promise<
    | {
        ok: true
        schedule: ScheduleResult
        programmeName: string
        dependencies: DependencyView[]
      }
    | Err
  > {
    const { ctx, programmeId, activityId, name, sequence, duration } = input

    // ── Pre-DB validation (pure) ──────────────────────────────────────────
    // At least one property must be supplied.
    if (name === undefined && sequence === undefined && duration === undefined) {
      return {
        ok: false,
        error: 'At least one of name, sequence, or duration must be provided',
        status: 422,
      }
    }
    // If name is provided, it must be a non-empty string (after trim).
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return {
          ok: false,
          error: 'Name must be a non-empty string',
          status: 422,
        }
      }
    }
    // If sequence is provided, it must be a non-negative integer.
    if (sequence !== undefined) {
      if (!Number.isInteger(sequence) || sequence < 0) {
        return {
          ok: false,
          error: 'Sequence must be a non-negative integer',
          status: 422,
        }
      }
    }
    // If duration is provided, it must be finite and >= 0.
    if (duration !== undefined) {
      if (!Number.isFinite(duration)) {
        return {
          ok: false,
          error: 'Duration must be a finite number',
          status: 422,
        }
      }
      if (duration < 0) {
        return {
          ok: false,
          error: 'Duration must be >= 0',
          status: 422,
        }
      }
    }

    // Pre-flight: verify the programme exists (tenant-scoped). The
    // authoritative read is inside the transaction under the lock.
    const programmeExists = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programmeExists) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // ── Transaction: lock → read → resolve conflict (swap) → persist ──────
    // ATOMIC: all supplied fields (name, sequence, duration) are updated in
    // ONE transaction under the Programme-row lock. If any validation fails
    // inside the transaction, the whole thing rolls back — no partial state.
    // This is the "one HTTP PATCH = one Programme transaction = atomic
    // workspace mutation" invariant.
    try {
      await dbTx.$transaction(async (tx) => {
        // Lock the Programme row FIRST (snapshot-at-lock, Q1).
        await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} FOR UPDATE`

        // Read activities UNDER THE LOCK (sorted by sequence, id).
        const activities = await activityRepository.listForProgrammeInTransaction(
          tx,
          ctx.organizationId,
          programmeId,
        )

        // Find the target activity by row ID.
        const target = activities.find((a) => a.id === activityId)
        if (!target) {
          throw new DependencyValidationError(
            `Activity "${activityId}" not found in programme "${programmeId}"`,
            404,
          )
        }

        // ── Swap-on-set sequence resolution ───────────────────────────────
        // If `sequence` is provided and differs from the target's current
        // sequence, find a conflicting activity (another activity in this
        // programme holding the requested sequence). If found, swap their
        // sequences using a 3-step temporary-sequence approach to avoid
        // the P2002 unique constraint violation that would occur on
        // intermediate states.
        if (sequence !== undefined && sequence !== target.sequence) {
          const conflicting = activities.find(
            (a) => a.id !== activityId && a.sequence === sequence,
          )
          if (conflicting) {
            // SWAP via 3 steps using a temporary sequence:
            // 1. Move conflicting to a temp slot (guaranteed free: max+1)
            // 2. Set target to the requested sequence (+ name/duration if provided)
            // 3. Set conflicting to target's old sequence
            const maxSeq = Math.max(...activities.map((a) => a.sequence))
            const tempSeq = maxSeq + 1
            await activityRepository.updateInTransaction(
              tx, programmeId, conflicting.id, { sequence: tempSeq },
            )
            const targetUpdate: { name?: string; sequence?: number; duration?: number } = { sequence }
            if (name !== undefined) targetUpdate.name = name
            if (duration !== undefined) targetUpdate.duration = duration
            await activityRepository.updateInTransaction(
              tx, programmeId, activityId, targetUpdate,
            )
            await activityRepository.updateInTransaction(
              tx, programmeId, conflicting.id, { sequence: target.sequence },
            )
          } else {
            // No conflict — update target's sequence (+ name/duration if provided).
            const targetUpdate: { name?: string; sequence?: number; duration?: number } = {}
            if (name !== undefined) targetUpdate.name = name
            if (duration !== undefined) targetUpdate.duration = duration
            targetUpdate.sequence = sequence
            await activityRepository.updateInTransaction(
              tx, programmeId, activityId, targetUpdate,
            )
          }
        } else {
          // No sequence change — update name and/or duration only.
          const targetUpdate: { name?: string; duration?: number } = {}
          if (name !== undefined) targetUpdate.name = name
          if (duration !== undefined) targetUpdate.duration = duration
          if (Object.keys(targetUpdate).length > 0) {
            await activityRepository.updateInTransaction(
              tx, programmeId, activityId, targetUpdate,
            )
          }
        }
      })
    } catch (e) {
      if (e instanceof DependencyValidationError) {
        return { ok: false, error: e.message, status: e.status }
      }
      // R1 backstop: if the DB-level unique constraint
      // @@unique([programmeId, sequence]) fires (P2002), convert it to a
      // clean 409. This should never happen in normal flow — the swap-on-set
      // logic under the lock resolves conflicts before persisting. But if a
      // caller bypasses the service (direct repo call) or a race slips
      // through, the DB constraint is the final guard.
      if (
        e !== null &&
        typeof e === 'object' &&
        'code' in e &&
        (e as { code: string }).code === 'P2002'
      ) {
        return {
          ok: false,
          error:
            'A sequence conflict occurred. Reload the programme and retry the reorder.',
          status: 409,
        }
      }
      throw e
    }

    // Re-fetch the schedule to return the updated CPM result. Note: the
    // schedule itself (projectDuration, ES/EF/float, critical path) is
    // UNCHANGED by this mutation — ordering is not scheduling. Only the
    // activity's `name`/`sequence` changed, which the schedule reflects
    // through the activity list (renamed) and the ordering (sorted by
    // sequence, id) but NOT through any CPM-derived value.
    const scheduleResult = await this.getProgrammeSchedule({
      ctx,
      programmeId,
    })
    if (!scheduleResult.ok) {
      return scheduleResult
    }

    return {
      ok: true,
      schedule: scheduleResult.schedule,
      programmeName: scheduleResult.programmeName,
      dependencies: scheduleResult.dependencies,
    }
  },
}
