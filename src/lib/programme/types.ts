/**
 * Programme Domain Contract — the authoritative type definitions for the
 * construction schedule domain.
 *
 * ARCHITECTURE (approved milestone):
 *
 *   Programme (mutable planning workspace)
 *       ↓ finalize
 *   ProgrammeRevision (immutable schedule snapshot)
 *       ├── Activity (planned work with construction-identity relationships)
 *       └── ActivityDependency (FS/SS/FF/SF + lag — the CPM edges)
 *
 * PARALLEL TO THE COMMERCIAL DOMAIN:
 *
 *   EstimateRevision = historical commercial truth (immutable)
 *   ProgrammeRevision = historical schedule truth (immutable)
 *
 * The two remain SEPARATE sources of truth. The construction information graph
 * provides relationships between them — it does NOT turn everything into one
 * giant mutable construction object.
 *
 *   Programme = mutable planning workspace
 *   ProgrammeRevision = immutable schedule decision
 *
 * KEY RULES:
 *
 * 1. An Activity references construction identity (EstimateLine?,
 *    WorkDefinitionVersion?, WorkPackage?) via RELATIONSHIPS — it does NOT
 *    copy commercial values (unitRate, sellPrice, directCost). Those remain
 *    commercial-domain values. The schedule layer is NOT another price
 *    authority.
 *
 * 2. An Activity's quantity is NOT automatically copied from EstimateLine.
 *    quantity. The activity may carry its own planned execution quantity
 *    (which could differ from the estimated quantity), or none at all.
 *    The relationship to EstimateLine provides traceability without
 *    duplicating commercial truth.
 *
 * 3. ProgrammeRevision contains a complete schedule-graph snapshot
 *    (activities + dependencies + scheduling inputs/version). The exact
 *    schedule-engine version is part of the reproducibility story:
 *      same ProgrammeSnapshot + same schedule-engine version
 *          → same schedule result
 *    (mirroring the EstimateRevision replay guarantee).
 *
 * 4. planned ≠ actual. Actual execution remains evidence (ProjectActual).
 *    The Programme domain carries planned dates only; actuals are a separate
 *    execution-evidence layer that references the same construction identity.
 *
 * This file contains ONLY types. The pure validation/snapshot functions live
 * in snapshot.ts. No Prisma, no DB, no side effects.
 */

// ─── Programme (the mutable planning workspace) ─────────────────────────────

/**
 * A Programme is the mutable planning workspace for a project's schedule.
 * It is owned by an Organization and optionally linked to an Opportunity.
 *
 * Like Estimate is to EstimateRevision, Programme is the working surface
 * that gets finalized into an immutable ProgrammeRevision.
 *
 * (Persisted model — this contract defines the domain type; the Prisma model
 * will be added in a later schema-migration milestone, NOT this contract.)
 */
export interface Programme {
  id: string
  organizationId: string
  opportunityId: string | null
  name: string
  status: ProgrammeStatus
  createdAt: Date
  updatedAt: Date
}

/** Lifecycle of a mutable Programme. */
export type ProgrammeStatus =
  | 'draft' // being planned
  | 'baseline' // a baseline revision exists
  | 'superseded' // replaced by a newer programme

// ─── ActivityDependency (the CPM edge) ──────────────────────────────────────

/**
 * The four standard CPM precedence relationship types.
 * Mirrors the schedule engine's SchedulePredecessor.type exactly.
 */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

/**
 * A dependency between two Activities — the CPM edge.
 *
 * Mirrors the schedule engine's SchedulePredecessor:
 *   predecessorId → the activity that must complete/start first
 *   type → the precedence relationship
 *   lag → delay after the predecessor (in days; can be negative for leads)
 *
 * The dependency is a RELATIONSHIP, not a commercial constraint. It does not
 * carry quantities, prices, or costs.
 */
export interface ActivityDependency {
  id: string
  /** The activity that must finish/start first. */
  predecessorActivityId: string
  /** The activity that is constrained by the predecessor. */
  successorActivityId: string
  /** The precedence relationship type. */
  type: DependencyType
  /** Lag in days (can be negative for leads). */
  lag: number
}

// ─── Activity (planned work with construction-identity relationships) ───────

