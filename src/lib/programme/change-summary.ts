/**
 * Change Summary — pure diff between two ProgrammeSnapshots.
 *
 * Compares the current workspace against the latest finalized ProgrammeRevision
 * and produces a structured summary of what changed. This is the "what
 * changed since last revision?" surface for the finalization UX.
 *
 * ARCHITECTURE:
 *   This is a PURE function — no DB, no Prisma, no side effects. It takes
 *   two ProgrammeSnapshots (the "base" = latest revision, the "head" =
 *   current workspace) and returns a structured ChangeSummary.
 *
 * CATEGORIZATION:
 *   Changes are categorized by their relationship to the schedule:
 *     - "schedule-affecting" — duration or dependency changes. These change
 *       the CPM outputs (start, finish, float, critical path).
 *     - "presentation" — name and sequence changes. These do NOT change the
 *       CPM outputs — they're the contractor's authored programme document,
 *       not scheduling inputs.
 *
 *   This distinction is the key explainability the Contractor OS thesis
 *   needs: the contractor can see which changes affect the schedule vs
 *   which are just presentation/organization.
 *
 * INVARIANTS:
 *   - Same snapshots → empty change summary (no changes).
 *   - The change summary is deterministic: same inputs → same output.
 *   - Activities are matched by ID (not name or sequence).
 *   - Dependencies are matched by (predecessor, successor) ordered pair (U1).
 */

import type {
  ProgrammeSnapshot,
  ProgrammeActivity,
  ActivityDependency,
} from './types'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActivityChange {
  activityId: string
  /** The activity's name in the head snapshot (for display). */
  name: string
  kind: 'added' | 'removed' | 'renamed' | 'reordered' | 'duration-changed'
  /** For renamed: the old name. For reordered: the old sequence. For duration: the old duration. */
  oldValue?: string | number
  /** For renamed: the new name. For reordered: the new sequence. For duration: the new duration. */
  newValue?: string | number
  /** Whether this change affects the CPM schedule outputs. */
  scheduleAffecting: boolean
}

export interface DependencyChange {
  /** The dependency's ordered pair (predecessor → successor). */
  predecessorActivityId: string
  successorActivityId: string
  /** Names for display. */
  predecessorName: string
  successorName: string
  kind: 'added' | 'removed' | 'type-changed' | 'lag-changed'
  /** For type-changed: the old type. For lag-changed: the old lag. */
  oldValue?: string | number
  /** For type-changed: the new type. For lag-changed: the new lag. */
  newValue?: string | number
  /** Whether this change affects the CPM schedule outputs. */
  scheduleAffecting: boolean
}

