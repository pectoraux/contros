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
 * X1 — LEGACY DEPRECATION: EstimateRevision.revisionType='programme' is
 * DEPRECATED. All NEW programme history must go to ProgrammeRevision. The
 * existing `programmeRevisionRepository` in index.ts (which uses
 * EstimateRevision with revisionType='programme') is retained for reading
 * legacy records ONLY. No new code path should create
 * EstimateRevision(revisionType='programme'). This repository
 * (programmeRevisionRepo) is the sole authority for new programme revisions.
 *
 * X2 — IMMUTABILITY: ProgrammeRevision is create-finalized-only. There is no
 * 'draft' status, no update method, and no delete method. A revision is
 * created as 'finalized' and is then read-only. The mutable workspace is
 * Programme (and its Activities/Dependencies); the revision is the frozen
 * snapshot.
 *
 * X3 — SAME-PROGRAMME DEPENDENCY EDGES: ActivityDependency creation enforces
 * that predecessor.programmeId === successor.programmeId === dependency.
 * programmeId. This is validated transactionally before insert.
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

// ─── Programme Revision Repository (X2: create-finalized-only, immutable) ───
//
// X1: This is the SOLE authority for new programme revisions. The legacy
// `programmeRevisionRepository` in index.ts (which uses EstimateRevision with
// revisionType='programme') is DEPRECATED — retained for reading legacy
// records only. No new code should create EstimateRevision(revisionType=
// 'programme').
//
// X2: ProgrammeRevision has NO 'draft' status. It is created as 'finalized'
// and is then immutable. There is no update method and no delete method on
// this repository. The mutable workspace is Programme + Activities +
// Dependencies; the revision is the frozen snapshot.

export const programmeRevisionRepo = {
  /**
   * Create a finalized revision within a transaction. X2: the ONLY creation
   * path. The revision is born 'finalized' — there is no draft state.
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
        status: 'finalized', // X2: always finalized at creation — no draft state
        finalizedAt: new Date(),
        finalizedById: data.finalizedById,
      },
    })
  },

  /**
   * Get a finalized revision, tenant-scoped via Programme.organizationId.
   * Returns null if the revision doesn't exist OR belongs to another org.
   * X2: there is no update method — revisions are read-only after creation.
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

  /**
   * Z1: Get a finalized ProgrammeRevision for a bid submission — validates the
   * FULL chain atomically in one tenant/opportunity-scoped lookup:
   *
   *   ProgrammeRevision.id === requested
   *   ProgrammeRevision.status === 'finalized'
   *   Programme.organizationId === organizationId
   *   Programme.opportunityId === opportunityId (EXACT match — null is rejected)
   *
   * This replaces the previous BidService pattern of calling getForOrganization
   * then doing a separate db.programme.findFirst. All validation is now in the
   * repository; the service never touches Prisma directly for this operation.
   *
   * Returns null if ANY link is broken.
   */
  async getForBid(
    orgId: string,
    programmeRevisionId: string,
    opportunityId: string,
  ) {
    return db.programmeRevision.findFirst({
      where: {
        id: programmeRevisionId,
        status: 'finalized',
        programme: {
          organizationId: orgId,
          opportunityId, // EXACT match — null opportunityId on the Programme will not match
        },
      },
      include: {
        programme: {
          select: {
            id: true,
            organizationId: true,
            opportunityId: true,
            name: true,
          },
        },
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

  /**
   * A1: Get the latest revision number WITHIN a transaction, so the read +
   * create happen atomically. This prevents two concurrent finalizations
   * from both calculating the same revisionNo.
   */
  async getLatestRevisionNoInTransaction(
    tx: Tx,
    orgId: string,
    programmeId: string,
  ): Promise<number> {
    const prog = await tx.programme.findFirst({
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

  /**
   * List activities for a programme within a transaction (for snapshot-at-lock).
   * Q1: used inside the finalization transaction after the Programme row is locked.
   */
  async listForProgrammeInTransaction(
    tx: Tx,
    orgId: string,
    programmeId: string,
  ) {
    return tx.activity.findMany({
      where: {
        programmeId,
        programme: { organizationId: orgId },
      },
      orderBy: { createdAt: 'asc' },
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

  /**
   * Q2: Update a mutable activity. Takes the Programme row lock first to
   * serialize against concurrent finalization. The lock ensures that a
   * finalization running in parallel either sees the pre-edit or post-edit
   * state, never a partially-mixed snapshot.
   */
  async update(orgId: string, activityId: string, data: {
    name?: string
    duration?: number
    plannedQuantity?: number | null
    status?: string
    estimateLineId?: string | null
    workDefinitionVersionId?: string | null
  }) {
    return dbTx.$transaction(async (tx) => {
      // Q2: Lock the Programme row. First find the activity's programmeId.
      const activity = await tx.activity.findFirst({
        where: { id: activityId, programme: { organizationId: orgId } },
        select: { programmeId: true },
      })
      if (!activity) {
        throw new Error('Activity not found in this organization')
      }
      // Lock the parent Programme row.
      await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${activity.programmeId} FOR UPDATE`
      // Now update the activity.
      return tx.activity.update({
        where: { id: activityId },
        data,
      })
    })
  },
}

// ─── Activity Dependency Repository (X3: same-Programme enforcement) ────────

export const activityDependencyRepository = {
  /**
   * Create a dependency within a transaction.
   * X3: enforces that predecessor.programmeId === successor.programmeId ===
   * dependency.programmeId. Throws if any activity belongs to a different
   * programme. This is a domain-identity invariant — a dependency edge cannot
   * cross programme boundaries.
   */
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
    // X3: Verify both activities belong to the SAME programme.
    const [pred, succ] = await Promise.all([
      tx.activity.findFirst({
        where: { id: data.predecessorActivityId, programmeId },
        select: { id: true, programmeId: true },
      }),
      tx.activity.findFirst({
        where: { id: data.successorActivityId, programmeId },
        select: { id: true, programmeId: true },
      }),
    ])
    if (!pred) {
      throw new Error(
        `Cannot create dependency: predecessor "${data.predecessorActivityId}" not found in programme "${programmeId}"`,
      )
    }
    if (!succ) {
      throw new Error(
        `Cannot create dependency: successor "${data.successorActivityId}" not found in programme "${programmeId}"`,
      )
    }
    // Both activities are confirmed to belong to programmeId (the query
    // filtered by programmeId). The dependency's programmeId matches.

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

  /**
   * Q1: List dependencies for a programme within a transaction (for
   * snapshot-at-lock). Used inside the finalization transaction after the
   * Programme row is locked.
   */
  async listForProgrammeInTransaction(
    tx: Tx,
    orgId: string,
    programmeId: string,
  ) {
    return tx.activityDependency.findMany({
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
