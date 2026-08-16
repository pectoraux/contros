/**
 * Knowledge Health Engine — deterministic alert generation from operational evidence.
 *
 * This engine is PURE: no I/O, no Date.now, no Math.random.
 * It takes structured inputs (price observations, productivity observations,
 * WorkDefinition approval states, estimate lines) and produces a list of
 * KnowledgeAlert seeds that the service can persist.
 *
 * INVARIANT 6: Financial logic is deterministic and testable.
 * The same inputs always produce the same alerts.
 *
 * Alert types generated:
 * - stale-price: a ResourcePriceObservation is older than the threshold.
 * - unapproved-rate: an EstimateLine references a draft (unapproved) WDV.
 * - productivity-variance: actual productivity diverges from planned by > threshold.
 */

export interface StalePriceInput {
  resourceId: string
  resourceName: string
  resourceCode: string
  latestPrice: number
  latestObservedAt: string // ISO date
  ageInDays: number
}

export interface UnapprovedRateInput {
  estimateLineId: string
  workDefinitionVersionId: string
  workDefinitionCode: string
  workDefinitionName: string
  approvalState: string // 'draft' | 'approved' | etc.
}

export interface ProductivityVarianceInput {
  workDefinitionVersionId: string
  workDefinitionCode: string
  plannedProductivity: number
  actualProductivity: number
  variancePct: number // (actual - planned) / planned
  sourceReference: string | null
}

export type KnowledgeAlertSeed =
  | {
      type: 'stale-price'
      severity: 'warning' | 'blocker'
      title: string
      detail: string
      entityId: string
      entityType: 'Resource'
    }
  | {
      type: 'unapproved-rate'
      severity: 'blocker'
      title: string
      detail: string
      entityId: string
      entityType: 'WorkDefinitionVersion'
    }
  | {
      type: 'productivity-variance'
      severity: 'warning' | 'blocker'
      title: string
      detail: string
      entityId: string
      entityType: 'WorkDefinitionVersion'
    }

