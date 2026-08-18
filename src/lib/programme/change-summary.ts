/**
 * Change Summary — pure diff between two ProgrammeSnapshots.
 *
 * Compares two programme states and produces a structured summary of what
 * changed. Used for:
 *   - Workspace vs latest revision ("what changed since last finalization?")
 *   - Revision-to-revision comparison ("what changed from Rev 3 to Rev 4?")
 *
 * ARCHITECTURE:
 *   This is a PURE function — no DB, no Prisma, no side effects. It takes
 *   two ProgrammeSnapshots (base = "from", head = "to") and returns a
 *   structured ChangeSummary.
 *
 * FROM/TO CONTRACT (F2-refinement):
 *   Each change carries BOTH the `from` and `to` state, not just the "to"
 *   state. This makes the comparison a genuinely historical record rather
 *   than a current-state annotation. For example, if an activity was
 *   renamed from "Foundation" to "Substructure", the change records:
 *     from: { name: "Foundation", ... }
 *     to:   { name: "Substructure", ... }
 *   This is critical for removed activities (where the "to" snapshot cannot
 *   supply the name) and for renamed activities (where only showing the new
 *   name is misleading).
 *
 * CATEGORIZATION:
 *   Changes are categorized by their relationship to the schedule:
 *     - "schedule" — duration or dependency changes. These change the CPM
 *       outputs (start, finish, float, critical path).
 *     - "presentation" — name and sequence changes. These do NOT change the
 *       CPM outputs — they're the contractor's authored programme document.
 *     - "construction" — EstimateLine/WDV/plannedQuantity changes, activity
 *       added/removed. Construction-identity / scope changes.
 *
 * INVARIANTS:
 *   - Same snapshots → empty change summary (no changes).
 *   - The change summary is deterministic: same inputs → same output.
 *   - Activities are matched by ID (not name or sequence).
 *   - Dependencies are matched by (predecessor, successor) ordered pair (U1).
 *   - Every change carries both `from` and `to` state (null for added/removed).
 */

import type {
  ProgrammeSnapshot,
  ProgrammeActivity,
  ActivityDependency,
} from './types'

// ─── Types ──────────────────────────────────────────────────────────────────

/** A snapshot of an activity's state at one point in time (for from/to). */
export interface ActivityState {
  name: string
  sequence: number
  duration: number
  estimateLineId: string | null
  workDefinitionVersionId: string | null
  plannedQuantity: number | null
}

/** A snapshot of a dependency's state at one point in time (for from/to). */
export interface DependencyState {
  predecessorName: string
  successorName: string
  type: string
  lag: number
}

export interface ActivityChange {
  activityId: string
  kind:
    | 'added'
    | 'removed'
    | 'renamed'
    | 'reordered'
    | 'duration-changed'
    | 'estimate-line-changed'
    | 'wdv-changed'
    | 'planned-quantity-changed'
  /**
   * The activity's state in the "from" snapshot. null for "added" (the
   * activity didn't exist in the from snapshot).
   */
  from: ActivityState | null
  /**
   * The activity's state in the "to" snapshot. null for "removed" (the
   * activity didn't exist in the to snapshot).
   */
  to: ActivityState | null
  /**
   * Category of this change:
   *   - "schedule" — duration or dependency changes (change CPM outputs)
   *   - "presentation" — name or sequence changes (do NOT change CPM outputs)
   *   - "construction" — EstimateLine/WDV/plannedQuantity changes, activity
   *     added/removed (construction-identity / scope changes)
   */
  category: 'schedule' | 'presentation' | 'construction'
  /** Whether this change affects the CPM schedule outputs. */
  scheduleAffecting: boolean
}

export interface DependencyChange {
  /** The dependency's ordered pair (predecessor → successor). */
  predecessorActivityId: string
  successorActivityId: string
  kind: 'added' | 'removed' | 'type-changed' | 'lag-changed'
  /**
   * The dependency's state in the "from" snapshot. null for "added".
   * Carries predecessor/successor names from the FROM snapshot — critical
   * for removed activities (where the "to" snapshot can't supply names).
   */
  from: DependencyState | null
  /**
   * The dependency's state in the "to" snapshot. null for "removed".
   * Carries predecessor/successor names from the TO snapshot.
   */
  to: DependencyState | null
  /** Category — dependencies are always "schedule" (they affect CPM). */
  category: 'schedule'
  /** Whether this change affects the CPM schedule outputs. */
  scheduleAffecting: boolean
}