/**
 * Construction-identity references for an Activity.
 *
 * These are RELATIONSHIPS — the Activity links to construction work without
 * duplicating commercial values. The schedule layer does NOT become another
 * price authority.
 *
 * - estimateLineId: the EstimateLine this activity executes (if any).
 * - workDefinitionVersionId: the WDV this activity's work is based on.
 * - workPackageId: the WorkPackage this activity belongs to (if any —
 *   WorkPackage is a future grouping concept, deferred from this milestone).
 *
 * All references are optional — an activity may exist without any
 * construction-identity link (e.g., a mobilization activity).
 */
export interface ActivityConstructionRefs {
  /** The EstimateLine this activity executes. Carries NO commercial values. */
  estimateLineId: string | null
  /** The WorkDefinitionVersion this activity's work is based on. */
  workDefinitionVersionId: string | null
  /**
   * The WorkPackage this activity belongs to (deferred — no model yet).
   * Included in the contract so the relationship is explicit from the start.
   */
  workPackageId: string | null
}

/**
 * A planned work activity in the schedule.
 *
 * Maps faithfully to the schedule engine's ScheduleActivity:
 *   id, name, duration, predecessors[]
 *
 * But adds:
 *   - construction-identity references (relationships, NOT copied values)
 *   - planned execution quantity (OPTIONAL — not automatically copied from
 *     EstimateLine.quantity; could differ)
 *   - status (planned vs in-progress vs complete — NOT actual dates, which
 *     remain in ProjectActual)
 *
 * CRITICAL: this activity does NOT carry:
 *   - unitRate, sellPrice, directCost, or any commercial value
 *   - actualStart, actualFinish, actualQuantity (those are ProjectActual)
 * The schedule layer is planned truth only.
 */
export interface ProgrammeActivity {
  id: string
  name: string
  /** Duration in days (planned). */
  duration: number
  /** Construction-identity relationships (all optional). */
  constructionRefs: ActivityConstructionRefs
  /**
   * Planned execution quantity (OPTIONAL). NOT automatically copied from
   * EstimateLine.quantity — the activity may carry its own planned quantity
   * or none at all. If present, it means "this much work is planned for
   * this activity" — it does NOT override the estimate's commercial quantity.
   */
  plannedQuantity: number | null
  /** The activity's planning status (planned vs in-progress vs complete). */
  status: ActivityStatus
  /** Dependencies where this activity is the SUCCESSOR. */
  predecessorDependencies: ActivityDependency[]
}

/** Planning status of an activity (NOT execution status — that's ProjectActual). */
export type ActivityStatus =
  | 'planned' // not yet started
  | 'in-progress' // execution underway (tracked by ProjectActual, not by dates here)
  | 'complete' // execution finished (verified by ProjectActual)

// ─── ProgrammeRevision (the immutable schedule snapshot) ────────────────────

/**
 * A ProgrammeRevision is an immutable historical schedule snapshot.
 *
 *   Programme = mutable planning workspace
 *   ProgrammeRevision = immutable schedule decision
 *
 * Like EstimateRevision, it carries a snapshotJson that captures the COMPLETE
 * schedule graph at finalization time. The snapshot is reproducible:
 *   same ProgrammeSnapshot + same schedule-engine version
 *       → same ScheduleResult (CPM dates, float, critical path)
 *
 * The revision does NOT carry mutable dates. It carries the scheduling INPUTS
 * (activities + dependencies + durations) and the schedule-engine version that
 * computes the dates. The dates are a deterministic OUTPUT of replaying the
 * snapshot through the schedule engine — never stored as mutable state.
 */
export interface ProgrammeRevision {
  id: string
  programmeId: string
  revisionNo: number
  /** The immutable schedule-graph snapshot (JSON). See ProgrammeSnapshot. */
  snapshotJson: string
  /** 'finalized' = immutable. Only finalized revisions can be referenced by a Bid. */
  status: ProgrammeRevisionStatus
  /** 'programme' (distinguishes from 'estimate' revisions on EstimateRevision). */
  revisionType: 'programme'
  finalizedAt: Date | null
  finalizedById: string | null
  createdAt: Date
}

export type ProgrammeRevisionStatus = 'draft' | 'finalized'

// ─── ProgrammeSnapshot (the immutable schedule graph) ───────────────────────

