/**
 * Shared deterministic JSON serialization.
 *
 * Used by both the BOQ domain (projection content hash) and the Programme
 * domain (snapshot serialization + content hash). Ensures that the same
 * logical content produces the same canonical JSON regardless of object
 * property insertion order.
 *
 * Deterministic: object keys are sorted lexicographically at every depth.
 * This makes the serialized form independent of how a caller constructed the
 * object — a requirement for immutable historical snapshots and content hashes.
 */

/**
 * Deterministic JSON stringify: object keys sorted lexicographically at every depth.
 * Arrays preserve element order (order is semantically meaningful for arrays).
 */
export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJsonStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k])).join(',') + '}'
}

/**
 * Compute a SHA-256 digest of a value using canonical JSON serialization.
 * Used for content-addressing immutable snapshots and projections.
 */
export function computeContentDigest(value: unknown): string {
  const json = stableJsonStringify(value)
  return createHash('sha256').update(json, 'utf8').digest('hex')
}

import { createHash } from 'node:crypto'
