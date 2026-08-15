/**
 * Pricing Engine — deterministic cost build-up for an EstimateLine.
 *
 * This is the canonical financial calculation layer (INVARIANT 6).
 * The LLM never performs financial arithmetic — it always delegates here.
 *
 * Final mini-pass fixes:
 * - Fix #1: Removed subcontract exposure extrapolation. Uncovered exposure
 *   now comes from `uncoveredScopeValue` (the actual GHS value of uncovered
 *   required scope, computed by the reconciliation engine). If not provided,
 *   the exposure is 'unknown' (blocker) — NEVER extrapolated from quote/coverage.
 * - Fix #2: Subcontract segments carry `scopeDefinition` + `quoteCoversSegmentScope`
 *   so the engine can verify the quote covers the segment's specific scope.
 * - Fix #4: Percentages (overhead, profit, contingency) bounded to 0..1, not just >= 0.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client.
 */

import { round2 } from './money';

/** A single resource line in a WorkDefinitionVersion's cost recipe. */
export interface CostRecipeLine {
  resourceKind: 'material' | 'labour' | 'plant' | 'subcontract' | 'fee';
  resourceCode: string;
  resourceName: string;
  unit: string;
  quantityPerUnit: number;
  priceObservation: {
    price: number;
    provenance: string;
    sourceReference?: string;
    observedAt: string;
  } | null;
}

export interface PricingWorkDefinitionVersion {
  id: string;
  name: string;
  version: number;
  unit: string;
  wastage: number;
  productivityRule?: number;
  costRecipeJson: string;
}

/**
 * An explicit execution segment for hybrid strategy (P0-3 + Fix #2).
 * Fix #2: subcontract segments now carry `scopeDefinition` and
 * `quoteCoversSegmentScope` so the engine can verify the quote
 * actually covers the segment's required scope.
 */
export interface ExecutionSegmentInput {
  strategy: 'self-perform' | 'subcontract';
  quantityPct: number;
  /** Human-readable description of the scope this segment covers. */
  scopeDefinition?: string;
  /** Subcontract quote (required for subcontract segments). */
  subcontractQuote?: SubcontractQuotePricingInput | null;
  /**
   * Fix #2: Whether the subcontract quote explicitly covers this segment's
   * required scope. If false or undefined, the segment is incomplete.
   */
  quoteCoversSegmentScope?: boolean;
  /**
   * The commercial basis for how the quote amount maps to this segment's cost.
   *
   * - 'direct-segment-quote': the quote totalAmount IS the cost for this segment.
   *   Do NOT multiply by quantityPct. Use this when the subcontractor quoted
   *   specifically for the work in this segment (e.g. "west wing installation").
   *
   * - 'proportional-from-package': the quote covers a larger package and this
   *   segment takes a proportional share. cost = totalAmount × quantityPct.
   *   Use this when the quote covers the full scope and quantityPct represents
   *   the portion being subcontracted.
   *
   * If undefined → blocker ('missing-pricing-basis'). The engine never guesses.
   */
  pricingBasis?: 'direct-segment-quote' | 'proportional-from-package';
}

/**
 * Subcontract quote input for pricing.
 * Fix #1: `uncoveredScopeValue` is the actual GHS value of the uncovered
 * required scope (from the reconciliation engine). If not provided and
 * coverage < 100%, the exposure is 'unknown' (blocker, never extrapolated).
 */
export interface SubcontractQuotePricingInput {
  totalAmount: number;
  coveragePct: number;
  /**
   * Fix #1: The actual GHS value of the uncovered required scope.
   * Computed by the reconciliation engine from uncovered scope atoms.
   * If coveragePct < 1 and this is not provided, exposure is 'unknown'.
   */
  uncoveredScopeValue?: number;
}

export interface PricingInput {
  workDefinitionVersion: PricingWorkDefinitionVersion | null;
  quantity: number;
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided';
  executionSegments?: ExecutionSegmentInput[];
  overheadPct: number;
  profitPct: number;
  contingencyPct: number;
  subcontractQuote?: SubcontractQuotePricingInput | null;
}

export interface PricingProvenanceEntry {
  resourceCode: string;
  resourceName: string;
  price: number;
  provenance: string;
  sourceReference?: string;
  observedAt: string;
}

