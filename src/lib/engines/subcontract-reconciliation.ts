/**
 * Subcontract Reconciliation Engine — deterministic reconciliation of a
 * subcontract quote against the required scope (INVARIANT 7).
 *
 * Final integrity pass fix (P0-1):
 * - Separates SEMANTIC coverage (atom count) from ECONOMIC coverage (value weight).
 * - ScopeAtoms now carry a `valueWeight` (0..1) representing their share of the
 *   package's commercial value. economicCoveragePct = Σ(covered weights) / Σ(all weights).
 * - If all weights are 0 or equal, economic coverage falls back to semantic coverage.
 * - A lump-sum quote with no scope-atom detail is 'unknown' coverage (blocker).
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client.
 */

import { round2, sum, formatGHS } from './money';

export interface ScopeAtomInput {
  id: string;
  name: string;
  description?: string;
  /** P0-1: Economic weight (0..1). If 0, falls back to equal weighting. */
  valueWeight?: number;
}

export interface QuoteScopeCoverageInput {
  scopeAtomId: string;
  status: 'covered' | 'excluded' | 'unstated';
  note?: string;
}

export interface RequiredLine {
  id: string;
  description: string;
  sellPrice: number;
}

export interface SubcontractQuoteInput {
  id: string;
  totalAmount: number;
  scopeCoverages: QuoteScopeCoverageInput[];
  exclusionsJson?: string;
  assumptionsJson?: string;
}

export interface ReconcileSubcontractInput {
  requiredLines: RequiredLine[];
  scopeAtoms: ScopeAtomInput[];
  quote: SubcontractQuoteInput | null;
}

export interface AtomReconciliation {
  scopeAtomId: string;
  name: string;
  status: 'covered' | 'excluded' | 'unstated';
  valueWeight: number;
  note?: string;
}

export interface ReconciliationResult {
  /** Semantic coverage = covered atoms / total atoms. */
  semanticCoveragePct: number;
  /** Economic coverage = Σ(covered weights) / Σ(all weights). Falls back to semantic if weights are 0/equal. */
  economicCoveragePct: number;
  /** 'atoms' = structured; 'lump-sum' = no atom detail; 'none' = no quote. */
  coverageBasis: 'atoms' | 'lump-sum' | 'none';
  /** The primary coverage used for status determination (economic when available, else semantic). */
  coveragePct: number;
  requiredScopeValue: number;
  coveredScopeValue: number;
  uncoveredValue: number;
  gaps: string[];
  excludedAtoms: string[];
  unstatedAtoms: string[];
  coveredAtoms: string[];
  atomReconciliations: AtomReconciliation[];
  exclusions: string[];
  assumptions: string[];
  warnings: string[];
  status: 'ok' | 'warning' | 'blocker';
  isLumpSum: boolean;
  /** True if economic coverage couldn't be determined (all weights 0). */
  economicCoverageUnknown: boolean;
}

function parseStringArray(json: string | undefined | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* ignore */ }
  return [];
}

export function reconcileSubcontract(
  input: ReconcileSubcontractInput,
): ReconciliationResult {
  const requiredLines = input.requiredLines ?? [];
  const scopeAtoms = input.scopeAtoms ?? [];
  const requiredScopeValue = round2(sum(requiredLines.map((l) => l.sellPrice)));

  if (!input.quote) {
    return {
      semanticCoveragePct: 0,
      economicCoveragePct: 0,
      coverageBasis: 'none',
      coveragePct: 0,
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
        valueWeight: a.valueWeight ?? 0,
      })),
      exclusions: [],
      assumptions: [],
      warnings: ['No subcontract quote provided.'],
      status: 'blocker',
      isLumpSum: false,
      economicCoverageUnknown: false,
    };
  }

  const exclusions = parseStringArray(input.quote.exclusionsJson);
  const assumptions = parseStringArray(input.quote.assumptionsJson);
  const quote = input.quote;

  if (scopeAtoms.length === 0) {
    return {
      semanticCoveragePct: 0,
      economicCoveragePct: 0,
      coverageBasis: 'lump-sum',
      coveragePct: 0,
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
      economicCoverageUnknown: true,
    };
  }

  const coverageMap = new Map<string, QuoteScopeCoverageInput>();
  for (const c of quote.scopeCoverages ?? []) {
    coverageMap.set(c.scopeAtomId, c);
  }

  const isLumpSum = (quote.scopeCoverages ?? []).length === 0;

  const atomReconciliations: AtomReconciliation[] = [];
  const coveredAtoms: string[] = [];
  const excludedAtoms: string[] = [];
  const unstatedAtoms: string[] = [];
  let coveredWeightSum = 0;
  let totalWeightSum = 0;
  let allWeightsZero = true;

  for (const atom of scopeAtoms) {
    const cov = coverageMap.get(atom.id);
    const status = cov?.status ?? 'unstated';
    const weight = atom.valueWeight ?? 0;
    totalWeightSum += weight;
    if (weight > 0) allWeightsZero = false;

    atomReconciliations.push({
      scopeAtomId: atom.id,
      name: atom.name,
      status,
      valueWeight: weight,
      note: cov?.note,
    });

    if (status === 'covered') {
      coveredAtoms.push(atom.name);
      coveredWeightSum += weight;
    } else if (status === 'excluded') {
      excludedAtoms.push(atom.name);
    } else {
      unstatedAtoms.push(atom.name);
    }
  }

  // Semantic coverage = covered atoms / total atoms.
  const semanticCoveragePct = scopeAtoms.length > 0
    ? Math.min(1, round2(coveredAtoms.length / scopeAtoms.length))
    : 0;

  // Economic coverage = covered weights / total weights.
  // If all weights are 0, economic coverage is 'unknown' — fall back to semantic.
  const economicCoverageUnknown = allWeightsZero || totalWeightSum === 0;
  const economicCoveragePct = economicCoverageUnknown
    ? semanticCoveragePct
    : Math.min(1, round2(coveredWeightSum / totalWeightSum));

  // Primary coverage for status: use economic when available, else semantic.
  const coveragePct = economicCoverageUnknown ? semanticCoveragePct : economicCoveragePct;
  const coveredScopeValue = round2(requiredScopeValue * coveragePct);
  const uncoveredValue = round2(requiredScopeValue - coveredScopeValue);

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
  if (economicCoverageUnknown && scopeAtoms.length > 0) {
    warnings.push('Economic coverage unknown — scope atoms have no value weights. Assign value weights for economic coverage.');
  } else if (semanticCoveragePct !== economicCoveragePct) {
    warnings.push(`Semantic coverage ${Math.round(semanticCoveragePct * 100)}% differs from economic coverage ${Math.round(economicCoveragePct * 100)}%.`);
  }
  if (assumptions.length > 0) {
    warnings.push(`Quote contains ${assumptions.length} assumption(s) — review before awarding.`);
  }

  let status: 'ok' | 'warning' | 'blocker';
  if (isLumpSum || excludedAtoms.length > 0 || coveragePct < 0.8) {
    status = 'blocker';
  } else if (coveragePct < 0.95) {
    status = 'warning';
  } else {
    status = 'ok';
  }

  return {
    semanticCoveragePct,
    economicCoveragePct,
    coverageBasis: isLumpSum ? 'lump-sum' : 'atoms',
    coveragePct,
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
    economicCoverageUnknown,
  };
}
