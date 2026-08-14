/**
 * Subcontract Reconciliation Engine — deterministic reconciliation of a
 * subcontract quote against the required scope (INVARIANT 7).
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client.
 */

import { formatGHS, round2, sum } from './money';

/** Result of `reconcileSubcontract`. */
export interface ReconciliationResult {
  /** 0..1, capped at 1.0. */
  coveragePct: number;
  requiredScopeValue: number;
  coveredScopeValue: number;
  uncoveredValue: number;
  /** Required lines with no matching quote coverage. */
  gaps: string[];
  /** Supplier quote exclusions (parsed from `exclusionsJson`). */
  exclusions: string[];
  /** Supplier quote assumptions (parsed from `assumptionsJson`). */
  assumptions: string[];
  /** Human-readable warnings (always non-empty when status != 'ok'). */
  warnings: string[];
  status: 'ok' | 'warning' | 'blocker';
}

/** A required scope line for reconciliation. */
export interface RequiredLine {
  id: string;
  description: string;
  /** Sell price of this required line (the value at risk). */
  sellPrice: number;
}

/** A subcontract quote (flattened projection of `SubcontractQuote`). */
export interface SubcontractQuoteInput {
  totalAmount: number;
  exclusionsJson: string;
  assumptionsJson: string;
  lines?: { description: string; amount: number }[];
}

/** Input to `reconcileSubcontract`. */
export interface ReconcileSubcontractInput {
  requiredLines: RequiredLine[];
  quote: SubcontractQuoteInput | null;
}

/**
 * Parse a JSON string expected to be a `string[]`. Returns `[]` on any error.
 */
function parseStringArray(json: string | undefined | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Check if two descriptions "match" by bidirectional case-insensitive
 * substring containment.
 */
function descriptionsMatch(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.length === 0 || lb.length === 0) return false;
  return la.includes(lb) || lb.includes(la);
}

/**
 * Reconcile a subcontract quote against the required scope.
 *
 * Algorithm:
 * - If `quote` is null → status = 'blocker', coverage = 0, all required lines
 *   are gaps.
 * - `requiredScopeValue` = sum of `requiredLines.sellPrice`.
 * - `exclusions` / `assumptions` parsed from their JSON fields (defensive).
 * - If `quote.lines` is non-empty: each required line is matched one-to-one
 *   with the first unmatched quote line whose description bidirectionally
 *   contains the required line's description (case-insensitive). Matched
 *   amounts accumulate into `coveredScopeValue`; unmatched required lines
 *   become `gaps`.
 * - If `quote.lines` is empty: `coveredScopeValue = quote.totalAmount`
 *   (whole-quote heuristic per spec). If uncovered value remains, a single
 *   synthetic gap entry is added describing the uncovered amount.
 * - `coveragePct = min(1, coveredScopeValue / requiredScopeValue)` (guard 0).
 * - `status` = 'blocker' if any exclusion intersects a required description,
 *   else 'ok' if coverage >= 0.95, 'warning' if >= 0.80, 'blocker' otherwise.
 *
 * @param input - The required lines and the quote to reconcile.
 * @returns A `ReconciliationResult`.
 */
export function reconcileSubcontract(
  input: ReconcileSubcontractInput,
): ReconciliationResult {
  const requiredLines = input.requiredLines ?? [];
  const requiredScopeValue = round2(
    sum(requiredLines.map((l) => l.sellPrice)),
  );

  if (!input.quote) {
    return {
      coveragePct: 0,
      requiredScopeValue,
      coveredScopeValue: 0,
      uncoveredValue: requiredScopeValue,
      gaps: requiredLines.map((l) => l.description),
      exclusions: [],
      assumptions: [],
      warnings: ['No subcontract quote provided.'],
      status: 'blocker',
    };
  }

  const exclusions = parseStringArray(input.quote.exclusionsJson);
  const assumptions = parseStringArray(input.quote.assumptionsJson);

  let coveredScopeValue = 0;
  const gaps: string[] = [];
  const warnings: string[] = [];

  const quoteLines = input.quote.lines ?? [];
  if (quoteLines.length > 0) {
    const usedQuoteLines = new Set<number>();
    for (const req of requiredLines) {
      let matched = false;
      for (let i = 0; i < quoteLines.length; i++) {
        if (usedQuoteLines.has(i)) continue;
        if (descriptionsMatch(req.description, quoteLines[i].description)) {
          coveredScopeValue += quoteLines[i].amount;
          usedQuoteLines.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) gaps.push(req.description);
    }
  } else {
    // No quote line detail — treat whole quote.totalAmount as coverage.
    coveredScopeValue = input.quote.totalAmount;
    if (coveredScopeValue < requiredScopeValue) {
      gaps.push(
        `Uncovered scope value: ${formatGHS(
          requiredScopeValue - coveredScopeValue,
        )}`,
      );
    }
  }

  coveredScopeValue = round2(coveredScopeValue);
  const uncoveredValue = round2(
    Math.max(0, requiredScopeValue - coveredScopeValue),
  );
  const coveragePct =
    requiredScopeValue > 0
      ? Math.min(1, round2(coveredScopeValue / requiredScopeValue))
      : 0;

  // Exclusions that intersect required descriptions → blocker.
  let exclusionBlocker = false;
  for (const excl of exclusions) {
    const exclLower = excl.toLowerCase();
    if (exclLower.length === 0) continue;
    for (const req of requiredLines) {
      const reqLower = req.description.toLowerCase();
      if (reqLower.length === 0) continue;
      if (reqLower.includes(exclLower) || exclLower.includes(reqLower)) {
        exclusionBlocker = true;
        warnings.push(
          `Exclusion "${excl}" intersects required scope: "${req.description}"`,
        );
        break;
      }
    }
  }

  let status: 'ok' | 'warning' | 'blocker';
  if (exclusionBlocker) {
    status = 'blocker';
  } else if (coveragePct >= 0.95) {
    status = 'ok';
  } else if (coveragePct >= 0.8) {
    status = 'warning';
  } else {
    status = 'blocker';
  }

  if (gaps.length > 0) {
    warnings.push(`${gaps.length} required scope line(s) not covered by quote.`);
  }
  if (coveragePct < 1) {
    warnings.push(
      `Coverage ${Math.round(coveragePct * 100)}% — uncovered value ${formatGHS(
        uncoveredValue,
      )}.`,
    );
  }
  if (assumptions.length > 0) {
    warnings.push(
      `Quote contains ${assumptions.length} assumption(s) — review before awarding.`,
    );
  }

  return {
    coveragePct,
    requiredScopeValue,
    coveredScopeValue,
    uncoveredValue,
    gaps,
    exclusions,
    assumptions,
    warnings,
    status,
  };
}
