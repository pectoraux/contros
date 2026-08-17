/**
 * Programme repositories — tenant-aware persistence for the Programme domain.
 *
 * Every method requires the authenticated organization context (INVARIANT 12).
 * Programme is the org-owned root; ProgrammeRevision, Activity, and
 * ActivityDependency are reached via Programme, so cross-tenant access is
 * impossible.
 *
 * ProgrammeRevision is tenant-safe via:
 *   revision → programme → organizationId === ctx.organizationId
 *
 * Activity → EstimateLine / WorkDefinitionVersion cross-references should be
 * additionally validated at the application-service level (same org).
 */

import { db, dbTx } from '@/lib/db'

type Tx = Parameters<Parameters<typeof dbTx.$transaction>[0]>[0]

// ─── Programme Repository ───────────────────────────────────────────────────

export const programmeRepository = {
  async create(
    orgId: string,
    data: {
      opportunityId?: string | null
      name: string
    },
  ) {
    return db.programme.create({
      data: {
        organizationId: orgId,
        opportunityId: data.opportunityId ?? null,
        name: data.name,
        status: 'draft',
      },
    })
  },

  async getForOrganization(orgId: string, programmeId: string) {
    return db.programme.findFirst({
      where: { id: programmeId, organizationId: orgId },
      include: {
        activities: { orderBy: { createdAt: 'asc' } },
        dependencies: true,
        revisions: { orderBy: { revisionNo: 'desc' } },
      },
    })
  },

  async listForOrganization(orgId: string, opportunityId?: string) {
    return db.programme.findMany({
      where: {
        organizationId: orgId,
        ...(opportunityId ? { opportunityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  async setStatus(orgId: string, programmeId: string, status: string) {
    return db.programme.updateMany({
      where: { id: programmeId, organizationId: orgId },
      data: { status },
    })
  },
}

// ─── Programme Revision Repository ──────────────────────────────────────────
// NOTE: this is the DEDICATED ProgrammeRevision repository (the new
// Programme domain). The existing `programmeRevisionRepository` in index.ts
// (which uses EstimateRevision with revisionType='programme') is the MVP
// approach and remains for backward compatibility. This new repository is
// named `programmeRevisionRepo` to avoid a naming collision.

export const programmeRevisionRepo = {
  /**
   * Create a finalized revision within a transaction.
   * Tenant-safe: the caller must have already verified programme.organizationId.
   */
  async createFinalized(
    tx: Tx,
    data: {
      programmeId: string
      revisionNo: number
      snapshotJson: string
      snapshotContentHash: string
      scheduleEngineVersion: number
      finalizedById: string
    },
  ) {
    return tx.programmeRevision.create({
      data: {
        programmeId: data.programmeId,
        revisionNo: data.revisionNo,
        snapshotJson: data.snapshotJson,
        snapshotContentHash: data.snapshotContentHash,
        scheduleEngineVersion: data.scheduleEngineVersion,
        status: 'finalized',
        finalizedAt: new Date(),
        finalizedById: data.finalizedById,
      },
    })
  },

  /**
   * Get a finalized revision, tenant-scoped via Programme.organizationId.
   * Returns null if the revision doesn't exist OR belongs to another org.
   */
  async getForOrganization(orgId: string, revisionId: string) {
    return db.programmeRevision.findFirst({
      where: {
        id: revisionId,
        programme: { organizationId: orgId },
      },
      include: {
        programme: { select: { id: true, organizationId: true, name: true } },
      },
    })
  },

  async getLatestRevisionNo(orgId: string, programmeId: string): Promise<number> {
    const prog = await db.programme.findFirst({
      where: { id: programmeId, organizationId: orgId },
      select: {
        revisions: {
          orderBy: { revisionNo: 'desc' },
          take: 1,
          select: { revisionNo: true },
        },
      },
    })
    return prog?.revisions[0]?.revisionNo ?? 0
  },
}

// ─── Activity Repository ────────────────────────────────────────────────────

export const activityRepository = {
  /** Create an activity within a transaction. */
  async create(
    tx: Tx,
    programmeId: string,
    data: {
      name: string
      duration: number
      plannedQuantity?: number | null
      estimateLineId?: string | null
      workDefinitionVersionId?: string | null
    },
  ) {
    return tx.activity.create({
      data: {
        programmeId,
        name: data.name,
        duration: data.duration,
        plannedQuantity: data.plannedQuantity ?? null,
        status: 'planned',
        estimateLineId: data.estimateLineId ?? null,
        workDefinitionVersionId: data.workDefinitionVersionId ?? null,
      },
    })
  },

  /** List activities for a programme (tenant-scoped via programme). */
  async listForProgramme(orgId: string, programmeId: string) {
    return db.activity.findMany({
      where: {
        programmeId,
        programme: { organizationId: orgId },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  /** Update a mutable activity (NOT a finalized revision's snapshot). */
  async update(orgId: string, activityId: string, data: {
    name?: string
    duration?: number
    plannedQuantity?: number | null
    status?: string
    estimateLineId?: string | null
    workDefinitionVersionId?: string | null
  }) {
    return db.activity.updateMany({
      where: {
        id: activityId,
        programme: { organizationId: orgId },
      },
      data,
    })
  },
}

// ─── Activity Dependency Repository ─────────────────────────────────────────

export const activityDependencyRepository = {
  async create(
    tx: Tx,
    programmeId: string,
    data: {
      predecessorActivityId: string
      successorActivityId: string
      type: string
      lag?: number
    },
  ) {
    return tx.activityDependency.create({
      data: {
        programmeId,
        predecessorActivityId: data.predecessorActivityId,
        successorActivityId: data.successorActivityId,
        type: data.type,
        lag: data.lag ?? 0,
      },
    })
  },

  async listForProgramme(orgId: string, programmeId: string) {
    return db.activityDependency.findMany({
      where: {
        programmeId,
        programme: { organizationId: orgId },
      },
    })
  },

  async deleteForProgramme(tx: Tx, programmeId: string) {
    return tx.activityDependency.deleteMany({
      where: { programmeId },
    })
  },
}
