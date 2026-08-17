/**
 * Pure deterministic BOQ binding-candidate matching.
 *
 * Given a normalized BoqItem and a set of canonical EstimateLines, this
 * produces scored candidates using deterministic matching TIERS. It does
 * NOT bind — binding is an explicit human decision. This function only
 * generates candidates and records WHY each candidate was suggested.
 *
 * Matching tiers (highest confidence first):
 *   Tier 1  CODE_EXACT              — external code ↔ canonical code
 *   Tier 2  DESCRIPTION_UNIT_EXACT  — normalized description + unit match
 *   Tier 3  WORK_DEFINITION         — shared WorkDefinition identity
 *   Tier 4  CANDIDATE_SELECTED      — scored candidates (human picks)
 *   Tier 5  MANUAL                   — direct human binding (no machine help)
 *
 * Tiers 1-3 can produce a deterministic single-match (auto-suggest MATCHED).
 * Tier 4 produces multiple scored candidates (AMBIGUOUS — human disambiguates).
 * Tier 5 is not machine-generated; it's recorded when a human binds directly.
 *
 * INVARIANT: AI may later become a candidate generator but NEVER the authority.
 * This function is deterministic — no AI, no fuzzy heuristics, no randomness.
 */

import type { BindingCandidate, MatchMethod } from './types'
import { normalizeCode, normalizeDescription, normalizeUnit } from './normalize'

/** A canonical EstimateLine projected for matching (no commercial mutation). */
export interface CanonicalLineForMatch {
  estimateLineId: string
  estimateId: string
  description: string
  unit: string
  quantity: number
  unitRate: number
  workDefinitionCode: string | null // the WD code, if the line is bound to a WD
}

/** A normalized BoqItem projected for matching. */
export interface BoqItemForMatch {
  boqItemId: string
  normalizedDescription: string | null
  normalizedCode: string | null
  normalizedUnit: string | null
}

/** Score a single (item, line) pair across all tiers, returning the best. */
function scorePair(
  item: BoqItemForMatch,
  line: CanonicalLineForMatch,
): { score: number; method: MatchMethod; reason: string } | null {
  // Tier 1: CODE_EXACT — external code matches the line's WD code.
  if (item.normalizedCode && line.workDefinitionCode) {
    const itemCode = item.normalizedCode
    const lineCode = normalizeCode(line.workDefinitionCode)
    if (itemCode && lineCode && itemCode === lineCode) {
      return { score: 1.0, method: 'CODE_EXACT', reason: `code "${itemCode}" matches WD code` }
    }
  }

  // Tier 2: DESCRIPTION_UNIT_EXACT — normalized description + unit both match.
  const itemDesc = item.normalizedDescription
  const lineDesc = normalizeDescription(line.description)
  const itemUnit = item.normalizedUnit
  const lineUnit = normalizeUnit(line.unit)
  if (itemDesc && lineDesc && itemDesc === lineDesc) {
    if (itemUnit && lineUnit && itemUnit === lineUnit) {
      return {
        score: 0.95,
        method: 'DESCRIPTION_UNIT_EXACT',
        reason: `description + unit "${itemUnit}" match`,
      }
    }
    // Description matches but unit missing or different — still a candidate,
    // but lower confidence (description-only).
    return {
      score: 0.7,
      method: 'DESCRIPTION_UNIT_EXACT',
      reason: 'description matches (unit differs or missing)',
    }
  }

  // Tier 3: WORK_DEFINITION — handled at the caller level via WD code; if the
  // line has a WD code but the item has no code, we can't match on WD identity.
  // (No partial WD match — that would require fuzzy logic, deferred.)

  // No deterministic match. Return null — this pair is not a candidate.
  // (Tier 4 candidate scoring for AMBIGUOUS cases is handled by generateCandidates
  // which may apply looser heuristics, but still deterministic.)
  return null
}

/**
 * Looser candidate scoring for AMBIGUOUS cases — partial description overlap.
 * Deterministic: token-set intersection ratio. Used ONLY to rank candidates
 * for human selection, never to auto-bind.
 */
function looseScore(
  item: BoqItemForMatch,
  line: CanonicalLineForMatch,
): { score: number; reason: string } | null {
  if (!item.normalizedDescription) return null
  const lineDesc = normalizeDescription(line.description)
  if (!lineDesc) return null
  const itemTokens = new Set(item.normalizedDescription.split(' ').filter((t) => t.length > 2))
  const lineTokens = new Set(lineDesc.split(' ').filter((t) => t.length > 2))
  if (itemTokens.size === 0 || lineTokens.size === 0) return null
  let overlap = 0
  for (const t of itemTokens) if (lineTokens.has(t)) overlap++
  const union = itemTokens.size + lineTokens.size - overlap
  const ratio = union > 0 ? overlap / union : 0
  // Only suggest as a candidate if there's meaningful overlap.
  if (ratio < 0.34) return null
  return { score: Math.round(ratio * 100) / 100, reason: `${overlap} shared token(s)` }
}

/**
 * Generate scored binding candidates for a BoqItem against the canonical lines.
 *
 * Returns candidates sorted by score descending. The caller (service) decides
 * whether to auto-suggest MATCHED (exactly one Tier 1-3 candidate) or
 * AMBIGUOUS (multiple candidates / only Tier 4 candidates).
 *
 * This function NEVER binds. It only suggests.
 */
export function generateCandidates(
  item: BoqItemForMatch,
  lines: CanonicalLineForMatch[],
): BindingCandidate[] {
  const candidates: BindingCandidate[] = []

  for (const line of lines) {
    const exact = scorePair(item, line)
    if (exact) {
      candidates.push({
        estimateLineId: line.estimateLineId,
        estimateId: line.estimateId,
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        unitRate: line.unitRate,
        score: exact.score,
        matchMethod: exact.method,
        matchReason: exact.reason,
      })
      continue
    }
    // Tier 4: looser candidate scoring for human selection.
    const loose = looseScore(item, line)
    if (loose) {
      candidates.push({
        estimateLineId: line.estimateLineId,
        estimateId: line.estimateId,
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        unitRate: line.unitRate,
        score: loose.score,
        matchMethod: 'CANDIDATE_SELECTED',
        matchReason: loose.reason,
      })
    }
  }

  // Sort by score descending; ties broken by description for determinism.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.description.localeCompare(b.description)
  })
  return candidates
}

/**
 * Classify the candidate set into a suggested binding status.
 *
 *   - 1 candidate with score >= 0.95  → suggest MATCHED (Tier 1-3 exact)
 *   - multiple candidates, or only Tier 4 → AMBIGUOUS (human must pick)
 *   - 0 candidates                     → UNMATCHED
 *
 * This is a SUGGESTION only. The service records it; a human confirms.
 */
export function suggestBindingStatus(
  candidates: BindingCandidate[],
): { status: 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED'; method: MatchMethod | null } {
  if (candidates.length === 0) {
    return { status: 'UNMATCHED', method: null }
  }
  const exact = candidates.filter((c) => c.score >= 0.95)
  if (exact.length === 1) {
    return { status: 'MATCHED', method: exact[0].matchMethod }
  }
  if (exact.length > 1) {
    // Multiple exact matches — genuinely ambiguous (e.g. same code on two lines).
    return { status: 'AMBIGUOUS', method: 'CANDIDATE_SELECTED' }
  }
  // Only loose candidates — human must disambiguate.
  return { status: 'AMBIGUOUS', method: 'CANDIDATE_SELECTED' }
}
