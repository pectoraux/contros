/**
 * Plan Measurement — pure validation, serialization, and content hashing.
 *
 * These are PURE functions: no DB, no Prisma, no side effects, no wall-clock
 * time. Same inputs → same outputs, always.
 *
 * ARCHITECTURE:
 *   validatePlanMeasurement(measurement) → validation result
 *   serializeMeasurement(measurement) → canonical JSON (stable key order)
 *   computeMeasurementContentHash(measurement) → SHA-256 digest
 *   extractMeasurementContent(measurement) → content projection
 *
 * HISTORICAL INVARIANT:
 *   same PlanSheetRevision
 *   + same measurement input
 *   + same measurement algorithm/version
 *       → same PlanMeasurement content
 *       → same content hash
 *
 * This mirrors the Programme domain's snapshot determinism:
 *   same ProgrammeSnapshot + same schedule-engine version → same ScheduleResult
 *   same ProgrammeSnapshotContent → same snapshotContentHash
 *
 * The content hash is computed from the CONTENT PROJECTION (excluding
 * metadata like id, createdAt, measuredById, measuredAt), so:
 *   same measurement content → same hash
 *   different recorder/time → same hash (content is the same)
 *   different quantity/method/basis → different hash
 */

import { stableJsonStringify, computeContentDigest } from '@/lib/canonical-json'
import {
  CURRENT_MEASUREMENT_ENGINE_VERSION,
  type PlanMeasurement,
  type PlanMeasurementContent,
  type PlanMeasurementValidationResult,
  type MeasurementMethod,
} from './types'

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * The recognized measurement methods. Each corresponds to an adapter.
 * The domain is format-neutral; the method records the provenance.
 */
const VALID_METHODS: MeasurementMethod[] = [
  'manual',
  'pdf-takeoff',
  'cad-extraction',
  'bim-export',
  'ai-extraction',
]

/**
 * Validate a PlanMeasurement before persistence.
 *
 * Validation contract (from the architectural review):
 *   - quantity must be finite (Number.isFinite)
 *   - quantity must be >= 0
 *   - unit must be non-empty (after trim)
 *   - measurement method must be recognized
 *   - PlanMeasurement must reference one immutable PlanSheetRevision
 *   - measurementBasisJson must be valid JSON (if non-empty)
 *   - measurementEngineVersion must be a positive integer
 *
 * Returns { ok, errors }.
 */
