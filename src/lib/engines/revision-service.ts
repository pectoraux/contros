/**
 * Estimate Revision Service — finalize and replay immutable revisions (P0-6).
 *
 * INVARIANT 8: Submitted bids are reproducible from immutable revisions.
 *
 * When an EstimateRevision is finalized, it captures a complete immutable
 * snapshot of ALL pricing inputs:
 *   - WorkDefinitionVersion (id, version, cost recipe, wastage, productivity)
 *   - ResourcePriceObservation (price, provenance, source, observedAt)
 *   - ExecutionSegments (strategy, quantityPct, subcontract quote snapshot)
 *   - Subcontract scope interpretation (atoms, coverages, exclusions, economic coverage)
 *   - Estimate policy (overhead, profit, contingency)
 *   - Line descriptions, quantities, units
 *
 * Replaying a finalized revision reconstructs the EXACT same commercial result,
 * even if current WorkDefinitions, prices, or quotes have changed.
 *
 * This module is pure (no Prisma) — callers pass in the data to snapshot or replay.
 */

import { priceLine, type PricingInput, type PricingBreakdown, type ExecutionSegmentInput } from './pricing-engine'

/** Immutable snapshot of a subcontract quote's full scope interpretation. */
export interface SubcontractQuoteSnapshot {
  id: string
  supplierName: string
  totalAmount: number
  currency: string
  exclusions: string[]
  assumptions: string[]
  /** Full scope-atom coverage mapping at finalization time. */
  scopeCoverages: {
    scopeAtomId: string
    atomName: string
    atomValueWeight: number
    status: 'covered' | 'excluded' | 'unstated'
    note?: string
  }[]
  /** Coverage metrics frozen at finalization. */
  semanticCoveragePct: number
  economicCoveragePct: number
  economicCoverageUnknown: boolean
  uncoveredExposure: number
}

/** Immutable snapshot of a single estimate line's pricing inputs. */
export interface LineSnapshot {
  lineId: string
  description: string
  quantity: number
  unit: string
  executionStrategy: PricingInput['executionStrategy']
  workDefinitionVersion: {
    id: string
    name: string
    version: number
    unit: string
    wastage: number
    productivityRule?: number
    costRecipeJson: string
  } | null
  executionSegments: ExecutionSegmentInput[]
  /** Snapshot of the subcontract quote used (if any), including full scope state. */
  subcontractQuote?: {
    totalAmount: number
    coveragePct: number
    /** Full scope interpretation snapshot for reproducibility. */
    scopeSnapshot?: SubcontractQuoteSnapshot
  } | null
}

/** Immutable snapshot of the estimate's commercial policy. */
export interface PolicySnapshot {
  overheadPct: number
  profitPct: number
  contingencyPct: number
}

/** A complete immutable revision snapshot. */
export interface RevisionSnapshot {
  estimateId: string
  revisionNo: number
  policy: PolicySnapshot
  lines: LineSnapshot[]
  finalizedAt: string
  /** Schema version of the snapshot format — for forward compatibility. */
  snapshotVersion: number
}

/**
 * Finalize a revision: capture all pricing inputs into an immutable snapshot.
 *
 * The caller provides the current line data + policy. This function does NOT
 * mutate anything — it returns the snapshot JSON string to persist in
 * EstimateRevision.snapshotJson.
 */
export function finalizeRevision(
  estimateId: string,
  revisionNo: number,
  policy: PolicySnapshot,
  lines: LineSnapshot[],
): string {
  const snapshot: RevisionSnapshot = {
    estimateId,
    revisionNo,
    policy,
    lines,
    finalizedAt: new Date().toISOString(),
    snapshotVersion: 2, // v2 = includes subcontract scope snapshots
  }
  return JSON.stringify(snapshot)
}

/**
 * Replay a finalized revision: reconstruct the EXACT commercial result from
 * the immutable snapshot, independent of current mutable state.
 *
 * P0-6: This is the reproducibility proof. Changing current WorkDefinitions,
 * resource prices, or subcontract quotes must NOT change the replayed result.
 *
 * The replay uses ONLY the snapshot data — it never reads current mutable state.
 */
