/**
 * Contractor OS — Deterministic Domain Engines.
 *
 * Barrel re-export for all engine modules. Pure TypeScript, no React, no
 * Prisma client — callers pass plain data.
 *
 * Engines:
 * - `money` — banker's-safe 2-decimal rounding, sum, GHS formatter.
 * - `pricing-engine` — deterministic cost build-up per EstimateLine.
 * - `confidence` — evidence-weighted 0..1 confidence score.
 * - `scope-completeness` — 0..1 scope completeness score.
 * - `subcontract-reconciliation` — quote vs required scope coverage.
 * - `pre-submission-gate` — go/no-go gate for bid submission.
 * - `schedule-engine` — CPM scheduler + heuristic programme generator.
 */

export { round2, sum, formatGHS } from './money';

export type {
  CostRecipeLine,
  PricingWorkDefinitionVersion,
  ExecutionSegmentInput,
  BlockingInput,
  CalculationStatus,
  PricingInput,
  PricingProvenanceEntry,
  PricingBreakdown,
} from './pricing-engine';
export { priceLine } from './pricing-engine';

export type {
  ConfidenceFactor,
  ConfidenceInput,
  ConfidenceResult,
} from './confidence';
export { computeConfidence } from './confidence';

export type {
  ScopeCompletenessResult,
  ScopeCompletenessItem,
  ScopeCompletenessQuestion,
} from './scope-completeness';
export { computeScopeCompleteness } from './scope-completeness';

export type {
  ReconciliationResult,
  RequiredLine,
  SubcontractQuoteInput,
  ReconcileSubcontractInput,
  ScopeAtomInput,
  QuoteScopeCoverageInput,
  AtomReconciliation,
} from './subcontract-reconciliation';
export { reconcileSubcontract } from './subcontract-reconciliation';

export type {
  GateCheck,
  GateResult,
  UnresolvedAssumption,
  GateEstimateLine,
  GateSubcontractPackage,
  GateDeliverables,
  PreSubmissionGateInput,
} from './pre-submission-gate';
export { runPreSubmissionGate } from './pre-submission-gate';

export type {
  SchedulePredecessor,
  ScheduleActivity,
  ScheduledActivity,
  ScheduleResult,
  GenerateProgrammeInput,
} from './schedule-engine';
export { computeSchedule, generateProgrammeFromEstimate } from './schedule-engine';
