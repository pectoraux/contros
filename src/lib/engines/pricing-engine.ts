/**
 * Pricing Engine — deterministic cost build-up for an EstimateLine.
 *
 * This is the canonical financial calculation layer (INVARIANT 6).
 * The LLM never performs financial arithmetic — it always delegates here.
 *
 * Final integrity pass fixes:
 * - P0-2: Invalid price observations (NaN, Infinity, -Infinity, negative) are
 *   blocking inputs, NEVER silently coerced to zero. Invalid quantities,
 *   wastage, and percentages are also blocking inputs.
 * - P0-3: Hybrid validation hardened — segments must be 0..1, sum to 1.0,
 *   contain at least one self-perform AND one subcontract segment. Subcontract
 *   segments must reference a valid quote.
 * - P0-4: Subcontract pricing vs coverage — a partial quote (coveragePct < 1)
 *   is NOT silently treated as the full segment price. The uncovered scope
 *   exposure is surfaced as a blocking input.
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

/** An explicit execution segment for hybrid strategy (P0-3). */
export interface ExecutionSegmentInput {
  strategy: 'self-perform' | 'subcontract';
  quantityPct: number;
  /** Subcontract quote (required for subcontract segments). */
  subcontractQuote?: { totalAmount: number; coveragePct: number } | null;
}