export interface ChangeSummary {
  /** True if the two snapshots differ in any way. */
  hasChanges: boolean
  /** True if any change affects the CPM schedule outputs. */
  hasScheduleChanges: boolean
  /** True if any change is presentation-only (name/sequence). */
  hasPresentationChanges: boolean
  /** True if any change is construction-domain (EstimateLine/WDV/plannedQuantity/added/removed). */
  hasConstructionChanges: boolean
  activities: ActivityChange[]
  dependencies: DependencyChange[]
  /** Counts for quick display. */
  counts: {
    activitiesAdded: number
    activitiesRemoved: number
    activitiesRenamed: number
    activitiesReordered: number
    activitiesDurationChanged: number
    activitiesEstimateLineChanged: number
    activitiesWdvChanged: number
    activitiesPlannedQuantityChanged: number
    dependenciesAdded: number
    dependenciesRemoved: number
    dependenciesTypeChanged: number
    dependenciesLagChanged: number
  }
}

// ─── Diff function ──────────────────────────────────────────────────────────

/**
 * Compute a structured change summary between two ProgrammeSnapshots.
 *
 * @param base — the "from" snapshot (before)
 * @param head — the "to" snapshot (after)
 * @returns a ChangeSummary describing what changed from base to head.
 *
 * PURE: same inputs → same output. No side effects.
 */