export function validatePlanMeasurement(
  measurement: PlanMeasurement,
): PlanMeasurementValidationResult {
  const errors: string[] = []

  // planSheetRevisionId must be non-empty (references an immutable revision).
  if (!measurement.planSheetRevisionId || measurement.planSheetRevisionId.trim() === '') {
    errors.push('PlanMeasurement must reference one immutable PlanSheetRevision')
  }

  // quantity must be finite.
  if (!Number.isFinite(measurement.quantity)) {
    errors.push(`Quantity must be finite, got: ${measurement.quantity}`)
  }

  // quantity must be >= 0.
  if (Number.isFinite(measurement.quantity) && measurement.quantity < 0) {
    errors.push(`Quantity must be >= 0, got: ${measurement.quantity}`)
  }

  // unit must be non-empty.
  if (!measurement.unit || measurement.unit.trim() === '') {
    errors.push('Unit must be non-empty')
  }

  // measurement method must be recognized.
  if (!VALID_METHODS.includes(measurement.measurementMethod)) {
    errors.push(
      `Measurement method must be one of: ${VALID_METHODS.join(', ')}. Got: ${measurement.measurementMethod}`,
    )
  }

  // measurementBasisJson must be valid JSON (if non-empty).
  if (measurement.measurementBasisJson && measurement.measurementBasisJson.trim() !== '') {
    try {
      JSON.parse(measurement.measurementBasisJson)
    } catch {
      errors.push('measurementBasisJson must be valid JSON')
    }
  }

  // measurementEngineVersion must be a positive integer.
  if (
    !Number.isInteger(measurement.measurementEngineVersion) ||
    measurement.measurementEngineVersion < 1
  ) {
    errors.push(
      `Measurement engine version must be a positive integer, got: ${measurement.measurementEngineVersion}`,
    )
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}

// ─── Content projection + hashing ───────────────────────────────────────────

/**
 * Extract the content projection from a PlanMeasurement — the subset that
 * defines the measurement's identity for content hashing.
 *
 * Excludes metadata (id, createdAt, measuredById, measuredAt) that doesn't
 * affect the measurement's content. This means:
 *   same content → same hash
 *   different recorder/time → same hash (content is the same)
 *
 * BASIS NORMALIZATION:
 *   measurementBasisJson is NORMALIZED before inclusion in the projection.
 *   The raw input JSON text is parsed and re-serialized via stableJsonStringify
 *   (sorted keys at every depth). This ensures:
 *
 *     {"points":["p1","p2"],"scale":"1:100"}
 *     {"scale":"1:100","points":["p1","p2"]}
 *
 *   produce the SAME content hash, because the basis is canonicalized before
 *   hashing. Do NOT use raw input JSON text as identity — that would make the
 *   hash depend on the caller's key ordering, violating the invariant:
 *
 *     same measurement input + same basis + same engine version
 *         → same content hash
 *
 *   This is the same canonicalization discipline established for Programme
 *   snapshots (serializeSnapshot) and BOQ content (stableJsonStringify).
 *
 * This mirrors the Programme domain's extractSnapshotContent (P1).
 */
export function extractMeasurementContent(
  measurement: PlanMeasurement,
): PlanMeasurementContent {
  return {
    planSheetRevisionId: measurement.planSheetRevisionId,
    elementReference: measurement.elementReference,
    measurementMethod: measurement.measurementMethod,
    quantity: measurement.quantity,
    unit: measurement.unit,
    // Normalize the basis: parse → stableJsonStringify → canonical form.
    // If the basis is empty or invalid JSON, use the raw string (validation
    // will have already caught invalid JSON).
    measurementBasisJson: normalizeBasisJson(measurement.measurementBasisJson),
    measurementEngineVersion: measurement.measurementEngineVersion,
  }
}

/**
 * Normalize a measurementBasisJson string to canonical form.
 *
 * Parses the JSON and re-serializes with stableJsonStringify (sorted keys
 * at every depth). This makes the content hash independent of the caller's
 * JSON key ordering — the same logical basis always produces the same hash.
 *
 * If the input is empty, null, or not valid JSON, returns the input unchanged
 * (validation catches invalid JSON separately).
 */
function normalizeBasisJson(basisJson: string): string {
  if (!basisJson || basisJson.trim() === '') {
    return basisJson
  }
  try {
    const parsed = JSON.parse(basisJson)
    return stableJsonStringify(parsed)
  } catch {
    // Invalid JSON — return as-is. Validation will catch this.
    return basisJson
  }
}

/**
 * Compute a SHA-256 content digest of a PlanMeasurement's CONTENT.
 *
 * HISTORICAL INVARIANT:
 *   same PlanSheetRevision + same measurement input + same engine version
 *       → same PlanMeasurement content → same content hash
 *
 * The hash is computed from the content projection (excluding id, createdAt,
 * measuredById, measuredAt), so two measurements with the same content but
 * different recorders/times have the same hash.
 *
 * This mirrors the Programme domain's computeSnapshotContentHash (P1) and
 * the BOQ domain's sourceContentHash discipline.
 */
export function computeMeasurementContentHash(
  measurement: PlanMeasurement,
): string {
  const content = extractMeasurementContent(measurement)
  return computeContentDigest(content)
}

// ─── Serialization ──────────────────────────────────────────────────────────

/**
 * Serialize a PlanMeasurement to canonical JSON for storage.
 *
 * Uses the shared stableJsonStringify (sorted keys at every depth) — the same
 * primitive used by the BOQ and Programme domains. This ensures:
 *   same logical PlanMeasurement → same canonical JSON
 * regardless of how a caller constructed the object.
 */
export function serializeMeasurement(measurement: PlanMeasurement): string {
  return stableJsonStringify(measurement)
}

// ─── Determinism verification (for tests / audit) ───────────────────────────

/**
 * Verify measurement reproducibility: two measurements with the same content
 * produce the same content hash.
 *
 * This is the measurement equivalent of schedulesMatch() for the Programme
 * domain.
 */
export function measurementsMatch(
  a: PlanMeasurement,
  b: PlanMeasurement,
): boolean {
  return computeMeasurementContentHash(a) === computeMeasurementContentHash(b)
}

// ─── Constants ──────────────────────────────────────────────────────────────

export {
  CURRENT_MEASUREMENT_ENGINE_VERSION,
  VALID_METHODS,
}
