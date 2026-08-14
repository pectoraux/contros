/**
 * Pricing Engine — deterministic cost build-up for an EstimateLine.
 *
 * This is the canonical financial calculation layer (INVARIANT 6).
 * The LLM never performs financial arithmetic — it always delegates here.
 *
 * Pure: no `Math.random`, no `Date.now`, no I/O, no Prisma client. Callers
 * pass plain data (typically projected from Prisma models).
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
  /** Wastage factor (e.g. 0.05 = 5%). Applied to all recipe lines per spec. */
  wastage: number;
  /** Output per crew-day. Used by schedule engine and confidence, not directly by pricing. */
  productivityRule?: number;
  /** JSON string of `CostRecipeLine[]`. Invalid JSON is handled gracefully. */
  costRecipeJson: string;
}

/** Inputs to `priceLine`. */
export interface PricingInput {
  workDefinitionVersion: PricingWorkDefinitionVersion | null;
  quantity: number;
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided';
  /** 0.10 = 10%. */
  overheadPct: number;
  /** 0.12 = 12%. */
  profitPct: number;
  /** 0.05 = 5%. Contingency/risk. */
  contingencyPct: number;
  /** Subcontract quote (required if strategy is 'subcontract' to avoid unsourced). */
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

/** Full deterministic breakdown of a single estimate line's pricing. */
export interface PricingBreakdown {
  material: number;
  labour: number;
  plant: number;
  subcontract: number;
  directCost: number;
  projectCost: number;
  riskCost: number;
  overhead: number;
  profit: number;
  sellPrice: number;
  unitRate: number;
  marginPct: number;
  provenance: PricingProvenanceEntry[];
  /** True if any recipe line is missing a price observation, or no workDefinitionVersion. */
  unsourced: boolean;
  /** Human-readable names of unsourced resources. */
  unsourcedResources: string[];
}

/** Sentinel empty breakdown used for early-return paths. */
function emptyBreakdown(unsourced: boolean): PricingBreakdown {
  return {
    material: 0,
    labour: 0,
    plant: 0,
    subcontract: 0,
    directCost: 0,
    projectCost: 0,
    riskCost: 0,
    overhead: 0,
    profit: 0,
    sellPrice: 0,
    unitRate: 0,
    marginPct: 0,
    provenance: [],
    unsourced,
    unsourcedResources: [],
  };
}

/**
 * Compute a deterministic price breakdown for a single estimate line.
 *
 * Algorithm (per spec):
 * 1. Parse `costRecipeJson`. Invalid JSON → unsourced breakdown.
 * 2. For each recipe line: `lineCost = quantityPerUnit * quantity * (1 + wastage) * priceObservation.price`.
 *    Missing `priceObservation` → mark resource unsourced, lineCost = 0.
 * 3. Apply execution-strategy adjustment:
 *    - `self-perform` / `undecided`: use recipe as-is.
 *    - `subcontract` (with quote): subcontract = `quote.totalAmount`; material/labour/plant = 0.
 *    - `hybrid` (heuristic): subcontract = 50% of (material + labour + plant);
 *      material/labour/plant are halved. The quote, if provided, is ignored
 *      (documented assumption — the spec only describes the 50% heuristic).
 * 4. `directCost = material + labour + plant + subcontract`.
 * 5. `projectCost = directCost` (no separate project-specific layer for MVP).
 * 6. `riskCost = directCost * contingencyPct`.
 * 7. `overhead = (projectCost + riskCost) * overheadPct`.
 * 8. `profit = (projectCost + riskCost + overhead) * profitPct`.
 * 9. `sellPrice = projectCost + riskCost + overhead + profit`.
 * 10. `unitRate = sellPrice / quantity` (guard divide-by-zero).
 * 11. `marginPct = (sellPrice - projectCost) / sellPrice` (guard 0).
 *
 * Note: `unsourced` follows the literal spec — it is true if ANY recipe line
 * is missing a price observation, even when `subcontract` strategy with a
 * valid quote is used. This is conservative: the caller can acknowledge.
 *
 * @param input - The pricing inputs.
 * @returns A deterministic pricing breakdown.
 */
export function priceLine(input: PricingInput): PricingBreakdown {
  const {
    workDefinitionVersion,
    quantity,
    executionStrategy,
    overheadPct,
    profitPct,
    contingencyPct,
    subcontractQuote,
  } = input;

  if (!workDefinitionVersion) {
    return emptyBreakdown(true);
  }

  // Parse recipe defensively.
  let recipe: CostRecipeLine[] = [];
  try {
    const parsed: unknown = JSON.parse(workDefinitionVersion.costRecipeJson);
    if (Array.isArray(parsed)) {
      recipe = parsed as CostRecipeLine[];
    } else {
      return emptyBreakdown(true);
    }
  } catch {
    return emptyBreakdown(true);
  }

  const wastage = Number.isFinite(workDefinitionVersion.wastage)
    ? workDefinitionVersion.wastage
    : 0;
  const qty = Number.isFinite(quantity) ? quantity : 0;

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

    // Missing price observation → unsourced, line contributes 0.
    if (!line.priceObservation) {
      const label = line.resourceName || line.resourceCode || 'unknown resource';
      if (!unsourcedResources.includes(label)) {
        unsourcedResources.push(label);
      }
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
        // Fees are not part of direct cost for MVP; tracked only in provenance.
        break;
      // no default — `knownKind` guard above ensures exhaustiveness.
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

  // Strategy adjustments.
  let subcontractCost = subcontractFromRecipe;
  if (executionStrategy === 'subcontract' && subcontractQuote) {
    // Use the quote as the price; zero out self-perform buckets.
    // Note: unsourced flag is preserved per spec (conservative).
    material = 0;
    labour = 0;
    plant = 0;
    subcontractCost = subcontractQuote.totalAmount;
  } else if (executionStrategy === 'hybrid') {
    // Heuristic: 50% of equivalent self-perform cost is subcontracted.
    // The remaining 50% is retained in-house as material/labour/plant.
    // The quote (if any) is ignored under this heuristic — documented assumption.
    const selfPerformTotal = material + labour + plant;
    subcontractCost = subcontractFromRecipe + selfPerformTotal * 0.5;
    material = material * 0.5;
    labour = labour * 0.5;
    plant = plant * 0.5;
  }

  material = round2(material);
  labour = round2(labour);
  plant = round2(plant);
  subcontractCost = round2(subcontractCost);

  const directCost = round2(material + labour + plant + subcontractCost);
  const projectCost = directCost;
  const riskCost = round2(directCost * contingencyPct);
  const overhead = round2((projectCost + riskCost) * overheadPct);
  const profit = round2((projectCost + riskCost + overhead) * profitPct);
  const sellPrice = round2(projectCost + riskCost + overhead + profit);
  const unitRate = qty > 0 ? round2(sellPrice / qty) : 0;
  const marginPct = sellPrice > 0 ? round2((sellPrice - projectCost) / sellPrice) : 0;

  return {
    material,
    labour,
    plant,
    subcontract: subcontractCost,
    directCost,
    projectCost,
    riskCost,
    overhead,
    profit,
    sellPrice,
    unitRate,
    marginPct,
    provenance,
    unsourced,
    unsourcedResources,
  };
}