export function computeChangeSummary(
  base: ProgrammeSnapshot,
  head: ProgrammeSnapshot,
): ChangeSummary {
  // Build name lookups from BOTH snapshots so dependency changes can carry
  // from/to names correctly (critical for renamed/removed activities).
  const baseNameById = new Map(base.activities.map((a) => [a.id, a.name]))
  const headNameById = new Map(head.activities.map((a) => [a.id, a.name]))

  const activities = diffActivities(base.activities, head.activities)
  const dependencies = diffDependencies(
    base.dependencies,
    head.dependencies,
    baseNameById,
    headNameById,
  )

  const hasScheduleChanges =
    activities.some((a) => a.category === 'schedule') ||
    dependencies.some((d) => d.category === 'schedule')

  const hasPresentationChanges =
    activities.some((a) => a.category === 'presentation')

  const hasConstructionChanges =
    activities.some((a) => a.category === 'construction')

  return {
    hasChanges: activities.length > 0 || dependencies.length > 0,
    hasScheduleChanges,
    hasPresentationChanges,
    hasConstructionChanges,
    activities,
    dependencies,
    counts: {
      activitiesAdded: activities.filter((a) => a.kind === 'added').length,
      activitiesRemoved: activities.filter((a) => a.kind === 'removed').length,
      activitiesRenamed: activities.filter((a) => a.kind === 'renamed').length,
      activitiesReordered: activities.filter((a) => a.kind === 'reordered').length,
      activitiesDurationChanged: activities.filter((a) => a.kind === 'duration-changed').length,
      activitiesEstimateLineChanged: activities.filter((a) => a.kind === 'estimate-line-changed').length,
      activitiesWdvChanged: activities.filter((a) => a.kind === 'wdv-changed').length,
      activitiesPlannedQuantityChanged: activities.filter((a) => a.kind === 'planned-quantity-changed').length,
      dependenciesAdded: dependencies.filter((d) => d.kind === 'added').length,
      dependenciesRemoved: dependencies.filter((d) => d.kind === 'removed').length,
      dependenciesTypeChanged: dependencies.filter((d) => d.kind === 'type-changed').length,
      dependenciesLagChanged: dependencies.filter((d) => d.kind === 'lag-changed').length,
    },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toActivityState(a: ProgrammeActivity): ActivityState {
  return {
    name: a.name,
    sequence: a.sequence,
    duration: a.duration,
    estimateLineId: a.constructionRefs.estimateLineId,
    workDefinitionVersionId: a.constructionRefs.workDefinitionVersionId,
    plannedQuantity: a.plannedQuantity,
  }
}

// ─── Activity diff ──────────────────────────────────────────────────────────

function diffActivities(
  base: ProgrammeActivity[],
  head: ProgrammeActivity[],
): ActivityChange[] {
  const changes: ActivityChange[] = []
  const baseById = new Map(base.map((a) => [a.id, a]))
  const headById = new Map(head.map((a) => [a.id, a]))

  // Activities added (in head but not in base) — construction category.
  for (const h of head) {
    if (!baseById.has(h.id)) {
      changes.push({
        activityId: h.id,
        kind: 'added',
        from: null, // didn't exist in base
        to: toActivityState(h),
        category: 'construction',
        scheduleAffecting: true,
      })
    }
  }

  // Activities removed (in base but not in head) — construction category.
  for (const b of base) {
    if (!headById.has(b.id)) {
      changes.push({
        activityId: b.id,
        kind: 'removed',
        from: toActivityState(b),
        to: null, // doesn't exist in head
        category: 'construction',
        scheduleAffecting: true,
      })
    }
  }

  // Activities that exist in both — check for field changes.
  for (const h of head) {
    const b = baseById.get(h.id)
    if (!b) continue // already handled as "added"

    const fromState = toActivityState(b)
    const toState = toActivityState(h)

    // Duration changed (schedule category).
    if (b.duration !== h.duration) {
      changes.push({
        activityId: h.id,
        kind: 'duration-changed',
        from: fromState,
        to: toState,
        category: 'schedule',
        scheduleAffecting: true,
      })
    }

    // Name changed (presentation category).
    if (b.name !== h.name) {
      changes.push({
        activityId: h.id,
        kind: 'renamed',
        from: fromState,
        to: toState,
        category: 'presentation',
        scheduleAffecting: false,
      })
    }

    // Sequence changed (presentation category).
    if (b.sequence !== h.sequence) {
      changes.push({
        activityId: h.id,
        kind: 'reordered',
        from: fromState,
        to: toState,
        category: 'presentation',
        scheduleAffecting: false,
      })
    }

    // EstimateLine relationship changed (construction category).
    if (b.constructionRefs.estimateLineId !== h.constructionRefs.estimateLineId) {
      changes.push({
        activityId: h.id,
        kind: 'estimate-line-changed',
        from: fromState,
        to: toState,
        category: 'construction',
        scheduleAffecting: false,
      })
    }

    // WorkDefinitionVersion relationship changed (construction category).
    if (b.constructionRefs.workDefinitionVersionId !== h.constructionRefs.workDefinitionVersionId) {
      changes.push({
        activityId: h.id,
        kind: 'wdv-changed',
        from: fromState,
        to: toState,
        category: 'construction',
        scheduleAffecting: false,
      })
    }

    // Planned quantity changed (construction category).
    if (b.plannedQuantity !== h.plannedQuantity) {
      changes.push({
        activityId: h.id,
        kind: 'planned-quantity-changed',
        from: fromState,
        to: toState,
        category: 'construction',
        scheduleAffecting: false,
      })
    }
  }

  return changes
}

// ─── Dependency diff ────────────────────────────────────────────────────────

function diffDependencies(
  base: ActivityDependency[],
  head: ActivityDependency[],
  baseNameById: Map<string, string>,
  headNameById: Map<string, string>,
): DependencyChange[] {
  const changes: DependencyChange[] = []
  // U1: dependencies are identified by (predecessor, successor) ordered pair.
  const baseByPair = new Map(
    base.map((d) => [`${d.predecessorActivityId}|${d.successorActivityId}`, d]),
  )
  const headByPair = new Map(
    head.map((d) => [`${d.predecessorActivityId}|${d.successorActivityId}`, d]),
  )

  // Helper: look up a name from a name map, falling back to the ID.
  const name = (map: Map<string, string>, id: string) => map.get(id) ?? id

  // Dependencies added (in head but not in base).
  for (const h of head) {
    const key = `${h.predecessorActivityId}|${h.successorActivityId}`
    if (!baseByPair.has(key)) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        kind: 'added',
        from: null, // didn't exist in base
        to: {
          predecessorName: name(headNameById, h.predecessorActivityId),
          successorName: name(headNameById, h.successorActivityId),
          type: h.type,
          lag: h.lag,
        },
        category: 'schedule',
        scheduleAffecting: true,
      })
    }
  }

  // Dependencies removed (in base but not in head).
  for (const b of base) {
    const key = `${b.predecessorActivityId}|${b.successorActivityId}`
    if (!headByPair.has(key)) {
      changes.push({
        predecessorActivityId: b.predecessorActivityId,
        successorActivityId: b.successorActivityId,
        kind: 'removed',
        from: {
          // Names from the BASE snapshot — critical for removed activities
          // where the head snapshot can't supply names.
          predecessorName: name(baseNameById, b.predecessorActivityId),
          successorName: name(baseNameById, b.successorActivityId),
          type: b.type,
          lag: b.lag,
        },
        to: null, // doesn't exist in head
        category: 'schedule',
        scheduleAffecting: true,
      })
    }
  }

  // Dependencies that exist in both — check for type/lag changes.
  for (const h of head) {
    const key = `${h.predecessorActivityId}|${h.successorActivityId}`
    const b = baseByPair.get(key)
    if (!b) continue // already handled as "added"

    // Build from/to states with names from BOTH snapshots.
    const fromState: DependencyState = {
      predecessorName: name(baseNameById, b.predecessorActivityId),
      successorName: name(baseNameById, b.successorActivityId),
      type: b.type,
      lag: b.lag,
    }
    const toState: DependencyState = {
      predecessorName: name(headNameById, h.predecessorActivityId),
      successorName: name(headNameById, h.successorActivityId),
      type: h.type,
      lag: h.lag,
    }

    // Type changed (schedule-affecting).
    if (b.type !== h.type) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        kind: 'type-changed',
        from: fromState,
        to: toState,
        category: 'schedule',
        scheduleAffecting: true,
      })
    }

    // Lag changed (schedule-affecting).
    if (b.lag !== h.lag) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        kind: 'lag-changed',
        from: fromState,
        to: toState,
        category: 'schedule',
        scheduleAffecting: true,
      })
    }
  }

  return changes
}
