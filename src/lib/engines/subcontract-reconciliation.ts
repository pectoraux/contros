/**
 * Subcontract Reconciliation Engine — deterministic reconciliation of a
 * subcontract quote against the required scope (INVARIANT 7).
 *
 * P0-7 fix: Reconciliation is now based on structured SCOPE ATOMS, not
 * bidirectional substring matching. A lump-sum quote with no scope detail
 * is 'unknown' coverage, NOT 100%.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client.
 */

import { round2, sum, formatGHS } from './money';

/** A required scope atom (e.g. "manufacture", "delivery", "installation"). */
export interface ScopeAtomInput {
  id: string;
  name: string;
  description?: string;
}

/** A quote's coverage status for a specific scope atom. */
export interface QuoteScopeCoverageInput {
  scopeAtomId: string;
  /** covered | excluded | unstated */
  status: 'covered' | 'excluded' | 'unstated';
  note?: string;
}

/** A required scope line (estimate line linked to the package). */
export interface RequiredLine {
  id: string;
  description: string;
  sellPrice: number;
}

/** A subcontract quote (flattened projection). */
export interface SubcontractQuoteInput {
  id: string;
  totalAmount: number;
  /** Structured scope-atom coverages (P0-7). */
  scopeCoverages: QuoteScopeCoverageInput[];
  /** Legacy exclusion/assumption text arrays (still surfaced as warnings). */
  exclusionsJson?: string;
  assumptionsJson?: string;
}

/** Input to `reconcileSubcontract`. */
export interface ReconcileSubcontractInput {
  requiredLines: RequiredLine[];
  scopeAtoms: ScopeAtomInput[];
  quote: SubcontractQuoteInput | null;
}

/** Per-atom reconciliation result. */
export interface AtomReconciliation {
  scopeAtomId: string;
  name: string;
  status: 'covered' | 'excluded' | 'unstated';
  note?: string;
}

/** Result of `reconcileSubcontract`. */
export interface ReconciliationResult {
  /** 0..1, based on structured atom coverage. */
  coveragePct: number;
  /** 'atoms' = structured; 'lump-sum' = no atom detail (unknown). */
  coverageBasis: 'atoms' | 'lump-sum' | 'none';
  requiredScopeValue: number;
  coveredScopeValue: number;
  uncoveredValue: number;
  /** Required lines with no matching quote coverage. */
  gaps: string[];
  /** Atoms that are explicitly excluded by the quote. */
  excludedAtoms: string[];
  /** Atoms the quote didn't address — must be reviewed. */
  unstatedAtoms: string[];
  /** Atoms the quote explicitly covers. */
  coveredAtoms: string[];
  atomReconciliations: AtomReconciliation[];
  /** Supplier quote exclusions (legacy text). */
  exclusions: string[];
  /** Supplier quote assumptions (legacy text). */
  assumptions: string[];
  /** Human-readable warnings. */
  warnings: string[];
  status: 'ok' | 'warning' | 'blocker';
  /** True if the quote has no scope-atom detail (lump-sum). */
  isLumpSum: boolean;
}

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
 * Reconcile a subcontract quote against the required scope using structured
 * scope atoms (P0-7).
 *
 * Algorithm:
 * - If `quote` is null → status = 'blocker', coverage = 0.
 * - If `scopeAtoms` is empty → we can't do structured reconciliation;
 *   coverage is 'unknown' (basis = 'lump-sum' if quote exists). status = blocker.
 * - If the quote has NO scopeCoverages → it's a lump-sum quote. coverageBasis
 *   = 'lump-sum', all atoms are 'unstated'. status = blocker (must be reviewed).
 * - Otherwise: for each scope atom, look up its coverage status in the quote.
 *   covered = counts toward coverage; excluded/unstated = gap.
 * - coveragePct = coveredAtoms / totalAtoms (NOT based on dollar value —
 *   scope coverage is semantic, not financial).
 * - status = 'blocker' if any excluded atom intersects required scope OR
 *   coverage < 0.8; 'warning' if < 0.95; 'ok' if >= 0.95.
 *
 * A lump-sum quote NEVER gets 100% coverage automatically.
 */
