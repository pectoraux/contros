/**
 * Pre-Submission Gate — deterministic go/no-go gate for bid submission.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O. Aggregates outputs from
 * the scope, pricing, and subcontract engines into a single pass/warn/block
 * decision.
 */

import type { ScopeCompletenessResult } from './scope-completeness';

/** A single gate check result. */
export interface GateCheck {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'blocker';
  detail?: string;
}

/** Overall gate result. */
export interface GateResult {
  /** Worst status among all checks. */
  overall: 'pass' | 'warning' | 'blocker';
  checks: GateCheck[];
}

/** An unresolved assumption (flattened `ScopeAssumption`). */
export interface UnresolvedAssumption {
  id: string;
  text: string;
  acknowledged: boolean;
  /** Risk level — defaults to "medium" if omitted. */
  riskLevel?: 'low' | 'medium' | 'high';
}

/** A flattened estimate line for the gate. */
export interface GateEstimateLine {
  id: string;
  description: string;
  isUnsourced: boolean;
  acknowledged: boolean;
  unitRate: number;
}

/** A flattened subcontract package for the gate. */
export interface GateSubcontractPackage {
  id: string;
  name: string;
  coveragePct: number;
  selectedQuoteId: string | null;
}

/** Required deliverables for bid submission. */
export interface GateDeliverables {
  boq: boolean;
  programme: boolean;
  methodStatement: boolean;
  jha: boolean;
  tenderPack: boolean;
}

/** Input to `runPreSubmissionGate`. */
export interface PreSubmissionGateInput {
  scopeCompleteness: ScopeCompletenessResult;
  unresolvedAssumptions: UnresolvedAssumption[];
  estimateLines: GateEstimateLine[];
  subcontractPackages: GateSubcontractPackage[];
  deliverables: GateDeliverables;
  commercialApproval: boolean;
}

const STATUS_RANK: Record<GateCheck['status'], number> = {
  pass: 0,
  warning: 1,
  blocker: 2,
};

