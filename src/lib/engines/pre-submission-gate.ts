/**
 * Pre-Submission Gate — deterministic go/no-go gate for bid submission.
 *
 * P0 fixes applied:
 * - P0-4: incomplete calculations are BLOCKERS (not just unsourced warnings).
 * - P0-8: commercial exceptions must be acknowledged AND (if high-value)
 *   director-approved. A bare boolean is insufficient.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O.
 */

import type { ScopeCompletenessResult } from './scope-completeness';

export interface GateCheck {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'blocker';
  detail?: string;
}

export interface GateResult {
  overall: 'pass' | 'warning' | 'blocker';
  checks: GateCheck[];
}

export interface UnresolvedAssumption {
  id: string;
  text: string;
  acknowledged: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
}

/** P0-4/P0-8: a flattened estimate line with calculation status + exceptions. */
export interface GateEstimateLine {
  id: string;
  description: string;
  isUnsourced: boolean;
  acknowledged: boolean;
  unitRate: number;
  /** P0-4: 'complete' or 'incomplete'. */
  calculationStatus: 'complete' | 'incomplete';
  /** P0-8: true if a CommercialException exists and is acknowledged+approved. */
  exceptionApproved?: boolean;
}

export interface GateSubcontractPackage {
  id: string;
  name: string;
  coveragePct: number;
  selectedQuoteId: string | null;
  /** P0-7: true if the selected quote is a lump-sum with no scope-atom detail. */
  isLumpSum?: boolean;
}

export interface GateDeliverables {
  boq: boolean;
  programme: boolean;
  methodStatement: boolean;
  jha: boolean;
  tenderPack: boolean;
}

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
 * Checks:
 * - `scope-completeness`: blocker if < 0.5, warning if < 0.85, else pass.
 * - `unresolved-assumptions`: blocker if any unacknowledged high-risk; warning if any unacknowledged.
 * - `unpriced-lines`: blocker if any line with unitRate === 0.
 * - `incomplete-calculations` (P0-4): blocker if any line with calculationStatus === 'incomplete'.
 * - `unsourced-rates` (P0-8): blocker if any isUnsourced && !acknowledged; warning if acknowledged but not director-approved.
 * - `subcontract-coverage`: blocker if lump-sum, coverage < 0.8, or no selected quote; warning if < 0.95.
 * - `deliverables`: blocker if BOQ/Programme/MS/JHA missing; warning if tenderPack missing.
 * - `commercial-approval`: blocker if not approved.
 */