/**
 * The schedule-engine version that computed (or will compute) the schedule
 * result for this snapshot. Part of the reproducibility story:
 *   same snapshot + same engine version → same result.
 *
 * v1 — initial: the existing CPM engine (FS/SS/FF/SF + lag, forward/backward
 * pass, critical path, float, cycle detection).
 */
export const CURRENT_SCHEDULE_ENGINE_VERSION = 1

/**
 * A complete immutable schedule-graph snapshot.
 *
 * Contains:
 *   - programme metadata (id, name)
 *   - activities (with construction-identity refs, planned quantities, durations)
 *   - dependencies (the CPM edges)
 *   - scheduling inputs/version (engine version for reproducibility)
 *
 * The snapshot is the INPUT to the schedule engine. The CPM dates, float, and
 * critical path are deterministic OUTPUTS — computed by replaying the snapshot
 * through computeSchedule(), never stored as mutable state in the snapshot.
 *
 * This mirrors the EstimateRevision pattern:
 *   EstimateRevision.snapshotJson → replayRevision() → commercial result
 *   ProgrammeRevision.snapshotJson → computeSchedule() → schedule result
 */
export interface ProgrammeSnapshot {
  programmeId: string
  programmeName: string
  revisionNo: number
  /** The schedule-engine version that computes the schedule result. */
  scheduleEngineVersion: number
  /** The activities (with construction-identity refs, planned quantities). */
  activities: ProgrammeActivity[]
  /** The dependencies (CPM edges). */
  dependencies: ActivityDependency[]
  /** When the snapshot was finalized (ISO string — for audit, not for scheduling). */
  finalizedAt: string
}

/**
 * P1: The schedule-content projection — the subset of ProgrammeSnapshot that
 * defines the schedule's commercial/scheduling identity. Used for the
 * snapshotContentHash so that:
 *
 *   same schedule content → same snapshotContentHash
 *
 * regardless of revisionNo or finalizedAt (which are metadata, not content).
 *
 * This mirrors the XLSX contentHash discipline: hash the content, not the
 * metadata. The persisted snapshotJson includes revisionNo + finalizedAt for
 * human inspection, but snapshotContentHash is computed from this projection.
 */
export interface ProgrammeSnapshotContent {
  programmeId: string
  programmeName: string
  scheduleEngineVersion: number
  activities: ProgrammeActivity[]
  dependencies: ActivityDependency[]
}

/**
 * Extract the content projection from a full snapshot (strips revisionNo +
 * finalizedAt). Used by computeSnapshotContentHash.
 */
export function extractSnapshotContent(
  snapshot: ProgrammeSnapshot,
): ProgrammeSnapshotContent {
  return {
    programmeId: snapshot.programmeId,
    programmeName: snapshot.programmeName,
    scheduleEngineVersion: snapshot.scheduleEngineVersion,
    activities: snapshot.activities,
    dependencies: snapshot.dependencies,
  }
}

// ─── Validation result ──────────────────────────────────────────────────────

/**
 * Result of validating a ProgrammeSnapshot before finalization.
 * Catches structural errors (duplicate IDs, dangling dependencies, cycles)
 * before the snapshot is frozen.
 */
export interface ProgrammeValidationResult {
  ok: boolean
  errors: string[]
  /** Activities with duplicate IDs. */
  duplicateActivityIds: string[]
  /** Dependencies referencing non-existent activities. */
  danglingDependencyRefs: string[]
  /** True if the dependency graph contains a cycle. */
  hasCycle: boolean
}

// ─── Forbidden patterns (documented, enforced by architecture) ──────────────

/**
 * The Programme domain EXPLICITLY REJECTS these patterns:
 *
 *   copying unitRate/sellPrice/directCost into an Activity  (schedule ≠ commercial)
 *   storing actualStart/actualFinish on an Activity         (actuals = ProjectActual)
 *   automatically copying EstimateLine.quantity              (planned ≠ estimated)
 *   making the schedule layer a price authority              (INVARIANT 2)
 *   storing CPM dates as mutable state in the snapshot       (they're computed outputs)
 *   introducing Calendar/ResourceAssignment in v1            (deferred — not this milestone)
 *
 * The Programme domain is SCHEDULE TRUTH only. Commercial truth stays in
 * EstimateRevision. Execution truth stays in ProjectActual. The construction
 * information graph provides relationships between them.
 */
