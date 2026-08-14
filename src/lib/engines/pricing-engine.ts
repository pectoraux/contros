/**
 * Pricing Engine — deterministic cost build-up for an EstimateLine.
 *
 * This is the canonical financial calculation layer (INVARIANT 6).
 * The LLM never performs financial arithmetic — it always delegates here.
 *
 * P0 fixes applied:
 * - P0-4: A missing price observation makes the calculation `incomplete` with
 *   `blockingInputs`. The engine does NOT silently contribute 0 for missing
 *   prices. An incomplete calculation cannot produce a commit-ready sellPrice.
 * - P0-5: The 50% hybrid heuristic is REMOVED. Hybrid requires explicit
 *   ExecutionSegments. Missing allocation → incomplete.
 * - P0-6: Margin semantics fixed. We now distinguish:
 *     directCost, projectCost, riskCost, overheadCost, estimatedTotalCost,
 *     expectedProfit, expectedMargin. `estimatedTotalCost` = direct + risk +
 *     overhead (excludes profit). `expectedMargin` = expectedProfit / sellPrice.
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
  /** Quantity per unit of work (e.g. 0.05 tonne of cement per m3 of concrete). */
  quantityPerUnit: number;
  /** Price observation backing this resource, or null if unsourced. */
  priceObservation: {
    price: number;
    provenance: string;
    sourceReference?: string;
    observedAt: string;
  } | null;
}

/** The work definition version driving this price build-up. */
export interface PricingWorkDefinitionVersion {
  id: string;
  name: string;
  version: number;
  unit: string;
  wastage: number;
  productivityRule?: number;
  costRecipeJson: string;
}

/** An explicit execution segment for hybrid strategy (P0-5). */
export interface ExecutionSegmentInput {
  strategy: 'self-perform' | 'subcontract';
  /** 0..1 share of the line's quantity allocated to this segment. */
  quantityPct: number;
  /** Subcontract quote total (only used when strategy === 'subcontract'). */
  subcontractQuote?: { totalAmount: number; coveragePct: number } | null;
}

/** Inputs to `priceLine`. */
export interface PricingInput {
  workDefinitionVersion: PricingWorkDefinitionVersion | null;
  quantity: number;
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided';
  /** Required for hybrid strategy. Ignored for other strategies. */
  executionSegments?: ExecutionSegmentInput[];
  /** 0.10 = 10%. */
  overheadPct: number;
  /** 0.12 = 12%. */
  profitPct: number;
  /** 0.05 = 5%. Contingency/risk. */
  contingencyPct: number;
  /** Subcontract quote (used for pure subcontract strategy). */
  subcontractQuote?: { totalAmount: number; coveragePct: number } | null;
}

/** A single provenance entry — the lineage of a price used in the build-up. */
export interface PricingProvenanceEntry {
  resourceCode: string;
  resourceName: string;
  price: number;
  provenance: string;
  sourceReference?: string;
  observedAt: string;
}

/** A blocking input that makes a calculation incomplete (P0-4). */
export interface BlockingInput {
  kind: 'missing-price' | 'missing-hybrid-allocation' | 'missing-work-definition' | 'invalid-recipe' | 'missing-subcontract-quote';
  resourceName?: string;
  resourceCode?: string;
  detail: string;
}

/**
 * Calculation status (P0-4):
 * - 'complete': all inputs present, sellPrice is commit-ready.
 * - 'incomplete': one or more blocking inputs; sellPrice is provisional only.
 */
export type CalculationStatus = 'complete' | 'incomplete';