function worstStatus(statuses: GateCheck['status'][]): GateCheck['status'] {
  let worst: GateCheck['status'] = 'pass';
  for (const s of statuses) {
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

/**
 * Run the pre-submission gate.
 *
 * Checks (each → pass/warning/blocker):
 * - `scope-completeness`: blocker if score < 0.5, warning if < 0.85, else pass.
 * - `unresolved-assumptions`: blocker if any unacknowledged high-risk;
 *   warning if any unacknowledged; else pass.
 * - `unpriced-lines`: blocker if any line with `unitRate === 0`.
 * - `unsourced-rates`: blocker if any `isUnsourced && !acknowledged`;
 *   warning if `isUnsourced && acknowledged`.
 * - `subcontract-coverage`: blocker if any package `coveragePct < 0.8`
 *   or no selected quote; warning if `< 0.95`.
 * - `deliverables`: blocker if BOQ/Programme/MethodStatement/JHA missing;
 *   warning if `tenderPack` missing.
 * - `commercial-approval`: blocker if not approved.
 *
 * `overall` = worst status among all checks.
 *
 * @param input - The gate inputs.
 * @returns A `GateResult` with the overall verdict and per-check details.
 */
export function runPreSubmissionGate(
  input: PreSubmissionGateInput,
): GateResult {
  const checks: GateCheck[] = [];

  // scope-completeness
  {
    const sc = input.scopeCompleteness?.score ?? 0;
    if (sc < 0.5) {
      checks.push({
        id: 'scope-completeness',
        label: 'Scope Completeness',
        status: 'blocker',
        detail: `Score ${sc} below 0.50 threshold.`,
      });
    } else if (sc < 0.85) {
      checks.push({
        id: 'scope-completeness',
        label: 'Scope Completeness',
        status: 'warning',
        detail: `Score ${sc} below 0.85 target.`,
      });
    } else {
      checks.push({
        id: 'scope-completeness',
        label: 'Scope Completeness',
        status: 'pass',
        detail: `Score ${sc}.`,
      });
    }
  }

  // unresolved-assumptions
  {
    const unack = (input.unresolvedAssumptions ?? []).filter((a) => !a.acknowledged);
    const highRiskUnack = unack.filter(
      (a) => (a.riskLevel ?? 'medium') === 'high',
    );
    if (highRiskUnack.length > 0) {
      checks.push({
        id: 'unresolved-assumptions',
        label: 'Unresolved Assumptions',
        status: 'blocker',
        detail: `${highRiskUnack.length} unacknowledged high-risk assumption(s).`,
      });
    } else if (unack.length > 0) {
      checks.push({
        id: 'unresolved-assumptions',
        label: 'Unresolved Assumptions',
        status: 'warning',
        detail: `${unack.length} unacknowledged assumption(s).`,
      });
    } else {
      checks.push({
        id: 'unresolved-assumptions',
        label: 'Unresolved Assumptions',
        status: 'pass',
      });
    }
  }

  // unpriced-lines
  {
    const unpriced = (input.estimateLines ?? []).filter(
      (l) => l.unitRate === 0,
    );
    if (unpriced.length > 0) {
      checks.push({
        id: 'unpriced-lines',
        label: 'Unpriced Lines',
        status: 'blocker',
        detail: `${unpriced.length} line(s) with zero unit rate.`,
      });
    } else {
      checks.push({
        id: 'unpriced-lines',
        label: 'Unpriced Lines',
        status: 'pass',
      });
    }
  }

  // unsourced-rates
  {
    const unsourcedUnack = (input.estimateLines ?? []).filter(
      (l) => l.isUnsourced && !l.acknowledged,
    );
    const unsourcedAck = (input.estimateLines ?? []).filter(
      (l) => l.isUnsourced && l.acknowledged,
    );
    if (unsourcedUnack.length > 0) {
      checks.push({
        id: 'unsourced-rates',
        label: 'Unsourced Rates',
        status: 'blocker',
        detail: `${unsourcedUnack.length} unacknowledged unsourced line(s).`,
      });
    } else if (unsourcedAck.length > 0) {
      checks.push({
        id: 'unsourced-rates',
        label: 'Unsourced Rates',
        status: 'warning',
        detail: `${unsourcedAck.length} acknowledged unsourced line(s).`,
      });
    } else {
      checks.push({
        id: 'unsourced-rates',
        label: 'Unsourced Rates',
        status: 'pass',
      });
    }
  }

  // subcontract-coverage
  {
    const pkgs = input.subcontractPackages ?? [];
    const blockerPkgs = pkgs.filter(
      (p) => p.coveragePct < 0.8 || !p.selectedQuoteId,
    );
    const warnPkgs = pkgs.filter(
      (p) => p.selectedQuoteId && p.coveragePct >= 0.8 && p.coveragePct < 0.95,
    );
    if (blockerPkgs.length > 0) {
      checks.push({
        id: 'subcontract-coverage',
        label: 'Subcontract Coverage',
        status: 'blocker',
        detail: `${blockerPkgs.length} package(s) with coverage < 80% or no selected quote.`,
      });
    } else if (warnPkgs.length > 0) {
      checks.push({
        id: 'subcontract-coverage',
        label: 'Subcontract Coverage',
        status: 'warning',
        detail: `${warnPkgs.length} package(s) with coverage < 95%.`,
      });
    } else {
      checks.push({
        id: 'subcontract-coverage',
        label: 'Subcontract Coverage',
        status: 'pass',
      });
    }
  }

  // deliverables
  {
    const missing: string[] = [];
    if (!input.deliverables?.boq) missing.push('BOQ');
    if (!input.deliverables?.programme) missing.push('Programme');
    if (!input.deliverables?.methodStatement) missing.push('Method Statement');
    if (!input.deliverables?.jha) missing.push('Job Hazard Analysis');
    const tenderMissing = !input.deliverables?.tenderPack;
    if (missing.length > 0) {
      checks.push({
        id: 'deliverables',
        label: 'Deliverables',
        status: 'blocker',
        detail: `Missing required deliverables: ${missing.join(', ')}.`,
      });
    } else if (tenderMissing) {
      checks.push({
        id: 'deliverables',
        label: 'Deliverables',
        status: 'warning',
        detail: 'Tender pack not yet generated.',
      });
    } else {
      checks.push({
        id: 'deliverables',
        label: 'Deliverables',
        status: 'pass',
      });
    }
  }

  // commercial-approval
  {
    if (!input.commercialApproval) {
      checks.push({
        id: 'commercial-approval',
        label: 'Commercial Approval',
        status: 'blocker',
        detail: 'Commercial approval not granted.',
      });
    } else {
      checks.push({
        id: 'commercial-approval',
        label: 'Commercial Approval',
        status: 'pass',
      });
    }
  }

  const overall = worstStatus(checks.map((c) => c.status));
  return { overall, checks };
}
