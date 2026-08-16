/**
 * Historical Bid Validation Fixtures
 *
 * 10 fixture scenarios from the master prompt's matrix:
 *   3 straightforward bids
 *   3 subcontract-heavy bids
 *   2 ambiguous bids
 *   1 client-provided BOQ
 *   1 estimator-created scope
 *
 * Each fixture defines the minimum viable data to reconstruct a historical
 * bid from immutable domain state. The validation harness seeds this data,
 * runs the pricing engine + revision service, and asserts the reconstructed
 * commercial result matches the expected submitted price.
 *
 * The purpose is NOT to tune the system to reproduce one historical bid.
 * The fixtures expose defects in the domain model, pricing assumptions,
 * provenance, scope interpretation, and subcontract logic.
 *
 * INVARIANT 8: Submitted bids must remain reproducible from immutable revisions.
 */

import type { CostRecipeLine } from '../../src/lib/engines/pricing-engine'

// ─── Shared Types ───────────────────────────────────────────────────────────

export interface FixtureLine {
  description: string
  quantity: number
  unit: string
  workDefinitionCode: string
  workDefinitionName: string
  wastage: number
  productivityRule: number
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided'
  recipe: CostRecipeLine[]
  executionSegments?: {
    strategy: 'self-perform' | 'subcontract'
    quantityPct: number
    scopeDefinition?: string
    quoteCoversSegmentScope?: boolean
    pricingBasis?: 'direct-segment-quote' | 'proportional-from-package'
    subcontractQuote?: { totalAmount: number; coveragePct: number; uncoveredScopeValue?: number }
  }[]
  subcontractQuote?: { totalAmount: number; coveragePct: number; uncoveredScopeValue?: number }
}

