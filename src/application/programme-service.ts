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
  computeSnapshotContentHash,
  CURRENT_SCHEDULE_ENGINE_VERSION,
  type ProgrammeSnapshot,
  type ProgrammeActivity,
  type ActivityDependency,
} from '@/lib/programme'

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
   * The service:
   * 1. Loads the programme tenant-scoped (via programmeRepository).
   * 2. Builds a ProgrammeSnapshot from the current mutable activities + deps.
   * 3. Validates the snapshot (duplicates, dangling refs, cycles, finite
   *    values, self-references).
   * 4. Serializes to canonical JSON + computes the SHA-256 content hash.
   * 5. In a SINGLE TRANSACTION: reads the latest revisionNo, creates the
   *    finalized revision (with the derived revisionNo + snapshot + hash +
   *    engine version), and writes the audit log.
   *
   * The service NEVER accepts a caller-supplied snapshot, hash, revisionNo,
   * or scheduleEngineVersion. All are derived from the workspace and the
   * constant CURRENT_SCHEDULE_ENGINE_VERSION.
   */
  async finalizeProgramme(
    input: FinalizeProgrammeInput,
  ): Promise<FinalizeProgrammeResult> {
    const { ctx, programmeId } = input

    // 1. Load the programme tenant-scoped.
    const programme = await programmeRepository.getForOrganization(
      ctx.organizationId,
      programmeId,
    )
    if (!programme) {
      return { ok: false, error: 'Programme not found in this organization', status: 404 }
    }

    // 2. Build the snapshot from the current mutable workspace.
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
      revisionNo: 0, // placeholder — the real revisionNo is assigned in the transaction
      scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
      activities,
      dependencies,
      // finalizedAt is NOT part of the content hash — it's audit metadata.
      // Using an empty string here so the hash depends only on the schedule
      // content (activities + dependencies + engine version + programme identity).
      // The real finalizedAt is persisted on the ProgrammeRevision row itself.
      finalizedAt: '',
    }

    // 3. Validate the snapshot.
    const validation = validateProgrammeSnapshot(snapshot)
    if (!validation.ok) {
      return {
        ok: false,
        error: `Programme snapshot validation failed: ${validation.errors.join('; ')}`,
        status: 422,
      }
    }

    // 4. Serialize + hash (pure, deterministic).
    // The content hash is computed from the SCHEDULE CONTENT only — activities,
    // dependencies, engine version, and programme identity. It does NOT include
    // revisionNo or finalizedAt (those are metadata, not content). This means
    // two finalizations of the same workspace produce the same content hash,
    // which is the correct reproducibility invariant.
    const snapshotJson = serializeSnapshot(snapshot)
    const snapshotContentHash = computeSnapshotContentHash(snapshot)

    // 5. Create the finalized revision IN A SINGLE TRANSACTION.
    // A1: getLatestRevisionNoInTransaction + createFinalized happen atomically
    // so two concurrent finalizations cannot both calculate the same revisionNo.
    const result = await dbTx.$transaction(async (tx) => {
      const latestRevisionNo = await programmeRevisionRepo.getLatestRevisionNoInTransaction(
        tx,
        ctx.organizationId,
        programmeId,
      )
      const revisionNo = latestRevisionNo + 1

      // The persisted snapshot carries the real revisionNo (for human inspection),
      // but the content hash was computed from the content-only snapshot above.
      // The hash identifies the schedule CONTENT; the revisionNo is metadata.
      const finalSnapshot: ProgrammeSnapshot = {
        ...snapshot,
        revisionNo,
      }
      const finalSnapshotJson = serializeSnapshot(finalSnapshot)

      const revision = await programmeRevisionRepo.createFinalized(tx, {
        programmeId,
        revisionNo,
        snapshotJson: finalSnapshotJson,
        snapshotContentHash, // from the content-only hash (step 4)
        scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
        finalizedById: ctx.userId,
      })

      // Audit.
      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'programme.revision-finalized',
        entityType: 'ProgrammeRevision',
        entityId: revision.id,
        summary: `Programme revision ${revisionNo} finalized: ${programme.name} (${programmeId})`,
        afterJson: JSON.stringify({
          programmeId,
          revisionId: revision.id,
          revisionNo,
          snapshotContentHash: snapshotContentHash,
          scheduleEngineVersion: CURRENT_SCHEDULE_ENGINE_VERSION,
          activityCount: activities.length,
          dependencyCount: dependencies.length,
        }),
      })

      return revision
    })

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
}