export function reconcileSubcontract(
  input: ReconcileSubcontractInput,
): ReconciliationResult {
  const requiredLines = input.requiredLines ?? [];
  const scopeAtoms = input.scopeAtoms ?? [];
  const requiredScopeValue = round2(sum(requiredLines.map((l) => l.sellPrice)));

  if (!input.quote) {
    return {
      coveragePct: 0,
      coverageBasis: 'none',
      requiredScopeValue,
      coveredScopeValue: 0,
      uncoveredValue: requiredScopeValue,
      gaps: requiredLines.map((l) => l.description),
      excludedAtoms: [],
      unstatedAtoms: scopeAtoms.map((a) => a.name),
      coveredAtoms: [],
      atomReconciliations: scopeAtoms.map((a) => ({
        scopeAtomId: a.id,
        name: a.name,
        status: 'unstated',
      })),
      exclusions: [],
      assumptions: [],
      warnings: ['No subcontract quote provided.'],
      status: 'blocker',
      isLumpSum: false,
    };
  }

  const exclusions = parseStringArray(input.quote.exclusionsJson);
  const assumptions = parseStringArray(input.quote.assumptionsJson);
  const quote = input.quote;

  // No scope atoms defined → can't do structured reconciliation.
  if (scopeAtoms.length === 0) {
    return {
      coveragePct: 0,
      coverageBasis: 'lump-sum',
      requiredScopeValue,
      coveredScopeValue: 0,
      uncoveredValue: requiredScopeValue,
      gaps: requiredLines.map((l) => l.description),
      excludedAtoms: [],
      unstatedAtoms: [],
      coveredAtoms: [],
      atomReconciliations: [],
      exclusions,
      assumptions,
      warnings: [
        'No scope atoms defined for this package. Cannot perform structured reconciliation.',
        'Lump-sum coverage is not accepted — define required scope atoms.',
      ],
      status: 'blocker',
      isLumpSum: true,
    };
  }

  // Build atom coverage map.
  const coverageMap = new Map<string, QuoteScopeCoverageInput>();
  for (const c of quote.scopeCoverages ?? []) {
    coverageMap.set(c.scopeAtomId, c);
  }

  // If the quote has NO scopeCoverages at all → lump-sum, all unstated.
  const isLumpSum = (quote.scopeCoverages ?? []).length === 0;

  const atomReconciliations: AtomReconciliation[] = [];
  const coveredAtoms: string[] = [];
  const excludedAtoms: string[] = [];
  const unstatedAtoms: string[] = [];

  for (const atom of scopeAtoms) {
    const cov = coverageMap.get(atom.id);
    const status = cov?.status ?? 'unstated';
    atomReconciliations.push({
      scopeAtomId: atom.id,
      name: atom.name,
      status,
      note: cov?.note,
    });
    if (status === 'covered') coveredAtoms.push(atom.name);
    else if (status === 'excluded') excludedAtoms.push(atom.name);
    else unstatedAtoms.push(atom.name);
  }

  // Coverage = covered atoms / total atoms (semantic, not financial).
  const coveragePct = scopeAtoms.length > 0
    ? Math.min(1, round2(coveredAtoms.length / scopeAtoms.length))
    : 0;

  // Covered scope value = proportional coverage × required value.
  const coveredScopeValue = round2(requiredScopeValue * coveragePct);
  const uncoveredValue = round2(requiredScopeValue - coveredScopeValue);

  // Gaps = required lines with no coverage (all uncovered for now, since
  // atom-level gaps are more precise).
  const gaps = uncoveredValue > 0
    ? [`${unstatedAtoms.length + excludedAtoms.length} scope atom(s) not covered`]
    : [];

  const warnings: string[] = [];
  if (isLumpSum) {
    warnings.push('Quote has no scope-atom detail (lump-sum). Coverage is unknown — review required before awarding.');
  }
  if (excludedAtoms.length > 0) {
    warnings.push(`Quote explicitly excludes: ${excludedAtoms.join(', ')}.`);
  }
  if (unstatedAtoms.length > 0) {
    warnings.push(`Quote does not address: ${unstatedAtoms.join(', ')}.`);
  }
  if (coveragePct < 1) {
    warnings.push(`Coverage ${Math.round(coveragePct * 100)}% — uncovered value ${formatGHS(uncoveredValue)}.`);
  }
  if (assumptions.length > 0) {
    warnings.push(`Quote contains ${assumptions.length} assumption(s) — review before awarding.`);
  }

  // Status: blocker if excluded atoms exist OR coverage < 0.8; warning if < 0.95.
  let status: 'ok' | 'warning' | 'blocker';
  if (isLumpSum || excludedAtoms.length > 0 || coveragePct < 0.8) {
    status = 'blocker';
  } else if (coveragePct < 0.95) {
    status = 'warning';
  } else {
    status = 'ok';
  }

  return {
    coveragePct,
    coverageBasis: isLumpSum ? 'lump-sum' : 'atoms',
    requiredScopeValue,
    coveredScopeValue,
    uncoveredValue,
    gaps,
    excludedAtoms,
    unstatedAtoms,
    coveredAtoms,
    atomReconciliations,
    exclusions,
    assumptions,
    warnings,
    status,
    isLumpSum,
  };
}
