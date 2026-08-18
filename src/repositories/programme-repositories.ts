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
        // R1: activities are ordered by (sequence, id) so display order and
        // snapshot determinism follow the user's arrangement of the
        // programme — not DB row insertion order. sequence is unique within
        // the programme (DB constraint), so the order is total.
        activities: { orderBy: [{ sequence: 'asc' }, { id: 'asc' }] },
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
  /**
   * Create an activity within a transaction.
   *
   * R1: `sequence` is assigned automatically to the next available slot
   * (the count of existing activities in the programme), so a newly created
   * activity always lands at the bottom of the Gantt and never collides
   * with the `@@unique([programmeId, sequence])` constraint. The count is
   * read inside the caller's transaction, so concurrent creates serialize
   * on the Programme-row lock (the caller holds it).
   *
   * NOTE: callers must already hold the Programme-row lock (SELECT FOR
   * UPDATE) before invoking this, to ensure the count is consistent with
   * the eventual insert. The X3 path in `activityDependencyRepository`
   * documents the same caller-holds-lock contract.
   */
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
    // R1: count existing activities in the programme → next sequence slot.
    // Read inside the caller's transaction (caller holds the Programme lock).
    const existingCount = await tx.activity.count({
      where: { programmeId },
    })

    return tx.activity.create({
      data: {
        programmeId,
        name: data.name,
        duration: data.duration,
        plannedQuantity: data.plannedQuantity ?? null,
        status: 'planned',
        estimateLineId: data.estimateLineId ?? null,
        workDefinitionVersionId: data.workDefinitionVersionId ?? null,
        sequence: existingCount,
      },
    })
  },

  /**
   * List activities for a programme within a transaction (for snapshot-at-lock).
   * Q1: used inside the finalization transaction after the Programme row is locked.
   * R1: ordered by (sequence, id) for snapshot determinism.
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
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    })
  },

  /**
   * List activities for a programme (tenant-scoped via programme).
   * R1: ordered by (sequence, id) for snapshot determinism.
   */
  async listForProgramme(orgId: string, programmeId: string) {
    return db.activity.findMany({
      where: {
        programmeId,
        programme: { organizationId: orgId },
      },
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    })
  },

  /**
   * Q2: Update a mutable activity. Takes the Programme row lock first to
   * serialize against concurrent finalization. The lock ensures that a
   * finalization running in parallel either sees the pre-edit or post-edit
   * state, never a partially-mixed snapshot.
   *
   * R1: `sequence` is included in the updatable fields. It is a mutable
   * presentation property; callers handle swap-on-set semantics at the
   * service layer to honour the `@@unique([programmeId, sequence])`
   * constraint. Direct callers of this method that set `sequence` must
   * ensure no other activity in the programme currently holds that value
   * (otherwise the DB will reject with P2002).
   */
  async update(orgId: string, activityId: string, data: {
    name?: string
    duration?: number
    plannedQuantity?: number | null
    status?: string
    estimateLineId?: string | null
    workDefinitionVersionId?: string | null
    sequence?: number
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

  /**
   * R1: Update an activity WITHIN a caller-held transaction. The caller
   * (ProgrammeService.updateActivity) has ALREADY acquired the Programme
   * row lock (SELECT FOR UPDATE) and resolved any sequence conflict via
   * swap-on-set semantics. This method does NOT lock — the caller holds
   * the lock.
   *
   * Mirrors `activityDependencyRepository.updateInTransaction`:
   *   - identity check (activity belongs to programme)
   *   - update with the supplied fields (no lock)
   *
   * Used for activity rename + reorder so the swap-on-set logic runs in a
   * single transaction with both row updates (the target activity's new
   * sequence + the conflicting activity's old sequence).
   */
  async updateInTransaction(
    tx: Tx,
    programmeId: string,
    activityId: string,
    data: {
      name?: string
      sequence?: number
    },
  ) {
    // Identity check: the activity must belong to this programme.
    const existing = await tx.activity.findFirst({
      where: { id: activityId, programmeId },
      select: { id: true, programmeId: true },
    })
    if (!existing) {
      throw new Error(
        `Activity "${activityId}" not found in programme "${programmeId}"`,
      )
    }
    return tx.activity.update({
      where: { id: activityId },
      data,
    })
  },
}

// ─── Activity Dependency Repository (X3: same-Programme enforcement) ────────

export const activityDependencyRepository = {
  /**
   * Create a dependency.
   * X3: enforces that predecessor.programmeId === successor.programmeId ===
   * dependency.programmeId. Throws if any activity belongs to a different
   * programme. This is a domain-identity invariant — a dependency edge cannot
   * cross programme boundaries.
   *
   * R1: Takes the Programme row lock FIRST to serialize against concurrent
   * finalization. This completes the invariant:
   *   Programme row lock = workspace mutation/finalization serialization boundary
   */
  async create(
    orgId: string,
    programmeId: string,
    data: {
      predecessorActivityId: string
      successorActivityId: string
      type: string
      lag?: number
    },
  ) {
    return dbTx.$transaction(async (tx) => {
      // R1: Lock the Programme row before any workspace read/mutation.
      await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} AND "organizationId" = ${orgId} FOR UPDATE`

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

      return tx.activityDependency.create({
        data: {
          programmeId,
          predecessorActivityId: data.predecessorActivityId,
          successorActivityId: data.successorActivityId,
          type: data.type,
          lag: data.lag ?? 0,
        },
      })
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

  /**
   * D1: Create a dependency WITHIN a caller-held transaction.
   *
   * The caller (ProgrammeService.addDependency) has ALREADY:
   *   - acquired the Programme row lock (SELECT FOR UPDATE)
   *   - read activities + dependencies under the lock
   *   - validated no self-reference, finite lag, and no resulting cycle
   *
   * This method does the authoritative X3 same-programme enforcement
   * (predecessor + successor both belong to `programmeId`) and persists.
   * It does NOT lock — the caller holds the lock. It does NOT do cycle
   * detection — that is the service's responsibility (it needs the full
   * graph, which is domain logic, not repository logic).
   *
   * Throws if either activity is not found in the programme (X3).
   */
  async createInTransaction(
    tx: Tx,
    programmeId: string,
    data: {
      predecessorActivityId: string
      successorActivityId: string
      type: string
      lag: number
    },
  ) {
    // X3: Verify both activities belong to the SAME programme. This is the
    // authoritative same-programme enforcement — a dependency edge cannot
    // cross programme boundaries.
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

    return tx.activityDependency.create({
      data: {
        programmeId,
        predecessorActivityId: data.predecessorActivityId,
        successorActivityId: data.successorActivityId,
        type: data.type,
        lag: data.lag,
      },
    })
  },

  /**
   * D2: Update a dependency's type and/or lag WITHIN a caller-held
   * transaction. The dependency row ID is the stable identity (U1); type
   * and lag are MUTABLE PROPERTIES of the relationship.
   *
   * The caller (ProgrammeService.updateDependency) has ALREADY:
   *   - acquired the Programme row lock (SELECT FOR UPDATE)
   *   - verified the dependency belongs to the programme + tenant
   *   - validated finite lag + valid type
   *   - built the would-be graph and validated no cycle
   *
   * This method does the authoritative identity check:
   *   dependency.programmeId === programmeId
   * (tenant ownership is verified via the Programme relation upstream).
   *
   * Returns the updated dependency row. Throws if the dependency is not
   * found in this programme (404-equivalent at the repo boundary — the
   * service converts this to a typed error).
   *
   * NOTE: predecessor/successor are NOT updatable here — they ARE the
   * identity (U1). To change the ordered pair, delete + create.
   */
  async updateInTransaction(
    tx: Tx,
    programmeId: string,
    dependencyId: string,
    data: {
      type: string
      lag: number
    },
  ) {
    // Identity check: the dependency must belong to this programme.
    // This is the authoritative programme-membership enforcement.
    const existing = await tx.activityDependency.findFirst({
      where: { id: dependencyId, programmeId },
      select: { id: true, programmeId: true },
    })
    if (!existing) {
      throw new Error(
        `Dependency "${dependencyId}" not found in programme "${programmeId}"`,
      )
    }

    return tx.activityDependency.update({
      where: { id: dependencyId },
      data: {
        type: data.type,
        lag: data.lag,
      },
    })
  },

  /**
   * D3: Delete a single dependency WITHIN a caller-held transaction.
   *
   * The caller (ProgrammeService.deleteDependency) has ALREADY acquired the
   * Programme row lock. This method does the authoritative identity check
   * (dependency.programmeId === programmeId) + delete.
   *
   * Returns the deleted dependency row (or null if not found in this
   * programme — the service converts this to a 404).
   */
  async deleteInTransaction(
    tx: Tx,
    programmeId: string,
    dependencyId: string,
  ) {
    // Identity check: the dependency must belong to this programme.
    const existing = await tx.activityDependency.findFirst({
      where: { id: dependencyId, programmeId },
      select: { id: true, programmeId: true },
    })
    if (!existing) {
      return null
    }

    return tx.activityDependency.delete({
      where: { id: dependencyId },
    })
  },

  /**
   * R1: Delete all dependencies for a programme. Takes the Programme row lock
   * first to serialize against concurrent finalization.
   */
  async deleteForProgramme(orgId: string, programmeId: string) {
    return dbTx.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Programme" WHERE id = ${programmeId} AND "organizationId" = ${orgId} FOR UPDATE`
      return tx.activityDependency.deleteMany({
        where: { programmeId },
      })
    })
  },
}
