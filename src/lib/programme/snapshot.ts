/**
 * Pure Programme snapshot functions — validation, serialization, and
 * schedule reproducibility.
 *
 * These are PURE: no DB, no Prisma, no side effects, no wall-clock time.
 * Same inputs → same outputs, always.
 *
 * ARCHITECTURE:
 *   validateProgrammeSnapshot(snapshot) → validation result
 *   serializeSnapshot(snapshot) → JSON string (for ProgrammeRevision.snapshotJson)
 *   deserializeSnapshot(json) → ProgrammeSnapshot
 *   replaySchedule(snapshot) → ScheduleResult (deterministic CPM)
 *
 * The replay guarantee mirrors EstimateRevision:
 *   same ProgrammeSnapshot + same schedule-engine version
 *       → same ScheduleResult (CPM dates, float, critical path)
 */

import { computeSchedule, type ScheduleActivity, type ScheduleResult } from '@/lib/engines/schedule-engine'
import type {
  ActivityDependency,
  ProgrammeActivity,
  ProgrammeSnapshot,
  ProgrammeValidationResult,
} from './types'

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a ProgrammeSnapshot before finalization.
 *
 * Catches:
 *   - duplicate activity IDs
 *   - dangling dependency references (predecessor/successor IDs not in activities)
 *   - dependency cycles (via the schedule engine's cycle detection)
 *   - negative durations (allowed = 0, but negative is invalid)
 *   - self-referencing dependencies (an activity depending on itself)
 *
 * Returns { ok, errors, duplicateActivityIds, danglingDependencyRefs, hasCycle }.
 */
export function validateProgrammeSnapshot(
  snapshot: ProgrammeSnapshot,
): ProgrammeValidationResult {
  const errors: string[] = []
  const duplicateActivityIds: string[] = []
  const danglingDependencyRefs: string[] = []

  // Check for duplicate activity IDs.
  const seenIds = new Set<string>()
  for (const activity of snapshot.activities) {
    if (seenIds.has(activity.id)) {
      duplicateActivityIds.push(activity.id)
    }
    seenIds.add(activity.id)
  }
  if (duplicateActivityIds.length > 0) {
    errors.push(`Duplicate activity IDs: ${duplicateActivityIds.join(', ')}`)
  }

  // Check for negative durations.
  for (const activity of snapshot.activities) {
    if (activity.duration < 0) {
      errors.push(`Activity "${activity.id}" has negative duration: ${activity.duration}`)
    }
  }

  // Check for self-referencing dependencies.
  for (const dep of snapshot.dependencies) {
    if (dep.predecessorActivityId === dep.successorActivityId) {
      errors.push(
        `Dependency "${dep.id}" is self-referencing: ${dep.predecessorActivityId} → ${dep.successorActivityId}`,
      )
    }
  }

  // Check for dangling dependency references.
  for (const dep of snapshot.dependencies) {
    if (!seenIds.has(dep.predecessorActivityId)) {
      danglingDependencyRefs.push(
        `Dependency "${dep.id}": predecessor "${dep.predecessorActivityId}" not found`,
      )
    }
    if (!seenIds.has(dep.successorActivityId)) {
      danglingDependencyRefs.push(
        `Dependency "${dep.id}": successor "${dep.successorActivityId}" not found`,
      )
    }
  }
  if (danglingDependencyRefs.length > 0) {
    errors.push(...danglingDependencyRefs)
  }

  // Check for cycles by running the schedule engine (it detects cycles).
  const scheduleResult = mapToScheduleAndCompute(snapshot)
  if (scheduleResult.hasCycle) {
    errors.push('Dependency graph contains a cycle — schedule is infeasible')
  }

  return {
    ok: errors.length === 0,
    errors,
    duplicateActivityIds,
    danglingDependencyRefs,
    hasCycle: scheduleResult.hasCycle,
  }
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Serialize a ProgrammeSnapshot to JSON for storage in
 * ProgrammeRevision.snapshotJson. Deterministic: same snapshot → same JSON.
 */
export function serializeSnapshot(snapshot: ProgrammeSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * Deserialize a ProgrammeSnapshot from JSON.
 * Throws if the JSON is invalid or missing required fields.
 */
export function deserializeSnapshot(json: string): ProgrammeSnapshot {
  const parsed = JSON.parse(json) as ProgrammeSnapshot
  if (!parsed.activities || !Array.isArray(parsed.activities)) {
    throw new Error('Invalid ProgrammeSnapshot: missing activities array')
  }
  if (!parsed.dependencies || !Array.isArray(parsed.dependencies)) {
    throw new Error('Invalid ProgrammeSnapshot: missing dependencies array')
  }
  return parsed
}

// ─── Schedule replay (deterministic CPM) ────────────────────────────────────

/**
 * Map a ProgrammeSnapshot's activities + dependencies to the schedule engine's
 * ScheduleActivity[] format, then compute the schedule.
 *
 * The mapping:
 *   - Each ProgrammeActivity becomes a ScheduleActivity (id, name, duration).
 *   - Dependencies where the activity is the SUCCESSOR become predecessors[].
 *   - The dependency's type + lag map directly to SchedulePredecessor.type + lag.
 *
 * This is the FAITHFUL BRIDGE between the Programme domain and the pure CPM
 * engine. The Programme domain adds construction-identity refs + planned
 * quantities + status; the schedule engine consumes only id/name/duration/
 * predecessors. The extra Programme fields are carried through the snapshot
 * but do NOT affect the CPM computation (they're relationships, not scheduling
 * inputs).
 */
function mapToScheduleAndCompute(snapshot: ProgrammeSnapshot): ScheduleResult {
  // Build a map of successorActivityId → predecessors[].
  const predecessorsByActivity = new Map<string, ActivityDependency[]>()
  for (const dep of snapshot.dependencies) {
    const preds = predecessorsByActivity.get(dep.successorActivityId) ?? []
    preds.push(dep)
    predecessorsByActivity.set(dep.successorActivityId, preds)
  }

  // Map to ScheduleActivity.
  const scheduleActivities: ScheduleActivity[] = snapshot.activities.map(
    (activity: ProgrammeActivity) => ({
      id: activity.id,
      name: activity.name,
      duration: activity.duration,
      predecessors: (predecessorsByActivity.get(activity.id) ?? []).map(
        (dep) => ({
          id: dep.predecessorActivityId,
          type: dep.type,
          lag: dep.lag,
        }),
      ),
    }),
  )

  return computeSchedule(scheduleActivities)
}

/**
 * Replay a ProgrammeSnapshot through the schedule engine.
 *
 * DETERMINISTIC: same snapshot + same schedule-engine version
 *     → same ScheduleResult (CPM dates, float, critical path).
 *
 * This is the schedule equivalent of replayRevision() for commercial snapshots.
 * The snapshot carries the scheduling INPUTS (activities + dependencies);
 * the CPM dates are a deterministic OUTPUT.
 */
export function replaySchedule(snapshot: ProgrammeSnapshot): ScheduleResult {
  return mapToScheduleAndCompute(snapshot)
}

// ─── Determinism verification (for tests / audit) ───────────────────────────

/**
 * Verify schedule reproducibility: two replays of the same snapshot produce
 * the same ScheduleResult.
 *
 * This is the schedule equivalent of projectionsMatch() for the BOQ domain.
 */
export function schedulesMatch(
  a: ScheduleResult,
  b: ScheduleResult,
): boolean {
  if (a.projectDuration !== b.projectDuration) return false
  if (a.hasCycle !== b.hasCycle) return false
  if (a.criticalPath.length !== b.criticalPath.length) return false
  if (JSON.stringify(a.criticalPath) !== JSON.stringify(b.criticalPath)) return false
  if (a.activities.length !== b.activities.length) return false
  return JSON.stringify(a.activities) === JSON.stringify(b.activities)
}