export interface BlockingInput {
  kind: 'missing-price' | 'missing-hybrid-allocation' | 'missing-work-definition' | 'invalid-recipe' | 'missing-subcontract-quote' | 'invalid-price-observation' | 'invalid-quantity' | 'invalid-wastage' | 'invalid-percentage' | 'invalid-hybrid-segment' | 'partial-subcontract-coverage' | 'hybrid-missing-strategy' | 'uncovered-exposure-unknown' | 'segment-scope-not-covered' | 'missing-pricing-basis';
  resourceName?: string;
  resourceCode?: string;
  detail: string;
}

export type CalculationStatus = 'complete' | 'incomplete';

export interface PricingBreakdown {
  calculationStatus: CalculationStatus;
  blockingInputs: BlockingInput[];
  material: number;
  labour: number;
  plant: number;
  subcontract: number;
  uncoveredSubcontractExposure: number;
  /** True when exposure couldn't be determined (no uncoveredScopeValue provided). */
  exposureUnknown: boolean;
  directCost: number;
  projectCost: number;
  riskCost: number;
  overhead: number;
  profit: number;
  estimatedTotalCost: number;
  expectedProfit: number;
  sellPrice: number;
  unitRate: number;
  expectedMarginPct: number;
  marginPct: number;
  provenance: PricingProvenanceEntry[];
  unsourced: boolean;
  unsourcedResources: string[];
}

function emptyBreakdown(
  unsourced: boolean,
  blockingInputs: BlockingInput[] = [],
): PricingBreakdown {
  return {
    calculationStatus: 'incomplete',
    blockingInputs,
    material: 0,
    labour: 0,
    plant: 0,
    subcontract: 0,
    uncoveredSubcontractExposure: 0,
    exposureUnknown: false,
    directCost: 0,
    projectCost: 0,
    riskCost: 0,
    overhead: 0,
    profit: 0,
    estimatedTotalCost: 0,
    expectedProfit: 0,
    sellPrice: 0,
    unitRate: 0,
    expectedMarginPct: 0,
    marginPct: 0,
    provenance: [],
    unsourced,
    unsourcedResources: [],
  };
}