export interface PricingInput {
  workDefinitionVersion: PricingWorkDefinitionVersion | null;
  quantity: number;
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided';
  executionSegments?: ExecutionSegmentInput[];
  overheadPct: number;
  profitPct: number;
  contingencyPct: number;
  subcontractQuote?: { totalAmount: number; coveragePct: number } | null;
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
  kind: 'missing-price' | 'missing-hybrid-allocation' | 'missing-work-definition' | 'invalid-recipe' | 'missing-subcontract-quote' | 'invalid-price-observation' | 'invalid-quantity' | 'invalid-wastage' | 'invalid-percentage' | 'invalid-hybrid-segment' | 'partial-subcontract-coverage' | 'hybrid-missing-strategy';
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
  /** P0-4: uncovered subcontract scope exposure (GHS at risk). */
  uncoveredSubcontractExposure: number;
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

/** P0-2: Validate a percentage (0..1 allowed, but not negative or non-finite). */
function isValidPct(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** P0-2: Validate wastage (allow 0..1, reject negative or > 1 or non-finite). */
function isValidWastage(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** P0-2: Validate a hybrid segment quantityPct (0..1). */
function isValidSegmentPct(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
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

  // P0-2: Validate top-level numeric inputs.
  const blockingInputs: BlockingInput[] = [];

  if (!isValidQuantity(quantity)) {
    blockingInputs.push({ kind: 'invalid-quantity', detail: `Quantity "${quantity}" is invalid (negative, NaN, or non-finite).` });
  }
  if (!isValidWastage(workDefinitionVersion.wastage)) {
    blockingInputs.push({ kind: 'invalid-wastage', detail: `Wastage "${workDefinitionVersion.wastage}" is invalid (must be 0..1).` });
  }
  if (!isValidPct(overheadPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Overhead percentage "${overheadPct}" is invalid (negative or non-finite).` });
  }
  if (!isValidPct(profitPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Profit percentage "${profitPct}" is invalid (negative or non-finite).` });
  }
  if (!isValidPct(contingencyPct)) {
    blockingInputs.push({ kind: 'invalid-percentage', detail: `Contingency percentage "${contingencyPct}" is invalid (negative or non-finite).` });
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

    // P0-2: Missing price observation → blocking input.
    if (!line.priceObservation) {
      if (!unsourcedResources.includes(label)) {
        unsourcedResources.push(label);
      }
      blockingInputs.push({
        kind: 'missing-price',
        resourceName: line.resourceName,
        resourceCode: line.resourceCode,
        detail: `Resource "${label}" (${kind}) has no price observation.`,
      });
      continue;
    }

    // P0-2: Invalid price (NaN, Infinity, negative) → blocking input, NOT zero.
    if (!isValidPrice(line.priceObservation.price)) {
      if (!unsourcedResources.includes(label)) {
        unsourcedResources.push(label);
      }
      blockingInputs.push({
        kind: 'invalid-price-observation',
        resourceName: line.resourceName,
        resourceCode: line.resourceCode,
        detail: `Resource "${label}" (${kind}) has an invalid price: "${line.priceObservation.price}" (NaN, Infinity, or negative).`,
      });
      continue;
    }

    // P0-2: Invalid quantityPerUnit → blocking input.
    if (!isValidQuantity(line.quantityPerUnit)) {
      if (!unsourcedResources.includes(label)) {
        unsourcedResources.push(label);
      }
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

  if (executionStrategy === 'subcontract') {
    if (!subcontractQuote) {
      blockingInputs.push({
        kind: 'missing-subcontract-quote',
        detail: 'Execution strategy is "subcontract" but no subcontract quote is provided.',
      });
    } else {
      // P0-4: Check coverage — a partial quote can't be the full price.
      if (!isValidPrice(subcontractQuote.totalAmount)) {
        blockingInputs.push({
          kind: 'invalid-price-observation',
          detail: `Subcontract quote totalAmount "${subcontractQuote.totalAmount}" is invalid.`,
        });
      } else if (subcontractQuote.coveragePct < 1) {
        // Partial coverage — the quote doesn't cover the full scope.
        // The quote amount is used as the covered cost, but the uncovered
        // exposure is surfaced as a blocking input.
        material = 0;
        labour = 0;
        plant = 0;
        subcontractCost = subcontractQuote.totalAmount;
        // Uncovered exposure = proportional value of uncovered scope.
        // We don't know the exact required value here, so we estimate from
        // the quote: if coverage is 40%, the full package ≈ quote / 0.4,
        // and uncovered ≈ full - quote.
        const estimatedFullValue = subcontractQuote.coveragePct > 0
          ? subcontractQuote.totalAmount / subcontractQuote.coveragePct
          : subcontractQuote.totalAmount;
        uncoveredSubcontractExposure = round2(estimatedFullValue - subcontractQuote.totalAmount);
        blockingInputs.push({
          kind: 'partial-subcontract-coverage',
          detail: `Subcontract quote covers only ${(subcontractQuote.coveragePct * 100).toFixed(0)}% of the required scope. Uncovered exposure: GHS ${uncoveredSubcontractExposure.toFixed(2)}. The uncovered scope must be assigned an execution strategy.`,
        });
      } else {
        // Full coverage — safe to use the quote as the price.
        material = 0;
        labour = 0;
        plant = 0;
        subcontractCost = subcontractQuote.totalAmount;
      }
    }
  } else if (executionStrategy === 'hybrid') {
    // P0-3: Hardened hybrid validation.
    const segments = executionSegments ?? [];

    if (segments.length === 0) {
      blockingInputs.push({
        kind: 'missing-hybrid-allocation',
        detail: 'Execution strategy is "hybrid" but no execution segments are defined. Explicit allocation required.',
      });
    } else {
      // Validate each segment.
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
            // P0-4: Partial coverage in a hybrid subcontract segment.
            const segExposure = round2(
              seg.subcontractQuote.totalAmount / Math.max(seg.subcontractQuote.coveragePct, 0.001) * (1 - seg.subcontractQuote.coveragePct) * seg.quantityPct,
            );
            uncoveredSubcontractExposure = round2(uncoveredSubcontractExposure + segExposure);
            segmentErrors.push({
              kind: 'partial-subcontract-coverage',
              detail: `Hybrid subcontract segment ${i + 1} quote covers only ${(seg.subcontractQuote.coveragePct * 100).toFixed(0)}% of its scope. Uncovered exposure: GHS ${segExposure.toFixed(2)}.`,
            });
          }
        } else {
          segmentErrors.push({
            kind: 'invalid-hybrid-segment',
            detail: `Segment ${i + 1} has invalid strategy "${seg.strategy}" (must be self-perform or subcontract).`,
          });
        }
      }

      // P0-3: Must have both strategies.
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

      // P0-3: Segments must sum to 1.0 (within 0.01 tolerance).
      if (Math.abs(totalPct - 1.0) > 0.01) {
        segmentErrors.push({
          kind: 'missing-hybrid-allocation',
          detail: `Hybrid execution segments sum to ${(totalPct * 100).toFixed(1)}%, not 100%.`,
        });
      }

      if (segmentErrors.length > 0) {
        blockingInputs.push(...segmentErrors);
      } else {
        // Apply valid segments.
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
            // P0-4: Use the quote amount scaled by quantityPct.
            // If coverage is partial, the uncovered exposure is already recorded.
            hybridSubcontract += seg.subcontractQuote.totalAmount * pct;
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