export interface KnowledgeHealthResult {
  alerts: KnowledgeAlertSeed[]
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface KnowledgeHealthConfig {
  /** Price observations older than this many days are 'stale'. Default: 90. */
  stalePriceThresholdDays: number
  /** Productivity variance above this fraction triggers 'blocker'. Default: 0.25 (25%). */
  productivityBlockerThreshold: number
  /** Productivity variance above this fraction triggers 'warning'. Default: 0.10 (10%). */
  productivityWarningThreshold: number
}

export const DEFAULT_KNOWLEDGE_HEALTH_CONFIG: KnowledgeHealthConfig = {
  stalePriceThresholdDays: 90,
  productivityBlockerThreshold: 0.25,
  productivityWarningThreshold: 0.10,
}

// ─── Engine ─────────────────────────────────────────────────────────────────

/**
 * Detect stale price observations.
 * A price observation is 'stale' if its age exceeds the threshold.
 * Stale prices get 'warning' severity (not 'blocker') because they may still
 * be valid — but they should be refreshed.
 */
export function detectStalePrices(
  inputs: StalePriceInput[],
  config: KnowledgeHealthConfig = DEFAULT_KNOWLEDGE_HEALTH_CONFIG,
): KnowledgeAlertSeed[] {
  const alerts: KnowledgeAlertSeed[] = []
  for (const input of inputs) {
    if (input.ageInDays > config.stalePriceThresholdDays) {
      alerts.push({
        type: 'stale-price',
        severity: 'warning',
        title: `Stale price: ${input.resourceName} (${input.resourceCode})`,
        detail: `Last price observation (${input.latestPrice} ${'GHS'}) was ${input.ageInDays} days ago (threshold: ${config.stalePriceThresholdDays} days). Refresh the price to maintain estimate accuracy.`,
        entityId: input.resourceId,
        entityType: 'Resource',
      })
    }
  }
  return alerts
}

/**
 * Detect unapproved rates — EstimateLines that reference draft WorkDefinitionVersions.
 * These are 'blocker' severity because pricing against an unapproved recipe is
 * commercially risky.
 */
export function detectUnapprovedRates(
  inputs: UnapprovedRateInput[],
): KnowledgeAlertSeed[] {
  const alerts: KnowledgeAlertSeed[] = []
  for (const input of inputs) {
    if (input.approvalState !== 'approved') {
      alerts.push({
        type: 'unapproved-rate',
        severity: 'blocker',
        title: `Unapproved rate: ${input.workDefinitionName} (${input.workDefinitionCode})`,
        detail: `Estimate line references a WorkDefinitionVersion in '${input.approvalState}' state (not 'approved'). Pricing against an unapproved recipe is commercially risky — approve the version before submitting.`,
        entityId: input.workDefinitionVersionId,
        entityType: 'WorkDefinitionVersion',
      })
    }
  }
  return alerts
}

/**
 * Detect productivity variance — actual productivity diverging from planned.
 * Variance above the blocker threshold → 'blocker'.
 * Variance above the warning threshold → 'warning'.
 * Negative variance (actual > planned, i.e. better) is still flagged as 'warning'
 * because it may indicate an overly conservative recipe.
 */
export function detectProductivityVariance(
  inputs: ProductivityVarianceInput[],
  config: KnowledgeHealthConfig = DEFAULT_KNOWLEDGE_HEALTH_CONFIG,
): KnowledgeAlertSeed[] {
  const alerts: KnowledgeAlertSeed[] = []
  for (const input of inputs) {
    const absVariance = Math.abs(input.variancePct)
    if (absVariance > config.productivityBlockerThreshold) {
      alerts.push({
        type: 'productivity-variance',
        severity: 'blocker',
        title: `Productivity variance: ${input.workDefinitionCode}`,
        detail: `Actual productivity (${input.actualProductivity.toFixed(2)}) diverges from planned (${input.plannedProductivity.toFixed(2)}) by ${(input.variancePct * 100).toFixed(1)}%. Threshold for blocker: ${(config.productivityBlockerThreshold * 100).toFixed(0)}%. Consider calibrating the WorkDefinition.${input.sourceReference ? ` Source: ${input.sourceReference}` : ''}`,
        entityId: input.workDefinitionVersionId,
        entityType: 'WorkDefinitionVersion',
      })
    } else if (absVariance > config.productivityWarningThreshold) {
      alerts.push({
        type: 'productivity-variance',
        severity: 'warning',
        title: `Productivity variance: ${input.workDefinitionCode}`,
        detail: `Actual productivity (${input.actualProductivity.toFixed(2)}) diverges from planned (${input.plannedProductivity.toFixed(2)}) by ${(input.variancePct * 100).toFixed(1)}%. Threshold for warning: ${(config.productivityWarningThreshold * 100).toFixed(0)}%. Monitor for calibration need.${input.sourceReference ? ` Source: ${input.sourceReference}` : ''}`,
        entityId: input.workDefinitionVersionId,
        entityType: 'WorkDefinitionVersion',
      })
    }
  }
  return alerts
}

/**
 * Run the full knowledge-health analysis.
 * Combines all detectors and returns the merged alert list.
 */
export function runKnowledgeHealth(
  stalePrices: StalePriceInput[],
  unapprovedRates: UnapprovedRateInput[],
  productivityVariance: ProductivityVarianceInput[],
  config: KnowledgeHealthConfig = DEFAULT_KNOWLEDGE_HEALTH_CONFIG,
): KnowledgeHealthResult {
  const alerts: KnowledgeAlertSeed[] = [
    ...detectStalePrices(stalePrices, config),
    ...detectUnapprovedRates(unapprovedRates),
    ...detectProductivityVariance(productivityVariance, config),
  ]
  return { alerts }
}