/** P0-2: Validate a numeric financial value. Returns true if safe and non-negative. */
function isValidPrice(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** P0-2: Validate a non-negative finite quantity. */
function isValidQuantity(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Fix #4: Validate a commercial percentage — must be 0..1 (not just >= 0).
 * A value of 4.0 (400%) is almost certainly a data error in a 0..1 model.
 */
function isValidPct(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** P0-2: Validate wastage (allow 0..1, reject negative or > 1 or non-finite). */
function isValidWastage(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** P0-2: Validate a hybrid segment quantityPct (0..1). */
function isValidSegmentPct(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Handle partial subcontract coverage — Fix #1: no extrapolation.
 * Returns the uncovered exposure if determinable, or marks it unknown.
 */
function handlePartialCoverage(
  quote: SubcontractQuotePricingInput,
  blockingInputs: BlockingInput[],
  context: string,
): { exposure: number; unknown: boolean } {
  if (quote.uncoveredScopeValue !== undefined && isValidPrice(quote.uncoveredScopeValue)) {
    // Fix #1: Use the actual uncovered scope value from the reconciliation engine.
    const exposure = round2(quote.uncoveredScopeValue);
    blockingInputs.push({
      kind: 'partial-subcontract-coverage',
      detail: `${context} covers only ${(quote.coveragePct * 100).toFixed(0)}% of the required scope. Uncovered exposure: GHS ${exposure.toFixed(2)} (from uncovered scope atoms). The uncovered scope must be assigned an execution strategy.`,
    });
    return { exposure, unknown: false };
  }
  // Fix #1: No uncoveredScopeValue provided — exposure is UNKNOWN, not extrapolated.
  blockingInputs.push({
    kind: 'uncovered-exposure-unknown',
    detail: `${context} covers only ${(quote.coveragePct * 100).toFixed(0)}% of the required scope, but the uncovered scope value was not provided. Cannot extrapolate exposure from the quote amount — provide the actual uncovered scope value from the reconciliation engine.`,
  });
  return { exposure: 0, unknown: true };
}

export function priceLine(input: PricingInput): PricingBreakdown {
  const {
    workDefinitionVersion,
    quantity,
    executionStrategy,
    executionSegments,
    overheadPct,
    profitPct,
    contingencyPct,
    subcontractQuote,
  } = input;

  if (!workDefinitionVersion) {
    return emptyBreakdown(true, [
      { kind: 'missing-work-definition', detail: 'No Work Definition Version linked to this estimate line.' },
    ]);
  }

  const blockingInputs: BlockingInput[] = [];

  if (!isValidQuantity(quantity)) {
    blockingInputs.push({ kind: 'invalid-quantity', detail: `Quantity "${quantity}" is invalid (negative, NaN, or non-finite).` });
  }
  if (!isValidWastage(workDefinitionVersion.wastage)) {
    blockingInputs.push({ kind: 'invalid-wastage', detail: `Wastage "${workDefinitionVersion.wastage}" is invalid (must be 0..1).` });
  }
  // Fix #4: Percentages must be 0..1, not just >= 0.
  if (!isValidPct(overheadPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Overhead percentage "${overheadPct}" is invalid (must be 0..1, got ${overheadPct}).` });
  }
  if (!isValidPct(profitPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Profit percentage "${profitPct}" is invalid (must be 0..1, got ${profitPct}).` });
  }
  if (!isValidPct(contingencyPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Contingency percentage "${contingencyPct}" is invalid (must be 0..1, got ${contingencyPct}).` });
  }

  // Parse recipe defensively.
  let recipe: CostRecipeLine[] = [];
  try {
    const parsed: unknown = JSON.parse(workDefinitionVersion.costRecipeJson);
    if (Array.isArray(parsed)) {
      recipe = parsed as CostRecipeLine[];
    } else {
      return emptyBreakdown(true, [
        ...blockingInputs,
        { kind: 'invalid-recipe', detail: 'Cost recipe JSON is not an array.' },
      ]);
    }
  } catch {
    return emptyBreakdown(true, [
      ...blockingInputs,
      { kind: 'invalid-recipe', detail: 'Cost recipe JSON is invalid.' },
    ]);
  }

  const wastage = isValidWastage(workDefinitionVersion.wastage) ? workDefinitionVersion.wastage : 0;
  const qty = isValidQuantity(quantity) ? quantity : 0;

  const unsourcedResources: string[] = [];
  const provenance: PricingProvenanceEntry[] = [];
  let material = 0;
  let labour = 0;
  let plant = 0;
  let subcontractFromRecipe = 0;

  for (const line of recipe) {
    if (!line || typeof line !== 'object') continue;
    const kind = line.resourceKind;
    const knownKind =
      kind === 'material' ||
      kind === 'labour' ||
      kind === 'plant' ||
      kind === 'subcontract' ||
      kind === 'fee';
    if (!knownKind) continue;

    const label = line.resourceName || line.resourceCode || 'unknown resource';

    if (!line.priceObservation) {
      if (!unsourcedResources.includes(label)) unsourcedResources.push(label);
      blockingInputs.push({
        kind: 'missing-price',
        resourceName: line.resourceName,
        resourceCode: line.resourceCode,
        detail: `Resource "${label}" (${kind}) has no price observation.`,
      });
      continue;
    }

    if (!isValidPrice(line.priceObservation.price)) {
      if (!unsourcedResources.includes(label)) unsourcedResources.push(label);
      blockingInputs.push({
        kind: 'invalid-price-observation',
        resourceName: line.resourceName,
        resourceCode: line.resourceCode,
        detail: `Resource "${label}" (${kind}) has an invalid price: "${line.priceObservation.price}" (NaN, Infinity, or negative).`,
      });
      continue;
    }

    if (!isValidQuantity(line.quantityPerUnit)) {
      if (!unsourcedResources.includes(label)) unsourcedResources.push(label);
      blockingInputs.push({
        kind: 'invalid-quantity',
        resourceName: line.resourceName,
        resourceCode: line.resourceCode,
        detail: `Resource "${label}" (${kind}) has an invalid quantityPerUnit: "${line.quantityPerUnit}".`,
      });
      continue;
    }

    const price = line.priceObservation.price;
    const qpu = line.quantityPerUnit;
    const lineCost = round2(qpu * qty * (1 + wastage) * price);

    switch (kind) {
      case 'material': material += lineCost; break;
      case 'labour': labour += lineCost; break;
      case 'plant': plant += lineCost; break;
      case 'subcontract': subcontractFromRecipe += lineCost; break;
      case 'fee': break;
    }

    provenance.push({
      resourceCode: line.resourceCode,
      resourceName: line.resourceName,
      price,
      provenance: line.priceObservation.provenance,
      sourceReference: line.priceObservation.sourceReference,
      observedAt: line.priceObservation.observedAt,
    });
  }

  const unsourced = unsourcedResources.length > 0;

  // ── Execution strategy ────────────────────────────────────────────────────
  let subcontractCost = subcontractFromRecipe;
  let uncoveredSubcontractExposure = 0;
  let exposureUnknown = false;

  if (executionStrategy === 'subcontract') {
    if (!subcontractQuote) {
      blockingInputs.push({
        kind: 'missing-subcontract-quote',
        detail: 'Execution strategy is "subcontract" but no subcontract quote is provided.',
      });
    } else {
      if (!isValidPrice(subcontractQuote.totalAmount)) {
        blockingInputs.push({
          kind: 'invalid-price-observation',
          detail: `Subcontract quote totalAmount "${subcontractQuote.totalAmount}" is invalid.`,
        });
      } else if (subcontractQuote.coveragePct < 1) {
        // Fix #1: No extrapolation — use uncoveredScopeValue or mark unknown.
        const result = handlePartialCoverage(subcontractQuote, blockingInputs, 'Subcontract quote');
        uncoveredSubcontractExposure = result.exposure;
        exposureUnknown = result.unknown;
        material = 0;
        labour = 0;
        plant = 0;
        subcontractCost = subcontractQuote.totalAmount;
      } else {
        material = 0;
        labour = 0;
        plant = 0;
        subcontractCost = subcontractQuote.totalAmount;
      }
    }
  } else if (executionStrategy === 'hybrid') {
    const segments = executionSegments ?? [];

    if (segments.length === 0) {
      blockingInputs.push({
        kind: 'missing-hybrid-allocation',
        detail: 'Execution strategy is "hybrid" but no execution segments are defined. Explicit allocation required.',
      });
    } else {
      let hasSelfPerform = false;
      let hasSubcontract = false;
      let totalPct = 0;
      const segmentErrors: BlockingInput[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!isValidSegmentPct(seg.quantityPct)) {
          segmentErrors.push({
            kind: 'invalid-hybrid-segment',
            detail: `Segment ${i + 1} has invalid quantityPct "${seg.quantityPct}" (must be 0..1).`,
          });
          continue;
        }
        totalPct += seg.quantityPct;

        if (seg.strategy === 'self-perform') {
          hasSelfPerform = true;
        } else if (seg.strategy === 'subcontract') {
          hasSubcontract = true;
          if (!seg.subcontractQuote) {
            segmentErrors.push({
              kind: 'missing-subcontract-quote',
              detail: `Hybrid subcontract segment ${i + 1} (${(seg.quantityPct * 100).toFixed(0)}%) has no subcontract quote.`,
            });
          } else if (!isValidPrice(seg.subcontractQuote.totalAmount)) {
            segmentErrors.push({
              kind: 'invalid-price-observation',
              detail: `Hybrid subcontract segment ${i + 1} has an invalid quote totalAmount.`,
            });
          } else if (seg.subcontractQuote.coveragePct < 1) {
            // Fix #1: No extrapolation for hybrid segments either.
            const segResult = handlePartialCoverage(
              seg.subcontractQuote,
              segmentErrors,
              `Hybrid subcontract segment ${i + 1}`,
            );
            uncoveredSubcontractExposure = round2(uncoveredSubcontractExposure + segResult.exposure);
            if (segResult.unknown) exposureUnknown = true;
          }
          // Fix #2: Verify the quote covers this segment's specific scope.
          if (seg.subcontractQuote && seg.quoteCoversSegmentScope !== true) {
            segmentErrors.push({
              kind: 'segment-scope-not-covered',
              detail: `Hybrid subcontract segment ${i + 1} quote has not been verified to cover the segment's required scope${seg.scopeDefinition ? ` ("${seg.scopeDefinition}")` : ''}. Explicitly confirm quoteCoversSegmentScope=true after reconciling the quote against the segment's scope atoms.`,
            });
          }
          // Pricing basis: the engine must know whether the quote amount is
          // for this segment directly or for a larger package.
          if (seg.subcontractQuote && !seg.pricingBasis) {
            segmentErrors.push({
              kind: 'missing-pricing-basis',
              detail: `Hybrid subcontract segment ${i + 1} has no pricingBasis. Specify 'direct-segment-quote' (quote IS the segment cost) or 'proportional-from-package' (cost = quote × quantityPct).`,
            });
          }
        } else {
          segmentErrors.push({
            kind: 'invalid-hybrid-segment',
            detail: `Segment ${i + 1} has invalid strategy "${seg.strategy}" (must be self-perform or subcontract).`,
          });
        }
      }

      if (!hasSelfPerform) {
        segmentErrors.push({
          kind: 'hybrid-missing-strategy',
          detail: 'Hybrid allocation must contain at least one self-perform segment.',
        });
      }
      if (!hasSubcontract) {
        segmentErrors.push({
          kind: 'hybrid-missing-strategy',
          detail: 'Hybrid allocation must contain at least one subcontract segment.',
        });
      }

      if (Math.abs(totalPct - 1.0) > 0.01) {
        segmentErrors.push({
          kind: 'missing-hybrid-allocation',
          detail: `Hybrid execution segments sum to ${(totalPct * 100).toFixed(1)}%, not 100%.`,
        });
      }

      if (segmentErrors.length > 0) {
        blockingInputs.push(...segmentErrors);
      } else {
        let selfPerformMaterial = 0;
        let selfPerformLabour = 0;
        let selfPerformPlant = 0;
        let hybridSubcontract = 0;
        for (const seg of segments) {
          const pct = seg.quantityPct;
          if (seg.strategy === 'self-perform') {
            selfPerformMaterial += material * pct;
            selfPerformLabour += labour * pct;
            selfPerformPlant += plant * pct;
          } else if (seg.strategy === 'subcontract' && seg.subcontractQuote) {
            // Apply the explicit pricing basis — the engine never guesses.
            if (seg.pricingBasis === 'direct-segment-quote') {
              // The quote totalAmount IS the cost for this segment.
              hybridSubcontract += seg.subcontractQuote.totalAmount;
            } else if (seg.pricingBasis === 'proportional-from-package') {
              // The quote covers a larger package; take a proportional share.
              hybridSubcontract += seg.subcontractQuote.totalAmount * pct;
            }
            // If no pricingBasis, segmentErrors already has a blocker —
            // we won't reach here because segmentErrors.length > 0 above.
          }
        }
        material = round2(selfPerformMaterial);
        labour = round2(selfPerformLabour);
        plant = round2(selfPerformPlant);
        subcontractCost = round2(hybridSubcontract);
      }
    }
  }

  material = round2(material);
  labour = round2(labour);
  plant = round2(plant);
  subcontractCost = round2(subcontractCost);

  const directCost = round2(material + labour + plant + subcontractCost);
  const projectCost = directCost;
  const riskCost = round2(directCost * contingencyPct);
  const overhead = round2((projectCost + riskCost) * overheadPct);
  const estimatedTotalCost = round2(projectCost + riskCost + overhead);
  const profit = round2(estimatedTotalCost * profitPct);
  const sellPrice = round2(estimatedTotalCost + profit);
  const expectedProfit = round2(sellPrice - estimatedTotalCost);
  const unitRate = qty > 0 ? round2(sellPrice / qty) : 0;
  const expectedMarginPct = sellPrice > 0 ? round2(expectedProfit / sellPrice) : 0;
  const marginPct = sellPrice > 0 ? round2((sellPrice - directCost) / sellPrice) : 0;

  const calculationStatus: CalculationStatus =
    blockingInputs.length > 0 ? 'incomplete' : 'complete';

  return {
    calculationStatus,
    blockingInputs,
    material,
    labour,
    plant,
    subcontract: subcontractCost,
    uncoveredSubcontractExposure,
    exposureUnknown,
    directCost,
    projectCost,
    riskCost,
    overhead,
    profit,
    estimatedTotalCost,
    expectedProfit,
    sellPrice,
    unitRate,
    expectedMarginPct,
    marginPct,
    provenance,
    unsourced,
    unsourcedResources,
  };
}