export function runPreSubmissionGate(
  input: PreSubmissionGateInput,
): GateResult {
  const checks: GateCheck[] = [];

  // scope-completeness
  {
    const sc = input.scopeCompleteness?.score ?? 0;
    if (sc < 0.5) {
      checks.push({ id: 'scope-completeness', label: 'Scope Completeness', status: 'blocker', detail: `Score ${sc} below 0.50 threshold.` });
    } else if (sc < 0.85) {
      checks.push({ id: 'scope-completeness', label: 'Scope Completeness', status: 'warning', detail: `Score ${sc} below 0.85 target.` });
    } else {
      checks.push({ id: 'scope-completeness', label: 'Scope Completeness', status: 'pass', detail: `Score ${sc}.` });
    }
  }

  // unresolved-assumptions
  {
    const unack = (input.unresolvedAssumptions ?? []).filter((a) => !a.acknowledged);
    const highRiskUnack = unack.filter((a) => (a.riskLevel ?? 'medium') === 'high');
    if (highRiskUnack.length > 0) {
      checks.push({ id: 'unresolved-assumptions', label: 'Unresolved Assumptions', status: 'blocker', detail: `${highRiskUnack.length} unacknowledged high-risk assumption(s).` });
    } else if (unack.length > 0) {
      checks.push({ id: 'unresolved-assumptions', label: 'Unresolved Assumptions', status: 'warning', detail: `${unack.length} unacknowledged assumption(s).` });
    } else {
      checks.push({ id: 'unresolved-assumptions', label: 'Unresolved Assumptions', status: 'pass' });
    }
  }

  // unpriced-lines
  {
    const unpriced = (input.estimateLines ?? []).filter((l) => l.unitRate === 0);
    if (unpriced.length > 0) {
      checks.push({ id: 'unpriced-lines', label: 'Unpriced Lines', status: 'blocker', detail: `${unpriced.length} line(s) with zero unit rate.` });
    } else {
      checks.push({ id: 'unpriced-lines', label: 'Unpriced Lines', status: 'pass' });
    }
  }

  // incomplete-calculations (P0-4)
  {
    const incomplete = (input.estimateLines ?? []).filter((l) => l.calculationStatus === 'incomplete');
    if (incomplete.length > 0) {
      checks.push({ id: 'incomplete-calculations', label: 'Incomplete Calculations', status: 'blocker', detail: `${incomplete.length} line(s) with incomplete pricing — missing price observations or hybrid allocation. Cannot finalize.` });
    } else {
      checks.push({ id: 'incomplete-calculations', label: 'Incomplete Calculations', status: 'pass' });
    }
  }

  // unsourced-rates (P0-8: needs acknowledgement AND approval for high-value)
  {
    const unsourcedUnack = (input.estimateLines ?? []).filter((l) => l.isUnsourced && !l.acknowledged);
    const unsourcedAckNotApproved = (input.estimateLines ?? []).filter((l) => l.isUnsourced && l.acknowledged && !l.exceptionApproved);
    if (unsourcedUnack.length > 0) {
      checks.push({ id: 'unsourced-rates', label: 'Unsourced Rates', status: 'blocker', detail: `${unsourcedUnack.length} unacknowledged unsourced line(s).` });
    } else if (unsourcedAckNotApproved.length > 0) {
      checks.push({ id: 'unsourced-rates', label: 'Unsourced Rates', status: 'warning', detail: `${unsourcedAckNotApproved.length} acknowledged but not director-approved.` });
    } else {
      checks.push({ id: 'unsourced-rates', label: 'Unsourced Rates', status: 'pass' });
    }
  }

  // subcontract-coverage (P0-7: lump-sum = blocker)
  {
    const pkgs = input.subcontractPackages ?? [];
    const lumpSumPkgs = pkgs.filter((p) => p.isLumpSum);
    const blockerPkgs = pkgs.filter((p) => p.coveragePct < 0.8 || !p.selectedQuoteId || p.isLumpSum);
    const warnPkgs = pkgs.filter((p) => p.selectedQuoteId && !p.isLumpSum && p.coveragePct >= 0.8 && p.coveragePct < 0.95);
    if (blockerPkgs.length > 0) {
      const detail = lumpSumPkgs.length > 0
        ? `${lumpSumPkgs.length} lump-sum quote(s) with no scope-atom detail — coverage unknown.`
        : `${blockerPkgs.length} package(s) with coverage < 80% or no selected quote.`;
      checks.push({ id: 'subcontract-coverage', label: 'Subcontract Coverage', status: 'blocker', detail });
    } else if (warnPkgs.length > 0) {
      checks.push({ id: 'subcontract-coverage', label: 'Subcontract Coverage', status: 'warning', detail: `${warnPkgs.length} package(s) with coverage < 95%.` });
    } else {
      checks.push({ id: 'subcontract-coverage', label: 'Subcontract Coverage', status: 'pass' });
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
      checks.push({ id: 'deliverables', label: 'Deliverables', status: 'blocker', detail: `Missing required deliverables: ${missing.join(', ')}.` });
    } else if (tenderMissing) {
      checks.push({ id: 'deliverables', label: 'Deliverables', status: 'warning', detail: 'Tender pack not yet generated.' });
    } else {
      checks.push({ id: 'deliverables', label: 'Deliverables', status: 'pass' });
    }
  }

  // commercial-approval
  {
    if (!input.commercialApproval) {
      checks.push({ id: 'commercial-approval', label: 'Commercial Approval', status: 'blocker', detail: 'Commercial approval not granted.' });
    } else {
      checks.push({ id: 'commercial-approval', label: 'Commercial Approval', status: 'pass' });
    }
  }

  const overall = worstStatus(checks.map((c) => c.status));
  return { overall, checks };
}