export interface ChangeSummary {
  /** True if the workspace is identical to the base revision (no changes). */
  hasChanges: boolean
  /** True if any change affects the CPM schedule outputs. */
  hasScheduleChanges: boolean
  /** True if any change is presentation-only (name/sequence). */
  hasPresentationChanges: boolean
  activities: ActivityChange[]
  dependencies: DependencyChange[]
  /** Counts for quick display. */
  counts: {
    activitiesAdded: number
    activitiesRemoved: number
    activitiesRenamed: number
    activitiesReordered: number
    activitiesDurationChanged: number
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
 * @param base — the "before" snapshot (typically the latest finalized revision)
 * @param head — the "after" snapshot (typically the current workspace)
 * @returns a ChangeSummary describing what changed from base to head.
 *
 * PURE: same inputs → same output. No side effects.
 */
export function computeChangeSummary(
  base: ProgrammeSnapshot,
  head: ProgrammeSnapshot,
): ChangeSummary {
  const activities = diffActivities(base.activities, head.activities)
  const dependencies = diffDependencies(base.dependencies, head.dependencies)

  const hasScheduleChanges =
    activities.some((a) => a.scheduleAffecting) ||
    dependencies.some((d) => d.scheduleAffecting)

  const hasPresentationChanges =
    activities.some((a) => !a.scheduleAffecting)

  return {
    hasChanges: activities.length > 0 || dependencies.length > 0,
    hasScheduleChanges,
    hasPresentationChanges: hasPresentationChanges && !hasScheduleChanges || hasPresentationChanges,
    activities,
    dependencies,
    counts: {
      activitiesAdded: activities.filter((a) => a.kind === 'added').length,
      activitiesRemoved: activities.filter((a) => a.kind === 'removed').length,
      activitiesRenamed: activities.filter((a) => a.kind === 'renamed').length,
      activitiesReordered: activities.filter((a) => a.kind === 'reordered').length,
      activitiesDurationChanged: activities.filter((a) => a.kind === 'duration-changed').length,
      dependenciesAdded: dependencies.filter((d) => d.kind === 'added').length,
      dependenciesRemoved: dependencies.filter((d) => d.kind === 'removed').length,
      dependenciesTypeChanged: dependencies.filter((d) => d.kind === 'type-changed').length,
      dependenciesLagChanged: dependencies.filter((d) => d.kind === 'lag-changed').length,
    },
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

  // Activities added (in head but not in base).
  for (const h of head) {
    if (!baseById.has(h.id)) {
      changes.push({
        activityId: h.id,
        name: h.name,
        kind: 'added',
        scheduleAffecting: true, // a new activity affects the schedule
      })
    }
  }

  // Activities removed (in base but not in head).
  for (const b of base) {
    if (!headById.has(b.id)) {
      changes.push({
        activityId: b.id,
        name: b.name,
        kind: 'removed',
        scheduleAffecting: true, // removing an activity affects the schedule
      })
    }
  }

  // Activities that exist in both — check for field changes.
  for (const h of head) {
    const b = baseById.get(h.id)
    if (!b) continue // already handled as "added"

    // Duration changed (schedule-affecting).
    if (b.duration !== h.duration) {
      changes.push({
        activityId: h.id,
        name: h.name,
        kind: 'duration-changed',
        oldValue: b.duration,
        newValue: h.duration,
        scheduleAffecting: true,
      })
    }

    // Name changed (presentation only).
    if (b.name !== h.name) {
      changes.push({
        activityId: h.id,
        name: h.name,
        kind: 'renamed',
        oldValue: b.name,
        newValue: h.name,
        scheduleAffecting: false,
      })
    }

    // Sequence changed (presentation only).
    if (b.sequence !== h.sequence) {
      changes.push({
        activityId: h.id,
        name: h.name,
        kind: 'reordered',
        oldValue: b.sequence,
        newValue: h.sequence,
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
): DependencyChange[] {
  const changes: DependencyChange[] = []
  // U1: dependencies are identified by (predecessor, successor) ordered pair.
  const baseByPair = new Map(
    base.map((d) => [`${d.predecessorActivityId}|${d.successorActivityId}`, d]),
  )
  const headByPair = new Map(
    head.map((d) => [`${d.predecessorActivityId}|${d.successorActivityId}`, d]),
  )

  // Build a name lookup from both base and head activities (for display).
  // The caller should pass snapshots that include activity names; we use
  // the activity IDs for matching and look up names from the head snapshot.
  // If a name isn't found, we fall back to the ID.

  // Dependencies added (in head but not in base).
  for (const h of head) {
    const key = `${h.predecessorActivityId}|${h.successorActivityId}`
    if (!baseByPair.has(key)) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        predecessorName: h.predecessorActivityId, // fallback; service enriches with names
        successorName: h.successorActivityId,
        kind: 'added',
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
        predecessorName: b.predecessorActivityId,
        successorName: b.successorActivityId,
        kind: 'removed',
        scheduleAffecting: true,
      })
    }
  }

  // Dependencies that exist in both — check for type/lag changes.
  for (const h of head) {
    const key = `${h.predecessorActivityId}|${h.successorActivityId}`
    const b = baseByPair.get(key)
    if (!b) continue // already handled as "added"

    // Type changed (schedule-affecting).
    if (b.type !== h.type) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        predecessorName: h.predecessorActivityId,
        successorName: h.successorActivityId,
        kind: 'type-changed',
        oldValue: b.type,
        newValue: h.type,
        scheduleAffecting: true,
      })
    }

    // Lag changed (schedule-affecting).
    if (b.lag !== h.lag) {
      changes.push({
        predecessorActivityId: h.predecessorActivityId,
        successorActivityId: h.successorActivityId,
        predecessorName: h.predecessorActivityId,
        successorName: h.successorActivityId,
        kind: 'lag-changed',
        oldValue: b.lag,
        newValue: h.lag,
        scheduleAffecting: true,
      })
    }
  }

  return changes
}