/** Full deterministic breakdown of a single estimate line's pricing. */
export interface PricingBreakdown {
  calculationStatus: CalculationStatus;
  blockingInputs: BlockingInput[];
  material: number;
  labour: number;
  plant: number;
  subcontract: number;
  directCost: number;
  projectCost: number;
  riskCost: number;
  overhead: number;
  profit: number;
  /** P0-6: estimatedTotalCost = direct + risk + overhead (excludes profit). */
  estimatedTotalCost: number;
  /** P0-6: expectedProfit = sellPrice - estimatedTotalCost. */
  expectedProfit: number;
  sellPrice: number;
  unitRate: number;
  /** P0-6: expectedMargin = expectedProfit / sellPrice (the real margin). */
  expectedMarginPct: number;
  /** Legacy margin = (sellPrice - directCost) / sellPrice — kept for UI compat but NOT the real margin. */
  marginPct: number;
  provenance: PricingProvenanceEntry[];
  /** True if any recipe line is missing a price observation, or no workDefinitionVersion. */
  unsourced: boolean;
  /** Human-readable names of unsourced resources. */
  unsourcedResources: string[];
}

/** Sentinel empty breakdown used for early-return paths. */
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

/**
 * Compute a deterministic price breakdown for a single estimate line.
 *
 * Algorithm:
 * 1. If no workDefinitionVersion → incomplete (blocking: missing-work-definition).
 * 2. Parse `costRecipeJson`. Invalid → incomplete (blocking: invalid-recipe).
 * 3. For each recipe line: if `priceObservation` is missing → record a
 *    `missing-price` blocking input. The line does NOT contribute 0 silently —
 *    the calculation is marked incomplete (P0-4 fix).
 *    If priced: `lineCost = quantityPerUnit * quantity * (1 + wastage) * price`.
 * 4. Execution strategy (P0-5 fix):
 *    - `self-perform` / `undecided`: use recipe as-is.
 *    - `subcontract`: requires `subcontractQuote`. If missing → incomplete.
 *      If present: subcontract = quote.totalAmount; self-perform buckets = 0.
 *    - `hybrid`: requires `executionSegments` summing to 1.0. If missing or
 *      not summing to 1.0 → incomplete (blocking: missing-hybrid-allocation).
 *      Each segment contributes its share of self-perform cost OR its
 *      subcontract quote proportional to quantityPct.
 *      NO 50% HEURISTIC.
 * 5. directCost = material + labour + plant + subcontract.
 * 6. projectCost = directCost (no separate project-specific layer for MVP).
 * 7. riskCost = directCost * contingencyPct.
 * 8. overhead = (projectCost + riskCost) * overheadPct.
 * 9. estimatedTotalCost = projectCost + riskCost + overhead (P0-6 — excludes profit).
 * 10. profit = estimatedTotalCost * profitPct.
 * 11. sellPrice = estimatedTotalCost + profit.
 * 12. expectedProfit = sellPrice - estimatedTotalCost (P0-6).
 * 13. expectedMarginPct = expectedProfit / sellPrice (P0-6 — the real margin).
 * 14. unitRate = sellPrice / quantity (guard 0).
 * 15. marginPct (legacy) = (sellPrice - directCost) / sellPrice — for UI compat.
 *
 * If calculationStatus === 'incomplete', the returned sellPrice is provisional
 * (computed from whatever inputs ARE available) but must NOT be committed to a
 * finalized estimate. The pre-submission gate treats incomplete as a blocker.
 */
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

  // Parse recipe defensively.
  let recipe: CostRecipeLine[] = [];
  try {
    const parsed: unknown = JSON.parse(workDefinitionVersion.costRecipeJson);
    if (Array.isArray(parsed)) {
      recipe = parsed as CostRecipeLine[];
    } else {
      return emptyBreakdown(true, [
        { kind: 'invalid-recipe', detail: 'Cost recipe JSON is not an array.' },
      ]);
    }
  } catch {
    return emptyBreakdown(true, [
      { kind: 'invalid-recipe', detail: 'Cost recipe JSON is invalid.' },
    ]);
  }

  const wastage = Number.isFinite(workDefinitionVersion.wastage)
    ? workDefinitionVersion.wastage
    : 0;
  const qty = Number.isFinite(quantity) ? quantity : 0;

  const blockingInputs: BlockingInput[] = [];
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

    // P0-4: missing price observation → blocking input, NOT silent zero.
    if (!line.priceObservation) {
      const label = line.resourceName || line.resourceCode || 'unknown resource';
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

    const price = Number.isFinite(line.priceObservation.price)
      ? line.priceObservation.price
      : 0;
    const qpu = Number.isFinite(line.quantityPerUnit)
      ? line.quantityPerUnit
      : 0;

    const lineCost = round2(qpu * qty * (1 + wastage) * price);

    switch (kind) {
      case 'material':
        material += lineCost;
        break;
      case 'labour':
        labour += lineCost;
        break;
      case 'plant':
        plant += lineCost;
        break;
      case 'subcontract':
        subcontractFromRecipe += lineCost;
        break;
      case 'fee':
        break;
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

  // ── Execution strategy (P0-5 fix: NO 50% heuristic) ──────────────────────
  let subcontractCost = subcontractFromRecipe;

  if (executionStrategy === 'subcontract') {
    if (!subcontractQuote) {
      blockingInputs.push({
        kind: 'missing-subcontract-quote',
        detail: 'Execution strategy is "subcontract" but no subcontract quote is provided.',
      });
    } else {
      // Use the quote as the price; zero out self-perform buckets.
      material = 0;
      labour = 0;
      plant = 0;
      subcontractCost = subcontractQuote.totalAmount;
    }
  } else if (executionStrategy === 'hybrid') {
    // P0-5: hybrid requires explicit execution segments. NO heuristic.
    const segments = executionSegments ?? [];
    if (segments.length === 0) {
      blockingInputs.push({
        kind: 'missing-hybrid-allocation',
        detail: 'Execution strategy is "hybrid" but no execution segments are defined. Explicit allocation required (no 50% heuristic).',
      });
    } else {
      const totalPct = segments.reduce((s, seg) => s + (Number.isFinite(seg.quantityPct) ? seg.quantityPct : 0), 0);
      // Segments must sum to ~1.0 (within 0.01 tolerance).
      if (Math.abs(totalPct - 1.0) > 0.01) {
        blockingInputs.push({
          kind: 'missing-hybrid-allocation',
          detail: `Hybrid execution segments sum to ${(totalPct * 100).toFixed(1)}%, not 100%. Explicit allocation required.`,
        });
      } else {
        // Apply each segment: self-perform segments scale the recipe cost;
        // subcontract segments use their quote proportional to quantityPct.
        let selfPerformMaterial = 0;
        let selfPerformLabour = 0;
        let selfPerformPlant = 0;
        let hybridSubcontract = 0;
        for (const seg of segments) {
          const pct = Number.isFinite(seg.quantityPct) ? seg.quantityPct : 0;
          if (seg.strategy === 'self-perform') {
            selfPerformMaterial += material * pct;
            selfPerformLabour += labour * pct;
            selfPerformPlant += plant * pct;
          } else if (seg.strategy === 'subcontract') {
            if (seg.subcontractQuote) {
              hybridSubcontract += seg.subcontractQuote.totalAmount * pct;
            } else {
              blockingInputs.push({
                kind: 'missing-subcontract-quote',
                detail: `Hybrid subcontract segment (${(pct * 100).toFixed(0)}%) has no subcontract quote.`,
              });
            }
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
  // P0-6: estimatedTotalCost excludes profit.
  const estimatedTotalCost = round2(projectCost + riskCost + overhead);
  const profit = round2(estimatedTotalCost * profitPct);
  const sellPrice = round2(estimatedTotalCost + profit);
  // P0-6: expectedProfit = sellPrice - estimatedTotalCost (which already excludes profit,
  // so expectedProfit === profit by construction, but we compute it explicitly for clarity).
  const expectedProfit = round2(sellPrice - estimatedTotalCost);
  const unitRate = qty > 0 ? round2(sellPrice / qty) : 0;
  // P0-6: the real margin is expectedProfit / sellPrice.
  const expectedMarginPct = sellPrice > 0 ? round2(expectedProfit / sellPrice) : 0;
  // Legacy margin (direct-cost spread) kept for UI backward-compat.
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
