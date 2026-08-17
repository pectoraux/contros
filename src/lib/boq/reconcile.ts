/**
 * Pure BOQ reconciliation — a deterministic comparison of an external BoqItem
 * against a canonical EstimateLine, given an established binding.
 *
 * DESIGN RULE (Section 3 of the approved architecture): reconciliation is
 * NOT stored as truth. `reconcile(input)` returns a deterministic result
 * that MAY be cached for performance, but the cache must be disposable and
 * recomputable. The canonical commercial state stays in EstimateLine,
 * computed by the PricingEngine — BOQ never mutates it.
 *
 * INVARIANT 5 (asymmetric rates): the canonical rate is AUTHORITATIVE. An
 * external rate that differs (RATE_DIVERGENT) must NEVER cause
 * EstimateLine.unitRate to change. There is no "sync imported rate" op.
 *
 * Classifications are DIMENSIONS, not mutually exclusive statuses. A row can
 * simultaneously be MATCHED + QTY_MISMATCH + RATE_DIVERGENT. We avoid the
 * combinatorial explosion of combined enums by using bindingStatus + differences[].
 */

import type {
  BindingDimension,
  BoqDifference,
  DimensionComparison,
  ReconciliationResult,
} from './types'

/** A BoqItem projected for reconciliation (normalized values only). */
export interface BoqItemForReconcile {
  boqItemId: string
  normalizedQuantity: number | null
  normalizedUnit: string | null
  normalizedRate: number | null
}

/** A canonical EstimateLine projected for reconciliation. */
export interface EstimateLineForReconcile {
  estimateLineId: string
  quantity: number
  unit: string
  unitRate: number
}

/** The input to the pure reconcile function. */
export interface ReconcileInput {
  item: BoqItemForReconcile
  line: EstimateLineForReconcile | null // null when binding is not MATCHED
  bindingStatus: BindingDimension
}

/** Numeric tolerance for quantity/rate comparison (relative). */
const REL_TOLERANCE = 1e-6

/** Compare two numbers for near-equality (handles float imprecision). */
function numbersMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false
  if (a === b) return true
  const diff = Math.abs(a - b)
  const mag = Math.max(Math.abs(a), Math.abs(b))
  return diff <= mag * REL_TOLERANCE
}

/** Compare two unit strings (already normalized) for equality. */
function unitsMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  return a === b
}

/**
 * Reconcile one BoqItem against its bound EstimateLine.
 *
 * Pure: same input → same output, always. No DB, no side effects.
 *
 * When bindingStatus is not MATCHED (AMBIGUOUS/UNMATCHED/REJECTED), there is
 * nothing to compare against — all dimensions are UNKNOWN and differences is
 * empty. The result still carries the bindingStatus for the caller.
 *
 * When MATCHED, each dimension is compared independently:
 *   quantity: MATCH | MISMATCH  (UNKNOWN if external quantity is null)
 *   unit:     MATCH | MISMATCH  (UNKNOWN if external unit is null)
 *   rate:     MATCH | DIVERGENT (UNKNOWN if external rate is null)
 *
 * RATE uses "DIVERGENT" (not "MISMATCH") to emphasize the asymmetry: the
 * canonical rate is authoritative; the external rate is an observation.
 */
export function reconcile(input: ReconcileInput): ReconciliationResult {
  const { item, line, bindingStatus } = input

  // No canonical line to compare against.
  if (bindingStatus !== 'MATCHED' || !line) {
    const unknown = <T,>(): DimensionComparison<T> => ({
      status: 'UNKNOWN',
      external: null,
      canonical: null,
    })
    return {
      boqItemId: item.boqItemId,
      estimateLineId: null,
      bindingStatus,
      quantity: unknown<number>(),
      unit: unknown<string>(),
      rate: unknown<number>(),
      differences: [],
      classification: [bindingStatus],
    }
  }

  // Quantity dimension.
  const quantity: DimensionComparison<number> = {
    status: item.normalizedQuantity === null ? 'UNKNOWN' : numbersMatch(item.normalizedQuantity, line.quantity) ? 'MATCH' : 'MISMATCH',
    external: item.normalizedQuantity,
    canonical: line.quantity,
  }

  // Unit dimension.
  const unit: DimensionComparison<string> = {
    status: item.normalizedUnit === null ? 'UNKNOWN' : unitsMatch(item.normalizedUnit, line.unit) ? 'MATCH' : 'MISMATCH',
    external: item.normalizedUnit,
    canonical: line.unit,
  }

  // Rate dimension — DIVERGENT (asymmetric: canonical is authoritative).
  const rate: DimensionComparison<number> = {
    status: item.normalizedRate === null ? 'UNKNOWN' : numbersMatch(item.normalizedRate, line.unitRate) ? 'MATCH' : 'DIVERGENT',
    external: item.normalizedRate,
    canonical: line.unitRate,
  }

  // Build the differences list (dimensions that differ).
  const differences: BoqDifference[] = []
  if (quantity.status === 'MISMATCH') {
    differences.push({
      kind: 'QTY_MISMATCH',
      external: quantity.external as number,
      canonical: quantity.canonical as number,
    })
  }
  if (unit.status === 'MISMATCH') {
    differences.push({
      kind: 'UNIT_MISMATCH',
      external: unit.external as string,
      canonical: unit.canonical as string,
    })
  }
  if (rate.status === 'DIVERGENT') {
    differences.push({
      kind: 'RATE_DIVERGENT',
      external: rate.external as number,
      canonical: rate.canonical as number,
      note: 'Canonical rate is authoritative. External rate is an observation only.',
    })
  }

  // Classification list — MATCHED plus any differences.
  const classification = ['MATCHED', ...differences.map((d) => d.kind)]

  return {
    boqItemId: item.boqItemId,
    estimateLineId: line.estimateLineId,
    bindingStatus: 'MATCHED',
    quantity,
    unit,
    rate,
    differences,
    classification,
  }
}

/**
 * Reconcile a batch of items against their bindings. Pure convenience.
 * Each entry pairs an item with its (possibly null) line and binding status.
 */
export function reconcileBatch(
  entries: ReconcileInput[],
): ReconciliationResult[] {
  return entries.map(reconcile)
}

/**
 * Summarize a set of reconciliation results into aggregate counts.
 * Useful for a reconciliation overview without persisting it as truth.
 */
export function summarizeResults(results: ReconciliationResult[]): {
  total: number
  matched: number
  unmatched: number
  ambiguous: number
  rejected: number
  withDifferences: number
  qtyMismatches: number
  unitMismatches: number
  rateDivergences: number
} {
  let matched = 0,
    unmatched = 0,
    ambiguous = 0,
    rejected = 0,
    withDifferences = 0,
    qtyMismatches = 0,
    unitMismatches = 0,
    rateDivergences = 0
  for (const r of results) {
    if (r.bindingStatus === 'MATCHED') matched++
    else if (r.bindingStatus === 'UNMATCHED') unmatched++
    else if (r.bindingStatus === 'AMBIGUOUS') ambiguous++
    else if (r.bindingStatus === 'REJECTED') rejected++
    if (r.differences.length > 0) withDifferences++
    for (const d of r.differences) {
      if (d.kind === 'QTY_MISMATCH') qtyMismatches++
      else if (d.kind === 'UNIT_MISMATCH') unitMismatches++
      else if (d.kind === 'RATE_DIVERGENT') rateDivergences++
    }
  }
  return {
    total: results.length,
    matched,
    unmatched,
    ambiguous,
    rejected,
    withDifferences,
    qtyMismatches,
    unitMismatches,
    rateDivergences,
  }
}
