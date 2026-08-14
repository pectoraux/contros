/**
 * Confidence Engine — deterministic evidence-weighted confidence score
 * for an estimate line / estimate / bid.
 *
 * Pure: no `Math.random`, no `Date.now`. The caller must supply a
 * `referenceDate` (typically the estimate's `updatedAt`) so freshness
 * can be computed deterministically and reproducibly from an immutable
 * estimate revision (INVARIANT 8).
 */

import { round2 } from './money';

/** A single weighted factor contributing to the overall confidence score. */
export interface ConfidenceFactor {
  /** Factor key, e.g. "priceFreshness". */
  label: string;
  /** Weight in the weighted average (0..1). */
  weight: number;
  /** Factor value (0..1). */
  value: number;
}

/** Inputs to `computeConfidence`. All fields optional — defaults are conservative. */
export interface ConfidenceInput {
  /** ISO date string of the price observation. */
  observedAt?: string | null;
  /** ISO date string used as "today" for freshness calculation. Required for freshness. */
  referenceDate?: string | null;
  /** Provenance kind: supplier-quote | invoice | market-survey | historical-bid | manual | subcontract-quote. */
  priceProvenance?: string | null;
  /** WorkDefinitionVersion.approvalState: "approved" | "draft" | other. */
  workDefinitionApprovalState?: string | null;
  /** Pass-through scope completeness score (0..1) from the scope engine. */
  scopeCompleteness?: number | null;
  executionStrategy?: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided' | null;
  /** True if a subcontract quote has been attached. */
  subcontractQuotePresent?: boolean | null;
  /** WorkDefinitionVersion.productivityRule (output per crew-day). */
  productivityRule?: number | null;
  /** Estimate line quantity. */
  quantity?: number | null;
  /** Estimate line unit (m, m2, m3, nr, ton, ...). */
  unit?: string | null;
}

/** Result of `computeConfidence`. */
export interface ConfidenceResult {
  /** Weighted average confidence score, 0..1, rounded to 4 decimals. */
  score: number;
  /** The contributing factors with their weights and values. */
  factors: ConfidenceFactor[];
}

/** Mapping from provenance kind → 0..1 source-reliability weight. */
const PRICE_SOURCE_WEIGHTS: Record<string, number> = {
  'supplier-quote': 1.0,
  'invoice': 0.95,
  'subcontract-quote': 0.9,
  'market-survey': 0.8,
  'historical-bid': 0.6,
  'manual': 0.5,
};

/**
 * Compute the day difference `b - a` for two ISO date strings.
 * Returns `null` if either date is invalid.
 */
function daysBetween(a: string, b: string): number | null {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return (db - da) / (1000 * 60 * 60 * 24);
}

/**
 * Compute a deterministic, evidence-weighted confidence score (0..1).
 *
 * Factors and weights (per spec):
 * - priceFreshness (0.20): 1.0 if observed within 30 days of referenceDate,
 *   0.7 within 90, 0.4 within 180, 0.2 otherwise. Missing observedAt or
 *   referenceDate → 0.2.
 * - priceSource (0.20): mapped from `PRICE_SOURCE_WEIGHTS`; unknown → 0.5.
 * - workDefinitionApproval (0.20): 1.0 if "approved", else 0.4.
 * - scopeCompleteness (0.15): pass-through (clamped 0..1); missing → 0.5.
 * - subcontractQuoteAvailable (0.10): 1.0 if strategy=subcontract and quote
 *   present; 0.3 if subcontract and no quote; 1.0 for non-subcontract strategies
 *   (no subcontract risk).
 * - productivityEvidence (0.10): 1.0 if productivityRule > 0, else 0.5.
 * - measurementCertainty (0.05): 1.0 if quantity > 0 and unit present, else 0.5.
 *
 * @param input - The confidence inputs.
 * @returns `{ score, factors }` — score is rounded to 4 decimals.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  // priceFreshness
  let priceFreshness = 0.2;
  if (input.observedAt && input.referenceDate) {
    const days = daysBetween(input.observedAt, input.referenceDate);
    if (days !== null) {
      if (days <= 30) priceFreshness = 1.0;
      else if (days <= 90) priceFreshness = 0.7;
      else if (days <= 180) priceFreshness = 0.4;
      else priceFreshness = 0.2;
    }
  }

  // priceSource
  const sourceKey = input.priceProvenance ?? '';
  const priceSource = PRICE_SOURCE_WEIGHTS[sourceKey] ?? 0.5;

  // workDefinitionApproval
  const workDefinitionApproval =
    input.workDefinitionApprovalState === 'approved' ? 1.0 : 0.4;

  // scopeCompleteness — pass-through, clamped.
  let scopeCompleteness = 0.5;
  if (
    typeof input.scopeCompleteness === 'number' &&
    Number.isFinite(input.scopeCompleteness)
  ) {
    scopeCompleteness = Math.max(0, Math.min(1, input.scopeCompleteness));
  }

  // subcontractQuoteAvailable
  let subcontractQuoteAvailable = 0.5;
  if (input.executionStrategy === 'subcontract') {
    subcontractQuoteAvailable = input.subcontractQuotePresent ? 1.0 : 0.3;
  } else {
    // self-perform / hybrid / undecided / null — no subcontract risk.
    subcontractQuoteAvailable = 1.0;
  }

  // productivityEvidence
  const productivityEvidence =
    typeof input.productivityRule === 'number' &&
    Number.isFinite(input.productivityRule) &&
    input.productivityRule > 0
      ? 1.0
      : 0.5;

  // measurementCertainty
  const measurementCertainty =
    typeof input.quantity === 'number' &&
    Number.isFinite(input.quantity) &&
    input.quantity > 0 &&
    typeof input.unit === 'string' &&
    input.unit.trim().length > 0
      ? 1.0
      : 0.5;

  const factors: ConfidenceFactor[] = [
    { label: 'priceFreshness', weight: 0.2, value: priceFreshness },
    { label: 'priceSource', weight: 0.2, value: priceSource },
    { label: 'workDefinitionApproval', weight: 0.2, value: workDefinitionApproval },
    { label: 'scopeCompleteness', weight: 0.15, value: scopeCompleteness },
    { label: 'subcontractQuoteAvailable', weight: 0.1, value: subcontractQuoteAvailable },
    { label: 'productivityEvidence', weight: 0.1, value: productivityEvidence },
    { label: 'measurementCertainty', weight: 0.05, value: measurementCertainty },
  ];

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weightedSum = factors.reduce((s, f) => s + f.weight * f.value, 0);
  const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  // Round to 4 decimals for score precision on a 0..1 scale.
  const score = Math.round(rawScore * 1e4) / 1e4;

  return { score, factors };
}

/** Re-export for callers that want consistent 2-decimal rounding of the score. */
export { round2 };
