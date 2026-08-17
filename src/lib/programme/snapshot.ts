/**
 * Pure Programme snapshot functions — validation, serialization, and
 * schedule reproducibility.
 *
 * These are PURE: no DB, no Prisma, no side effects, no wall-clock time.
 * Same inputs → same outputs, always.
 *
 * ARCHITECTURE:
 *   validateProgrammeSnapshot(snapshot) → validation result
 *   serializeSnapshot(snapshot) → canonical JSON (stable key order)
 *   computeSnapshotContentHash(snapshot) → SHA-256 digest
 *   deserializeSnapshot(json) → ProgrammeSnapshot
 *   replaySchedule(snapshot) → ScheduleResult (deterministic CPM)
 *
 * V1: Uses the shared canonical JSON serializer (stableJsonStringify) from
 * @/lib/canonical-json — the same primitive used by the BOQ domain. No second
 * serialization rule.
 *
 * V2: Validates finite numeric values. duration must be finite + >= 0; lag
 * must be finite (negative allowed = leads). NaN/Infinity are rejected —
 * they must never enter persisted schedule truth.
 *
 * V3: The snapshot content hash (SHA-256 of the canonical JSON) provides
 * content-addressing for the immutable ProgrammeRevision, mirroring the
 * EstimateRevision/BoqProjection pattern.
 *
 * The replay guarantee mirrors EstimateRevision:
 *   same ProgrammeSnapshot + same schedule-engine version
 *       → same ScheduleResult (CPM dates, float, critical path)
 */

import { computeSchedule, type ScheduleActivity, type ScheduleResult } from '@/lib/engines/schedule-engine'
import { stableJsonStringify, computeContentDigest } from '@/lib/canonical-json'
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
 *   - V2: non-finite durations (NaN, Infinity, -Infinity)
 *   - V2: non-finite lag values (NaN, Infinity, -Infinity)
 *   - negative durations (allowed = 0, but negative is invalid)
 *   - self-referencing dependencies (an activity depending on itself)
 *
 * V2: the schedule engine defensively converts invalid values to zero, which
 * is appropriate for a pure calculation engine. But a finalized ProgrammeSnapshot
 * is persisted schedule truth — NaN/Infinity must never be accepted. The
 * contract requires: duration = finite + >= 0; lag = finite (negative allowed).
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

  // V2: Check for non-finite or negative durations.
  for (const activity of snapshot.activities) {
    if (!Number.isFinite(activity.duration)) {
      errors.push(`Activity "${activity.id}" has non-finite duration: ${activity.duration}`)
    } else if (activity.duration < 0) {
      errors.push(`Activity "${activity.id}" has negative duration: ${activity.duration}`)
    }
  }

  // V2: Check for non-finite lag values (negative is allowed — it's a lead).
  for (const dep of snapshot.dependencies) {
    if (!Number.isFinite(dep.lag)) {
      errors.push(`Dependency "${dep.id}" has non-finite lag: ${dep.lag}`)
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

// ─── Serialization (V1: canonical/stable JSON) ──────────────────────────────

/**
 * Serialize a ProgrammeSnapshot to canonical JSON for storage in
 * ProgrammeRevision.snapshotJson.
 *
 * V1: Uses the shared stableJsonStringify (sorted keys at every depth) — the
 * same primitive used by the BOQ domain. This ensures:
 *   same logical ProgrammeSnapshot → same canonical JSON → same content hash
 * regardless of how a caller constructed the object. The historical identity
 * of a ProgrammeRevision does not depend on object property insertion order.
 */
export function serializeSnapshot(snapshot: ProgrammeSnapshot): string {
  return stableJsonStringify(snapshot)
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

// ─── Content hash (V3: SHA-256 of canonical JSON) ───────────────────────────

/**
 * Compute a SHA-256 content digest of a ProgrammeSnapshot.
 *
 * V3: mirrors the BoqProjection's sourceContentHash pattern. The digest is
 * over the canonical JSON (sorted keys), so it is independent of object
 * construction order. This provides content-addressing for the immutable
 * ProgrammeRevision:
 *   same snapshot → same content hash → same historical schedule identity
 *
 * This should be persisted as ProgrammeRevision.snapshotContentHash so the
 * revision's content identity is directly inspectable without parsing the
 * snapshot JSON.
 */
export function computeSnapshotContentHash(snapshot: ProgrammeSnapshot): string {
  return computeContentDigest(snapshot)
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