export function replayRevision(snapshotJson: string): {
  ok: true
  snapshot: RevisionSnapshot
  lines: (LineSnapshot & { breakdown: PricingBreakdown })[]
  totalDirectCost: number
  totalSellPrice: number
  totalEstimatedTotalCost: number
  totalExpectedProfit: number
  /** Subcontract scope interpretations frozen at finalization. */
  subcontractScopeSnapshots: SubcontractQuoteSnapshot[]
} | { ok: false; error: string } {
  let snapshot: RevisionSnapshot
  try {
    snapshot = JSON.parse(snapshotJson) as RevisionSnapshot
  } catch {
    return { ok: false, error: 'Invalid snapshot JSON — cannot replay.' }
  }

  if (!snapshot || !Array.isArray(snapshot.lines)) {
    return { ok: false, error: 'Invalid snapshot structure — missing lines array.' }
  }

  const subcontractScopeSnapshots: SubcontractQuoteSnapshot[] = []

  const replayedLines = snapshot.lines.map((line) => {
    const pricingInput: PricingInput = {
      workDefinitionVersion: line.workDefinitionVersion,
      quantity: line.quantity,
      executionStrategy: line.executionStrategy,
      executionSegments: line.executionSegments,
      overheadPct: snapshot.policy.overheadPct,
      profitPct: snapshot.policy.profitPct,
      contingencyPct: snapshot.policy.contingencyPct,
      subcontractQuote: line.subcontractQuote
        ? { totalAmount: line.subcontractQuote.totalAmount, coveragePct: line.subcontractQuote.coveragePct }
        : null,
    }
    const breakdown = priceLine(pricingInput)

    // Collect subcontract scope snapshots for the result
    if (line.subcontractQuote?.scopeSnapshot) {
      subcontractScopeSnapshots.push(line.subcontractQuote.scopeSnapshot)
    }

    return { ...line, breakdown }
  })

  const totalDirectCost = replayedLines.reduce((s, l) => s + l.breakdown.directCost, 0)
  const totalSellPrice = replayedLines.reduce((s, l) => s + l.breakdown.sellPrice, 0)
  const totalEstimatedTotalCost = replayedLines.reduce((s, l) => s + l.breakdown.estimatedTotalCost, 0)
  const totalExpectedProfit = replayedLines.reduce((s, l) => s + l.breakdown.expectedProfit, 0)

  return {
    ok: true,
    snapshot,
    lines: replayedLines,
    totalDirectCost: Math.round(totalDirectCost * 100) / 100,
    totalSellPrice: Math.round(totalSellPrice * 100) / 100,
    totalEstimatedTotalCost: Math.round(totalEstimatedTotalCost * 100) / 100,
    totalExpectedProfit: Math.round(totalExpectedProfit * 100) / 100,
    subcontractScopeSnapshots,
  }
}

/**
 * P0-7: Validate that a Bid can be submitted.
 *
 * A Bid cannot become 'submitted' unless:
 *   - estimateRevisionId is set (points to a finalized revision)
 *   - the referenced estimate is not in 'draft' status
 *   - finalPrice is set
 *   - all estimate lines are 'complete' (not 'incomplete')
 *
 * Returns { ok: true } or { ok: false, errors: string[] }.
 */
export function validateBidSubmission(input: {
  estimateRevisionId: string | null
  estimateStatus: string
  finalPrice: number | null
  hasFinalizedRevision: boolean
  incompleteLineCount?: number
}): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []

  if (!input.estimateRevisionId) {
    errors.push('Bid cannot be submitted without a finalized estimate revision (estimateRevisionId is null).')
  }
  if (!input.hasFinalizedRevision) {
    errors.push('The referenced estimate revision is not finalized — cannot submit.')
  }
  if (input.estimateStatus === 'draft') {
    errors.push('The estimate is still in draft status — cannot submit a bid.')
  }
  if (input.finalPrice === null || input.finalPrice === undefined) {
    errors.push('Final price is not set — cannot submit.')
  }
  if (input.incompleteLineCount && input.incompleteLineCount > 0) {
    errors.push(`${input.incompleteLineCount} estimate line(s) have incomplete calculations — cannot submit.`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