export interface HistoricalBidFixture {
  id: string
  category: 'straightforward' | 'subcontract-heavy' | 'ambiguous' | 'client-boq' | 'estimator-scope'
  title: string
  clientName: string
  opportunityTitle: string
  description: string
  overheadPct: number
  profitPct: number
  contingencyPct: number
  directorAdjustment: number
  adjustmentRationale: string
  outcome: 'won' | 'lost' | 'withdrawn'
  expectedSystemSellPrice: number
  expectedFinalPrice: number
  shouldPassValidation: boolean
  lines: FixtureLine[]
  notes: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const mat = (code: string, name: string, unit: string, qpu: number, price: number, provenance = 'supplier-quote', ref?: string): CostRecipeLine => ({
  resourceKind: 'material', resourceCode: code, resourceName: name, unit,
  quantityPerUnit: qpu,
  priceObservation: { price, provenance, sourceReference: ref, observedAt: '2025-01-15' },
})

const lab = (code: string, name: string, unit: string, qpu: number, price: number, provenance = 'historical-bid', ref?: string): CostRecipeLine => ({
  resourceKind: 'labour', resourceCode: code, resourceName: name, unit,
  quantityPerUnit: qpu,
  priceObservation: { price, provenance, sourceReference: ref, observedAt: '2025-01-15' },
})

const plt = (code: string, name: string, unit: string, qpu: number, price: number, provenance = 'supplier-quote', ref?: string): CostRecipeLine => ({
  resourceKind: 'plant', resourceCode: code, resourceName: name, unit,
  quantityPerUnit: qpu,
  priceObservation: { price, provenance, sourceReference: ref, observedAt: '2025-01-15' },
})

const fee = (code: string, name: string, unit: string, qpu: number, price: number, provenance = 'manual', ref?: string): CostRecipeLine => ({
  resourceKind: 'fee', resourceCode: code, resourceName: name, unit,
  quantityPerUnit: qpu,
  priceObservation: { price, provenance, sourceReference: ref, observedAt: '2025-01-15' },
})

// ─── 10 Fixtures ────────────────────────────────────────────────────────────

export const HISTORICAL_BID_FIXTURES: HistoricalBidFixture[] = [

  // ═══ 3 STRAIGHTFORWARD ═══

  {
    id: 'hist-bid-1a', category: 'straightforward',
    title: 'Classroom Block — Single Storey',
    clientName: 'Accra Metropolitan Assembly',
    opportunityTitle: '6-Classroom Single Storey Block',
    description: 'Standard single-storey classroom block, 6 rooms. Straightforward self-perform masonry + roofing.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: '150mm Sandcrete Blockwork', quantity: 380, unit: 'm2', workDefinitionCode: 'WD-MSRY-001', workDefinitionName: 'Blockwork', wastage: 0.05, productivityRule: 12, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-BLOCK150', 'Hollow blocks 150mm', 'no', 12.5, 6.50, 'supplier-quote', 'BTP-183'),
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.035, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.083, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.167, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
      { description: 'Aluminium Roofing', quantity: 220, unit: 'm2', workDefinitionCode: 'WD-ROOF-003', workDefinitionName: 'Roofing', wastage: 0.07, productivityRule: 25, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-ALU-ROOF', 'Alu roofing 0.5mm', 'm2', 1.05, 58.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-RIDGE', 'Ridge cap', 'm', 0.15, 28.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-SCREW', 'Roofing screws', 'no', 8, 0.85, 'invoice', 'INV-1102'),
          lab('RES-LAB-ROOFER', 'Roofer', 'day', 0.04, 130.00, 'historical-bid', 'BID-2024-P031'),
        ] },
    ],
    notes: 'Simplest case: 2 self-perform lines, all prices sourced, no subcontract.',
  },

  {
    id: 'hist-bid-1b', category: 'straightforward',
    title: 'Plastering Contract — Community Centre',
    clientName: 'Presbyterian Church Ghana',
    opportunityTitle: 'Community Centre Internal Plastering',
    description: 'Internal plastering for a community centre. Single trade.',
    overheadPct: 0.10, profitPct: 0.10, contingencyPct: 0.05,
    directorAdjustment: -0.02, adjustmentRationale: '2% discount for repeat client.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: '15mm Internal Plastering', quantity: 500, unit: 'm2', workDefinitionCode: 'WD-FNSH-004', workDefinitionName: 'Plastering', wastage: 0.05, productivityRule: 15, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.02, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND-PLAST', 'Plaster sand', 'm3', 0.015, 70.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-PLASTER', 'Plasterer', 'day', 0.067, 130.00, 'historical-bid', 'BID-2024-P018'),
        ] },
    ],
    notes: 'Single-line bid with director adjustment.',
  },

  {
    id: 'hist-bid-1c', category: 'straightforward',
    title: 'Concrete Paving — Car Park',
    clientName: 'Zenith Properties Ltd',
    opportunityTitle: 'Office Car Park Paving',
    description: 'Interlocking concrete paving. Includes a fee (permit).',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: '100mm Interlocking Paving', quantity: 800, unit: 'm2', workDefinitionCode: 'WD-EXTW-007', workDefinitionName: 'Paving', wastage: 0.05, productivityRule: 20, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-PAVER', 'Pavers 100mm', 'm2', 1.05, 75.00, 'supplier-quote', 'PAV-308'),
          mat('RES-MAT-SAND-BED', 'Bedding sand', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          mat('RES-MAT-CEM425', 'Cement', 'ton', 0.005, 95.00, 'invoice', 'INV-982'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.05, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.1, 70.00, 'manual', 'Labour-Policy-v7'),
          fee('RES-FEE-PERMIT', 'Building permit', 'nr', 0.001, 2500.00, 'manual', 'Permit-2025'),
        ] },
    ],
    notes: 'Tests fee handling — permit fee in directCost + provenance.',
  },

  // ═══ 3 SUBCONTRACT-HEAVY ═══

  {
    id: 'hist-bid-2a', category: 'subcontract-heavy',
    title: 'Electrical First Fix — Subcontracted',
    clientName: 'University of Ghana Estates',
    opportunityTitle: 'Lecture Hall Electrical First Fix',
    description: 'Full subcontract for electrical first fix. 100% coverage.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: 'Electrical Conduiting — Subcontracted', quantity: 500, unit: 'm', workDefinitionCode: 'WD-ELEC-005', workDefinitionName: 'Electrical First Fix', wastage: 0.10, productivityRule: 40, executionStrategy: 'subcontract',
        subcontractQuote: { totalAmount: 18000, coveragePct: 1.0 },
        recipe: [
          mat('RES-MAT-CONDUIT', 'PVC conduit 20mm', 'm', 1.1, 4.50, 'supplier-quote', 'ELEC-719'),
          mat('RES-MAT-ELEC-ACC', 'Electrical accessories', 'no', 2, 8.00, 'invoice', 'INV-1090'),
          lab('RES-LAB-ELEC', 'Electrician', 'day', 0.025, 140.00, 'historical-bid', 'BID-2024-P027'),
        ] },
    ],
    notes: 'Pure subcontract — recipe costs zeroed, quote replaces.',
  },

  {
    id: 'hist-bid-2b', category: 'subcontract-heavy',
    title: 'Plumbing — Partial Coverage (80%)',
    clientName: 'Accra Metropolitan Assembly',
    opportunityTitle: 'Public Toilet Block Plumbing',
    description: 'Subcontract with 80% coverage — 20% uncovered scope.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'lost', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: false,
    lines: [
      { description: 'uPVC Soil & Waste Pipe — Subcontracted', quantity: 120, unit: 'm', workDefinitionCode: 'WD-PLMB-006', workDefinitionName: 'Plumbing', wastage: 0.05, productivityRule: 20, executionStrategy: 'subcontract',
        subcontractQuote: { totalAmount: 12000, coveragePct: 0.80, uncoveredScopeValue: 3000 },
        recipe: [
          mat('RES-MAT-UPVC110', 'uPVC pipe 110mm', 'm', 1.05, 32.00, 'supplier-quote', 'PLMB-441'),
          mat('RES-MAT-UPVC-FIT', 'uPVC fittings', 'no', 1.5, 12.00, 'invoice', 'INV-1088'),
          lab('RES-LAB-PLUMB', 'Plumber', 'day', 0.05, 140.00, 'historical-bid', 'BID-2024-P027'),
        ] },
    ],
    notes: 'Partial coverage (80%) with uncoveredScopeValue. Tests incomplete status blocking validation.',
  },

  {
    id: 'hist-bid-2c', category: 'subcontract-heavy',
    title: 'Hybrid Blockwork — 70% Self + 30% Subcontract',
    clientName: 'Zenith Properties Ltd',
    opportunityTitle: 'Office Complex Blockwork (Hybrid)',
    description: 'Hybrid: 70% self-perform, 30% subcontracted.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: -0.03, adjustmentRationale: '3% discount for competitive positioning.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: '150mm Blockwork — Hybrid', quantity: 500, unit: 'm2', workDefinitionCode: 'WD-MSRY-001', workDefinitionName: 'Blockwork', wastage: 0.05, productivityRule: 12, executionStrategy: 'hybrid',
        executionSegments: [
          { strategy: 'self-perform', quantityPct: 0.7 },
          { strategy: 'subcontract', quantityPct: 0.3, scopeDefinition: 'West wing blockwork', quoteCoversSegmentScope: true, pricingBasis: 'proportional-from-package', subcontractQuote: { totalAmount: 25000, coveragePct: 1.0 } },
        ],
        recipe: [
          mat('RES-MAT-BLOCK150', 'Hollow blocks 150mm', 'no', 12.5, 6.50, 'supplier-quote', 'BTP-183'),
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.035, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.083, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.167, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
    ],
    notes: 'Hybrid 70/30 with proportional-from-package. Tests double-count prevention.',
  },

  // ═══ 2 AMBIGUOUS ═══

  {
    id: 'hist-bid-3a', category: 'ambiguous',
    title: 'Refurbishment — Unsourced Electrician Rate',
    clientName: 'University of Ghana Estates',
    opportunityTitle: 'Lecture Hall Refurbishment',
    description: 'Unsourced electrician rate → incomplete calculation.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'lost', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: false,
    lines: [
      { description: 'Plastering', quantity: 300, unit: 'm2', workDefinitionCode: 'WD-FNSH-004', workDefinitionName: 'Plastering', wastage: 0.05, productivityRule: 15, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.02, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND-PLAST', 'Plaster sand', 'm3', 0.015, 70.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-PLASTER', 'Plasterer', 'day', 0.067, 130.00, 'historical-bid', 'BID-2024-P018'),
        ] },
      { description: 'Electrical First Fix — UNSOURCED', quantity: 200, unit: 'm', workDefinitionCode: 'WD-ELEC-005', workDefinitionName: 'Electrical', wastage: 0.10, productivityRule: 40, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-CONDUIT', 'PVC conduit 20mm', 'm', 1.1, 4.50, 'supplier-quote', 'ELEC-719'),
          mat('RES-MAT-ELEC-ACC', 'Electrical accessories', 'no', 2, 8.00, 'invoice', 'INV-1090'),
          { resourceKind: 'labour', resourceCode: 'RES-LAB-ELEC', resourceName: 'Electrician', unit: 'day', quantityPerUnit: 0.025, priceObservation: null },
        ] },
    ],
    notes: 'Unsourced electrician → incomplete. Tests service boundary zeroing.',
  },

  {
    id: 'hist-bid-3b', category: 'ambiguous',
    title: 'Mixed Works — Undecided Strategy',
    clientName: 'Presbyterian Church Ghana',
    opportunityTitle: 'Church Hall Mixed Works',
    description: 'Undecided execution strategy → incomplete.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: 0, adjustmentRationale: 'No adjustment.',
    outcome: 'lost', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: false,
    lines: [
      { description: 'Blockwork — UNDECIDED', quantity: 250, unit: 'm2', workDefinitionCode: 'WD-MSRY-001', workDefinitionName: 'Blockwork', wastage: 0.05, productivityRule: 12, executionStrategy: 'undecided',
        recipe: [
          mat('RES-MAT-BLOCK150', 'Hollow blocks 150mm', 'no', 12.5, 6.50, 'supplier-quote', 'BTP-183'),
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.035, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.083, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.167, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
    ],
    notes: 'Undecided strategy → incomplete. Tests engine blocker.',
  },

  // ═══ 1 CLIENT-PROVIDED BOQ ═══

  {
    id: 'hist-bid-4a', category: 'client-boq',
    title: 'Client-Provided BOQ — School Building',
    clientName: 'Accra Metropolitan Assembly',
    opportunityTitle: '6-Classroom Block (Client BOQ)',
    description: 'Client provided detailed BOQ. Estimator prices each item using WorkDefinitions.',
    overheadPct: 0.10, profitPct: 0.12, contingencyPct: 0.05,
    directorAdjustment: -0.01, adjustmentRationale: '1% goodwill discount.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: 'BOQ Item 1: Blockwork', quantity: 420, unit: 'm2', workDefinitionCode: 'WD-MSRY-001', workDefinitionName: 'Blockwork', wastage: 0.05, productivityRule: 12, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-BLOCK150', 'Hollow blocks 150mm', 'no', 12.5, 6.50, 'supplier-quote', 'BTP-183'),
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.035, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.083, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.167, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
      { description: 'BOQ Item 2: RC Slab', quantity: 45, unit: 'm3', workDefinitionCode: 'WD-STRC-002', workDefinitionName: 'RC Slab', wastage: 0.03, productivityRule: 4, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.35, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.5, 65.00, 'market-survey', 'MS-Q1'),
          mat('RES-MAT-AGG', 'Aggregates 3/4"', 'm3', 0.8, 110.00, 'supplier-quote', 'AST-211'),
          mat('RES-MAT-REBAR', 'Reinforcement steel', 'ton', 0.12, 7800.00, 'supplier-quote', 'SPL-1042'),
          mat('RES-MAT-FORM', 'Formwork', 'm2', 1.5, 35.00, 'historical-bid', 'BID-2024-P022'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.5, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 1.0, 70.00, 'manual', 'Labour-Policy-v7'),
          plt('RES-PLT-MIXER', 'Concrete mixer', 'day', 0.15, 850.00, 'supplier-quote', 'HIRE-2025-04'),
        ] },
      { description: 'BOQ Item 3: Roofing', quantity: 250, unit: 'm2', workDefinitionCode: 'WD-ROOF-003', workDefinitionName: 'Roofing', wastage: 0.07, productivityRule: 25, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-ALU-ROOF', 'Alu roofing 0.5mm', 'm2', 1.05, 58.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-RIDGE', 'Ridge cap', 'm', 0.15, 28.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-SCREW', 'Roofing screws', 'no', 8, 0.85, 'invoice', 'INV-1102'),
          lab('RES-LAB-ROOFER', 'Roofer', 'day', 0.04, 130.00, 'historical-bid', 'BID-2024-P031'),
        ] },
    ],
    notes: 'Client BOQ with 3 items. Tests Estimate (not BOQ) is canonical.',
  },

  // ═══ 1 ESTIMATOR-CREATED SCOPE ═══

  {
    id: 'hist-bid-5a', category: 'estimator-scope',
    title: 'Estimator-Created Scope — Bungalow Complex',
    clientName: 'Presbyterian Church Ghana',
    opportunityTitle: 'Staff Bungalows (4 Units)',
    description: 'Estimator created scope from drawings: 4 bungalow units.',
    overheadPct: 0.10, profitPct: 0.15, contingencyPct: 0.07,
    directorAdjustment: -0.05, adjustmentRationale: '5% discount to win first contract.',
    outcome: 'won', expectedSystemSellPrice: 0, expectedFinalPrice: 0,
    shouldPassValidation: true,
    lines: [
      { description: 'Blockwork (4 units)', quantity: 680, unit: 'm2', workDefinitionCode: 'WD-MSRY-001', workDefinitionName: 'Blockwork', wastage: 0.05, productivityRule: 12, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-BLOCK150', 'Hollow blocks 150mm', 'no', 12.5, 6.50, 'supplier-quote', 'BTP-183'),
          mat('RES-MAT-CEM425', 'Cement 42.5R', 'ton', 0.035, 95.00, 'invoice', 'INV-982'),
          mat('RES-MAT-SAND', 'Sand (sharp)', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.083, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.167, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
      { description: 'Roofing (4 units)', quantity: 440, unit: 'm2', workDefinitionCode: 'WD-ROOF-003', workDefinitionName: 'Roofing', wastage: 0.07, productivityRule: 25, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-ALU-ROOF', 'Alu roofing 0.5mm', 'm2', 1.05, 58.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-RIDGE', 'Ridge cap', 'm', 0.15, 28.00, 'supplier-quote', 'ALU-558'),
          mat('RES-MAT-SCREW', 'Roofing screws', 'no', 8, 0.85, 'invoice', 'INV-1102'),
          lab('RES-LAB-ROOFER', 'Roofer', 'day', 0.04, 130.00, 'historical-bid', 'BID-2024-P031'),
        ] },
      { description: 'Plumbing (4 units)', quantity: 200, unit: 'm', workDefinitionCode: 'WD-PLMB-006', workDefinitionName: 'Plumbing', wastage: 0.05, productivityRule: 20, executionStrategy: 'subcontract',
        subcontractQuote: { totalAmount: 22000, coveragePct: 1.0 },
        recipe: [
          mat('RES-MAT-UPVC110', 'uPVC pipe 110mm', 'm', 1.05, 32.00, 'supplier-quote', 'PLMB-441'),
          mat('RES-MAT-UPVC-FIT', 'uPVC fittings', 'no', 1.5, 12.00, 'invoice', 'INV-1088'),
          lab('RES-LAB-PLUMB', 'Plumber', 'day', 0.05, 140.00, 'historical-bid', 'BID-2024-P027'),
        ] },
      { description: 'Paving (4 units)', quantity: 300, unit: 'm2', workDefinitionCode: 'WD-EXTW-007', workDefinitionName: 'Paving', wastage: 0.05, productivityRule: 20, executionStrategy: 'self-perform',
        recipe: [
          mat('RES-MAT-PAVER', 'Pavers 100mm', 'm2', 1.05, 75.00, 'supplier-quote', 'PAV-308'),
          mat('RES-MAT-SAND-BED', 'Bedding sand', 'm3', 0.02, 65.00, 'market-survey', 'MS-Q1'),
          mat('RES-MAT-CEM425', 'Cement', 'ton', 0.005, 95.00, 'invoice', 'INV-982'),
          lab('RES-LAB-MASON', 'Mason', 'day', 0.05, 120.00, 'historical-bid', 'BID-2024-P018'),
          lab('RES-LAB-LABOUR', 'Labourer', 'day', 0.1, 70.00, 'manual', 'Labour-Policy-v7'),
        ] },
    ],
    notes: 'Estimator scope, 4 lines (2 self, 1 subcontract, 1 self). Mixed strategies + higher contingency.',
  },
]
