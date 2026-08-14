/**
 * Contractor OS — Seed Script.
 *
 * Run with: `bun run scripts/seed.ts`
 *
 * Wipes all rows (dependency-safe order) and seeds a realistic Ghana
 * construction dataset for the "Adom Construction Ltd" organization.
 *
 * The seed exercises every engine in `src/lib/engines`:
 *  - `priceLine` for each EstimateLine
 *  - `computeConfidence` for each EstimateLine
 *  - `computeScopeCompleteness` for the demo opportunity's ScopePackage
 *  - `reconcileSubcontract` for each SubcontractQuote
 *
 * All entity IDs are fixed strings (e.g. `org-1`, `wd-msry-001-v1`) so that
 * re-running the script is stable and reproducible.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
config({ path: '/home/z/my-project/.env' });
import {
  priceLine,
  computeConfidence,
  computeScopeCompleteness,
  reconcileSubcontract,
  formatGHS,
  type CostRecipeLine,
  type PricingBreakdown,
} from '../src/lib/engines';

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);
const daysFromNow = (n: number): Date => new Date(Date.now() + n * DAY_MS);
const iso = (d: Date): string => d.toISOString();

const prisma = new PrismaClient();

/** A recipe line with its associated resource + price observation (for DB seeding). */
interface RecipeSeed {
  resourceCode: string;
  resourceName: string;
  unit: string;
  kind: 'material' | 'labour' | 'plant' | 'subcontract' | 'fee';
  quantityPerUnit: number;
  price: number;
  provenance: string;
  sourceReference?: string;
  observedAtDaysAgo: number;
  /** If true, the recipe line will have priceObservation=null (unsourced). */
  unsourced?: boolean;
  /** Region override for the Resource row. */
  region?: string;
}

/** A WorkDefinition seed with all required version fields + recipe. */
interface WdSeed {
  wdId: string;
  versionId: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  wastage: number;
  productivity: number;
  hazards: string[];
  controls: string[];
  qualityChecklist: string[];
  ppe: string;
  permits: string;
  subcontractability: 'yes' | 'no' | 'partial';
  methodStatementFragment: string;
  commonAssumptions: string;
  commonExclusions: string;
  recipe: RecipeSeed[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Definitions (construction-ghana industry pack)
// ─────────────────────────────────────────────────────────────────────────────

const WORK_DEFINITIONS: WdSeed[] = [
  // 1. Sandcrete Blockwork
  {
    wdId: 'wd-msry-001',
    versionId: 'wd-msry-001-v1',
    code: 'WD-MSRY-001',
    name: '150mm Sandcrete Blockwork in Cement Mortar (1:4)',
    category: 'masonry',
    unit: 'm2',
    wastage: 0.05,
    productivity: 12,
    hazards: [
      'Manual handling injury',
      'Wall collapse during construction',
      'Cuts from block handling',
    ],
    controls: [
      'Team lift blocks >20kg',
      'Prop walls >3m high',
      'Wear cut-resistant gloves',
    ],
    qualityChecklist: [
      'Courses level and plumb within ±5mm',
      'Perpends and bed joints filled solid',
      'Wall tied to columns at every course',
    ],
    ppe: 'Hard hat, safety boots, gloves, safety glasses',
    permits: 'None',
    subcontractability: 'yes',
    methodStatementFragment:
      'Set out blockwork to drawing grid lines. Lay first course level. Build up corners/leads. Fill perpends and bed joints solidly. Maintain plumb and line. Cure blockwork if specified.',
    commonAssumptions:
      'Blocks supplied by others unless noted. Mortar mix 1:4 cement:sand.',
    commonExclusions: 'Plastering, formwork, reinforcement.',
    recipe: [
      {
        resourceCode: 'RES-MAT-BLOCK150',
        resourceName: 'Hollow sandcrete blocks 150mm',
        unit: 'no',
        kind: 'material',
        quantityPerUnit: 12.5,
        price: 6.5,
        provenance: 'supplier-quote',
        sourceReference: 'BTP-Quote-183',
        observedAtDaysAgo: 30,
      },
      {
        resourceCode: 'RES-MAT-CEM425',
        resourceName: 'Cement (42.5R)',
        unit: 'ton',
        kind: 'material',
        quantityPerUnit: 0.035,
        price: 95.0,
        provenance: 'invoice',
        sourceReference: 'INV-982',
        observedAtDaysAgo: 14,
      },
      {
        resourceCode: 'RES-MAT-SAND',
        resourceName: 'Sand (sharp)',
        unit: 'm3',
        kind: 'material',
        quantityPerUnit: 0.09,
        price: 65.0,
        provenance: 'market-survey',
        sourceReference: 'MS-Q1-2025',
        observedAtDaysAgo: 60,
      },
      {
        resourceCode: 'RES-LAB-MASON',
        resourceName: 'Mason',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.083,
        price: 120.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P018',
        observedAtDaysAgo: 120,
      },
      {
        resourceCode: 'RES-LAB-LABOUR',
        resourceName: 'Labourer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.167,
        price: 70.0,
        provenance: 'manual',
        sourceReference: 'Labour-Policy-v7',
        observedAtDaysAgo: 90,
      },
    ],
  },
  // 2. Reinforced Concrete Slab
  {
    wdId: 'wd-strc-002',
    versionId: 'wd-strc-002-v1',
    code: 'WD-STRC-002',
    name: 'Reinforced Concrete Slab (250mm, in-situ)',
    category: 'structural',
    unit: 'm3',
    wastage: 0.03,
    productivity: 4,
    hazards: ['Formwork failure', 'Rebar impalement', 'Concrete pump strike'],
    controls: [
      'Inspect formwork before pour',
      'Provide rebar caps',
      'Exclusion zone around pump',
    ],
    qualityChecklist: [
      'Formwork inspected and signed off pre-pour',
      'Rebar cover checked (25mm)',
      'Slump test passed (75-125mm)',
      'Cube samples taken (3 per pour)',
    ],
    ppe: 'Hard hat, boots, hi-vis, gloves',
    permits: 'Hot work permit if welding',
    subcontractability: 'partial',
    methodStatementFragment:
      'Erect and brace formwork to drawing levels. Fix reinforcement with 25mm cover chairs. Cast concrete in lifts not exceeding 1.5m. Vibrate using mechanical poker. Finish surface with power float. Cure with hessian and water for 7 days.',
    commonAssumptions:
      'Concrete grade C25 unless noted. Formwork is proprietary system. Rebar fabrication off-site.',
    commonExclusions: 'Post-tensioning, waterproofing, finishes.',
    recipe: [
      {
        resourceCode: 'RES-MAT-CEM425',
        resourceName: 'Cement (42.5R)',
        unit: 'ton',
        kind: 'material',
        quantityPerUnit: 0.32,
        price: 95.0,
        provenance: 'invoice',
        sourceReference: 'INV-982',
        observedAtDaysAgo: 14,
      },
      {
        resourceCode: 'RES-MAT-SAND',
        resourceName: 'Sand (sharp)',
        unit: 'm3',
        kind: 'material',
        quantityPerUnit: 0.45,
        price: 65.0,
        provenance: 'market-survey',
        sourceReference: 'MS-Q1-2025',
        observedAtDaysAgo: 60,
      },
      {
        resourceCode: 'RES-MAT-AGG',
        resourceName: 'Coarse aggregates (3/4")',
        unit: 'm3',
        kind: 'material',
        quantityPerUnit: 0.7,
        price: 110.0,
        provenance: 'supplier-quote',
        sourceReference: 'AST-Quote-211',
        observedAtDaysAgo: 20,
      },
      {
        resourceCode: 'RES-MAT-REBAR',
        resourceName: 'Reinforcement steel (Y12/Y16)',
        unit: 'ton',
        kind: 'material',
        quantityPerUnit: 0.09,
        price: 7800.0,
        provenance: 'supplier-quote',
        sourceReference: 'SPL-Quote-1042',
        observedAtDaysAgo: 10,
      },
      {
        resourceCode: 'RES-MAT-FORM',
        resourceName: 'Formwork (plywood + props)',
        unit: 'm2',
        kind: 'material',
        quantityPerUnit: 2.5,
        price: 35.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P022',
        observedAtDaysAgo: 95,
      },
      {
        resourceCode: 'RES-LAB-MASON',
        resourceName: 'Mason (concreting)',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.4,
        price: 120.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P018',
        observedAtDaysAgo: 120,
      },
      {
        resourceCode: 'RES-LAB-LABOUR',
        resourceName: 'Labourer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.8,
        price: 70.0,
        provenance: 'manual',
        sourceReference: 'Labour-Policy-v7',
        observedAtDaysAgo: 90,
      },
      {
        resourceCode: 'RES-PLT-MIXER',
        resourceName: 'Concrete mixer/pump',
        unit: 'day',
        kind: 'plant',
        quantityPerUnit: 0.08,
        price: 850.0,
        provenance: 'supplier-quote',
        sourceReference: 'HIRE-Quote-2025-04',
        observedAtDaysAgo: 25,
      },
    ],
  },
  // 3. Aluminium Roofing
  {
    wdId: 'wd-roof-003',
    versionId: 'wd-roof-003-v1',
    code: 'WD-ROOF-003',
    name: 'Aluminium Roofing Sheets (0.5mm, corrugated)',
    category: 'roofing',
    unit: 'm2',
    wastage: 0.07,
    productivity: 25,
    hazards: ['Fall from height', 'Sharp edge cuts'],
    controls: ['Use harness on roof', 'Wear gloves'],
    qualityChecklist: [
      'Sheets lapped minimum 1.5 corrugations',
      'Fixings at every corrugation at eaves/ridge',
      'Ridge cappings sealed',
    ],
    ppe: 'Harness, hard hat, boots, gloves',
    permits: 'Working-at-height permit',
    subcontractability: 'yes',
    methodStatementFragment:
      'Erect edge protection and harness anchor points. Lay underlay. Fix aluminium sheets starting from eaves, lapping away from prevailing wind. Fix ridges, flashings, and barge boards. Seal all penetrations.',
    commonAssumptions:
      'Roof pitch 15° unless noted. Timber battens supplied by others.',
    commonExclusions: 'Insulation, ceiling, guttering (priced separately).',
    recipe: [
      {
        resourceCode: 'RES-MAT-ALU-ROOF',
        resourceName: 'Aluminium roofing sheets (0.5mm corrugated)',
        unit: 'm2',
        kind: 'material',
        quantityPerUnit: 1.07,
        price: 58.0,
        provenance: 'supplier-quote',
        sourceReference: 'ALU-Quote-558',
        observedAtDaysAgo: 18,
      },
      {
        resourceCode: 'RES-MAT-RIDGE',
        resourceName: 'Aluminium ridge cap',
        unit: 'm',
        kind: 'material',
        quantityPerUnit: 0.12,
        price: 28.0,
        provenance: 'supplier-quote',
        sourceReference: 'ALU-Quote-558',
        observedAtDaysAgo: 18,
      },
      {
        resourceCode: 'RES-MAT-SCREW',
        resourceName: 'Roofing screws with EPDM washer',
        unit: 'no',
        kind: 'material',
        quantityPerUnit: 8,
        price: 0.85,
        provenance: 'invoice',
        sourceReference: 'INV-1102',
        observedAtDaysAgo: 22,
      },
      {
        resourceCode: 'RES-LAB-ROOFER',
        resourceName: 'Roofer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.04,
        price: 130.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P031',
        observedAtDaysAgo: 110,
      },
    ],
  },
  // 4. Plastering
  {
    wdId: 'wd-fnsh-004',
    versionId: 'wd-fnsh-004-v1',
    code: 'WD-FNSH-004',
    name: 'Plastering (15mm internal, 1:4)',
    category: 'finishes',
    unit: 'm2',
    wastage: 0.05,
    productivity: 15,
    hazards: ['Eye irritation from cement dust', 'Falls from scaffolding'],
    controls: ['Wear safety glasses when mixing', 'Inspect scaffolding daily'],
    qualityChecklist: [
      'Surface plumb within ±3mm',
      'No hollow-sounding areas',
      'Cured for 3 days minimum',
    ],
    ppe: 'Hard hat, safety glasses, gloves, mask when mixing',
    permits: 'None',
    subcontractability: 'yes',
    methodStatementFragment:
      'Hack and clean substrate. Apply dash bond coat. Apply undercoat 9-12mm thick, scratch to key. Apply finishing coat 3-6mm. Plumb and level to tolerance. Cure with water spray.',
    commonAssumptions: 'Mortar mix 1:4 cement:sand. Substrate prepared by others.',
    commonExclusions: 'Painting, skirting, decorative moulds.',
    recipe: [
      {
        resourceCode: 'RES-MAT-CEM425',
        resourceName: 'Cement (42.5R)',
        unit: 'ton',
        kind: 'material',
        quantityPerUnit: 0.0095,
        price: 95.0,
        provenance: 'invoice',
        sourceReference: 'INV-982',
        observedAtDaysAgo: 14,
      },
      {
        resourceCode: 'RES-MAT-SAND-PLAST',
        resourceName: 'Plaster sand (fine)',
        unit: 'm3',
        kind: 'material',
        quantityPerUnit: 0.018,
        price: 70.0,
        provenance: 'market-survey',
        sourceReference: 'MS-Q1-2025',
        observedAtDaysAgo: 60,
      },
      {
        resourceCode: 'RES-LAB-PLASTER',
        resourceName: 'Plasterer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.067,
        price: 130.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P018',
        observedAtDaysAgo: 120,
      },
      {
        resourceCode: 'RES-LAB-LABOUR',
        resourceName: 'Labourer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.067,
        price: 70.0,
        provenance: 'manual',
        sourceReference: 'Labour-Policy-v7',
        observedAtDaysAgo: 90,
      },
    ],
  },
  // 5. Electrical First-Fix Conduiting
  {
    wdId: 'wd-elec-005',
    versionId: 'wd-elec-005-v1',
    code: 'WD-ELEC-005',
    name: 'First Fix Electrical Conduiting',
    category: 'mep',
    unit: 'm',
    wastage: 0.1,
    productivity: 40,
    hazards: ['Electric shock (existing services)', 'Falls from scaffolding'],
    controls: [
      'Isolate existing circuits before working',
      'Use insulated tools',
      'Inspect scaffolding daily',
    ],
    qualityChecklist: [
      'Conduit fixed at ≤1m centres',
      'Pull wire installed for future cables',
      'Boxes set flush with finished wall',
    ],
    ppe: 'Hard hat, safety boots, insulated gloves, safety glasses',
    permits: 'Electrical isolation permit',
    subcontractability: 'yes',
    methodStatementFragment:
      'Set out conduit runs to electrical layout. Fix PVC conduit to walls/ceilings using saddles at 1m centres. Install switch/socket boxes flush. Pull through draw wire. Cap and label all conduits.',
    commonAssumptions:
      'Conduit sizes per electrical design (typically 20mm/25mm). Boxes counted separately.',
    commonExclusions: 'Cable pulling, fittings, final connections, testing.',
    recipe: [
      {
        resourceCode: 'RES-MAT-CONDUIT',
        resourceName: 'PVC conduit (20mm)',
        unit: 'm',
        kind: 'material',
        quantityPerUnit: 1.05,
        price: 4.5,
        provenance: 'supplier-quote',
        sourceReference: 'ELEC-Quote-719',
        observedAtDaysAgo: 12,
      },
      {
        resourceCode: 'RES-MAT-ELEC-ACC',
        resourceName: 'Electrical accessories (boxes, saddles, fittings)',
        unit: 'no',
        kind: 'material',
        quantityPerUnit: 0.35,
        price: 8.0,
        provenance: 'invoice',
        sourceReference: 'INV-1090',
        observedAtDaysAgo: 8,
      },
      // Electrician labour is intentionally UNSOURCED — this is subcontracted work
      // and we are awaiting a subcontractor quote.
      {
        resourceCode: 'RES-LAB-ELEC',
        resourceName: 'Electrician',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.025,
        price: 0,
        provenance: 'manual',
        sourceReference: undefined,
        observedAtDaysAgo: 0,
        unsourced: true,
      },
    ],
  },
  // 6. uPVC Soil & Waste Pipe
  {
    wdId: 'wd-plmb-006',
    versionId: 'wd-plmb-006-v1',
    code: 'WD-PLMB-006',
    name: 'uPVC Soil & Waste Pipe Installation (110mm)',
    category: 'mep',
    unit: 'm',
    wastage: 0.05,
    productivity: 20,
    hazards: ['Confined space entry', 'Exposure to existing sewage'],
    controls: ['Provide ventilation', 'Wear respiratory protection in confined spaces'],
    qualityChecklist: [
      'Pipe gradient 1:40 minimum (soil)',
      'Joints solvent-welded and tested',
      'Pipe sleeves at wall penetrations',
    ],
    ppe: 'Hard hat, gloves, safety glasses, mask when solvent welding',
    permits: 'Hot work permit if connecting to existing',
    subcontractability: 'yes',
    methodStatementFragment:
      'Set out pipe runs to plumbing layout. Fix uPVC pipes to walls/soffits using brackets at 1m centres. Solvent-weld joints. Connect to inspection chambers. Cap ends pending second-fix. Test for leaks.',
    commonAssumptions: 'Pipe sizes per plumbing design. Inspection chambers by others.',
    commonExclusions: 'Sanitary fittings, water supply, second-fix connections.',
    recipe: [
      {
        resourceCode: 'RES-MAT-UPVC110',
        resourceName: 'uPVC soil pipe (110mm)',
        unit: 'm',
        kind: 'material',
        quantityPerUnit: 1.05,
        price: 32.0,
        provenance: 'supplier-quote',
        sourceReference: 'PLMB-Quote-441',
        observedAtDaysAgo: 15,
      },
      {
        resourceCode: 'RES-MAT-UPVC-FIT',
        resourceName: 'uPVC fittings (bends, junctions, brackets)',
        unit: 'no',
        kind: 'material',
        quantityPerUnit: 0.4,
        price: 12.0,
        provenance: 'invoice',
        sourceReference: 'INV-1088',
        observedAtDaysAgo: 10,
      },
      {
        resourceCode: 'RES-LAB-PLUMB',
        resourceName: 'Plumber',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.05,
        price: 140.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P027',
        observedAtDaysAgo: 100,
      },
    ],
  },
  // 7. Concrete Paving
  {
    wdId: 'wd-extw-007',
    versionId: 'wd-extw-007-v1',
    code: 'WD-EXTW-007',
    name: 'Concrete Paving (100mm, interlocking)',
    category: 'external',
    unit: 'm2',
    wastage: 0.05,
    productivity: 20,
    hazards: ['Back injury from lifting pavers', 'Crush injury from plate compactor'],
    controls: [
      'Team lift paver pallets',
      'Use ear defenders near plate compactor',
      'Maintain exclusion zone around plant',
    ],
    qualityChecklist: [
      'Bedding level within ±5mm',
      'Joints 3-5mm, filled with fine sand',
      'Surface compacted and re-checked',
    ],
    ppe: 'Hard hat, safety boots, hi-vis, ear defenders, gloves',
    permits: 'None',
    subcontractability: 'yes',
    methodStatementFragment:
      'Excavate and compact subgrade. Lay 50mm lean concrete base. Spread 25mm bedding sand. Lay interlocking pavers to pattern. Cut edge pavers. Vibrate with plate compactor. Brush kiln-dried sand into joints.',
    commonAssumptions: 'Subgrade prepared and compacted by others. Paver pattern running bond.',
    commonExclusions: 'Edging restraints, drainage, sub-base.',
    recipe: [
      {
        resourceCode: 'RES-MAT-PAVER',
        resourceName: 'Interlocking concrete pavers (100mm)',
        unit: 'm2',
        kind: 'material',
        quantityPerUnit: 1.02,
        price: 75.0,
        provenance: 'supplier-quote',
        sourceReference: 'PAV-Quote-308',
        observedAtDaysAgo: 14,
      },
      {
        resourceCode: 'RES-MAT-SAND-BED',
        resourceName: 'Bedding sand',
        unit: 'm3',
        kind: 'material',
        quantityPerUnit: 0.03,
        price: 65.0,
        provenance: 'market-survey',
        sourceReference: 'MS-Q1-2025',
        observedAtDaysAgo: 60,
      },
      {
        resourceCode: 'RES-MAT-CEM425',
        resourceName: 'Cement (42.5R)',
        unit: 'ton',
        kind: 'material',
        quantityPerUnit: 0.005,
        price: 95.0,
        provenance: 'invoice',
        sourceReference: 'INV-982',
        observedAtDaysAgo: 14,
      },
      {
        resourceCode: 'RES-LAB-MASON',
        resourceName: 'Mason (paving)',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.05,
        price: 120.0,
        provenance: 'historical-bid',
        sourceReference: 'BID-2024-P018',
        observedAtDaysAgo: 120,
      },
      {
        resourceCode: 'RES-LAB-LABOUR',
        resourceName: 'Labourer',
        unit: 'day',
        kind: 'labour',
        quantityPerUnit: 0.1,
        price: 70.0,
        provenance: 'manual',
        sourceReference: 'Labour-Policy-v7',
        observedAtDaysAgo: 90,
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Wipe
// ─────────────────────────────────────────────────────────────────────────────

async function wipeAll(): Promise<void> {
  console.log('• Wiping existing rows (dependency-safe order)...');
  // Order matters: children first, then parents.
  // Note: Bid references Estimate (FK), so Bid must be deleted before Estimate.
  // ResourcePriceObservation references WorkDefinitionVersion, so it must be deleted
  // before WorkDefinitionVersion.
  await prisma.knowledgeAlert.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.waitlistEntry.deleteMany();
  await prisma.subcontractQuoteLine.deleteMany();
  await prisma.subcontractQuote.deleteMany();
  await prisma.subcontractPackageLine.deleteMany();
  await prisma.subcontractPackage.deleteMany();
  await prisma.bid.deleteMany();
  await prisma.estimateRevision.deleteMany();
  await prisma.estimateLine.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.scopeEvidence.deleteMany();
  await prisma.scopeAssumption.deleteMany();
  await prisma.scopeQuestion.deleteMany();
  await prisma.scopeItem.deleteMany();
  await prisma.scopePackage.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.resourcePriceObservation.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.workDefinitionVersion.deleteMany();
  await prisma.workDefinition.deleteMany();
  await prisma.user.deleteMany();
  await prisma.client.deleteMany();
  await prisma.organization.deleteMany();
  console.log('  ✓ Wipe complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization, Users, Clients
// ─────────────────────────────────────────────────────────────────────────────

interface SeedCtx {
  orgId: string;
  userIds: { kwesi: string; abena: string; kofi: string };
  clientIds: {
    ama: string;
    ugh: string;
    zenith: string;
    presby: string;
  };
  /** Map resourceCode → resourceId. */
  resourceIds: Map<string, string>;
  /** Map wdId → versionId. */
  wdVersionIds: Map<string, string>;
  /** Map wdId → workDefinitionId. */
  wdIds: Map<string, string>;
}

async function seedOrganizationAndUsers(): Promise<SeedCtx> {
  console.log('• Seeding Organization + Users + Clients...');

  const orgId = 'org-1';
  await prisma.organization.create({
    data: {
      id: orgId,
      name: 'Adom Construction Ltd',
      industryPackId: 'construction-ghana',
      currency: 'GHS',
    },
  });

  const userIds = {
    kwesi: 'user-kwesi',
    abena: 'user-abena',
    kofi: 'user-kofi',
    admin: 'user-admin',
  };

  // Demo accounts share a known password for quick login.
  const demoPasswordHash = await hashPassword('demo1234');

  // Demo accounts (isDemo=true) — one per role, for quick-login links.
  await prisma.user.create({
    data: {
      id: userIds.kwesi,
      organizationId: orgId,
      name: 'Kwesi Mensah',
      email: 'kwesi@adomconstruction.gh',
      role: 'director',
      passwordHash: demoPasswordHash,
      isDemo: true,
    },
  });
  await prisma.user.create({
    data: {
      id: userIds.abena,
      organizationId: orgId,
      name: 'Abena Owusu',
      email: 'abena@adomconstruction.gh',
      role: 'estimator',
      passwordHash: demoPasswordHash,
      isDemo: true,
    },
  });
  await prisma.user.create({
    data: {
      id: userIds.kofi,
      organizationId: orgId,
      name: 'Kofi Asante',
      email: 'kofi@adomconstruction.gh',
      role: 'manager',
      passwordHash: demoPasswordHash,
      isDemo: true,
    },
  });

  // Real (non-demo) admin account — controls the waitlist.
  await prisma.user.create({
    data: {
      id: userIds.admin,
      organizationId: orgId,
      name: 'Admin',
      email: 'ekontetevi@gmail',
      role: 'admin',
      passwordHash: await hashPassword('Payswap123456'),
      isDemo: false,
    },
  });

  const clientIds = {
    ama: 'client-ama',
    ugh: 'client-ugh',
    zenith: 'client-zenith',
    presby: 'client-presby',
  };

  await prisma.client.create({
    data: {
      id: clientIds.ama,
      organizationId: orgId,
      name: 'Accra Metropolitan Assembly',
      contactName: 'Mr. Yaw Boateng',
      contactEmail: 'yboateng@ama.gov.gh',
      contactPhone: '+233 20 123 4567',
      sector: 'public',
    },
  });
  await prisma.client.create({
    data: {
      id: clientIds.ugh,
      organizationId: orgId,
      name: 'University of Ghana Estates',
      contactName: 'Dr. Akosua Tuffour',
      contactEmail: 'atuffour@ug.edu.gh',
      contactPhone: '+233 24 456 7890',
      sector: 'public',
    },
  });
  await prisma.client.create({
    data: {
      id: clientIds.zenith,
      organizationId: orgId,
      name: 'Zenith Properties Ltd',
      contactName: 'Mrs. Efua Mensah',
      contactEmail: 'efua@zenithproperties.com',
      contactPhone: '+233 27 789 0123',
      sector: 'private',
    },
  });
  await prisma.client.create({
    data: {
      id: clientIds.presby,
      organizationId: orgId,
      name: 'Presbyterian Church Ghana',
      contactName: 'Rev. Daniel Owusu',
      contactEmail: 'daniel@presbygh.org',
      contactPhone: '+233 20 345 6789',
      sector: 'ngo',
    },
  });

  console.log('  ✓ 1 organization, 3 users, 4 clients.');

  return {
    orgId,
    userIds,
    clientIds,
    resourceIds: new Map(),
    wdVersionIds: new Map(),
    wdIds: new Map(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Definitions + Resources + Price Observations
// ─────────────────────────────────────────────────────────────────────────────

/** Build the recipe JSON (CostRecipeLine[]) from a WdSeed, embedding priceObservations. */
function buildRecipeJson(wd: WdSeed): string {
  const recipe: CostRecipeLine[] = wd.recipe.map((r) => ({
    resourceKind: r.kind,
    resourceCode: r.resourceCode,
    resourceName: r.resourceName,
    unit: r.unit,
    quantityPerUnit: r.quantityPerUnit,
    priceObservation: r.unsourced
      ? null
      : {
          price: r.price,
          provenance: r.provenance,
          sourceReference: r.sourceReference,
          observedAt: iso(daysAgo(r.observedAtDaysAgo)),
        },
  }));
  return JSON.stringify(recipe);
}

async function seedWorkDefinitions(ctx: SeedCtx): Promise<void> {
  console.log('• Seeding Work Definitions + Resources + Price Observations...');

  // Track resources so we don't create duplicates (cement appears in multiple WDs).
  const createdResources = new Set<string>();

  for (const wd of WORK_DEFINITIONS) {
    // 1. Create the WorkDefinition row (without currentVersionId yet).
    await prisma.workDefinition.create({
      data: {
        id: wd.wdId,
        organizationId: ctx.orgId,
        code: wd.code,
        name: wd.name,
        industry: 'construction',
        category: wd.category,
        unit: wd.unit,
        approvalState: 'approved',
      },
    });
    ctx.wdIds.set(wd.wdId, wd.wdId);

    // 2. Build the recipe JSON.
    const costRecipeJson = buildRecipeJson(wd);

    // 3. Create the WorkDefinitionVersion (approved).
    await prisma.workDefinitionVersion.create({
      data: {
        id: wd.versionId,
        workDefinitionId: wd.wdId,
        version: 1,
        measurementRule: `per ${wd.unit}`,
        costRecipeJson,
        productivityRule: wd.productivity,
        crewComposition: 'Standard crew (see method statement)',
        equipment: wd.recipe.find((r) => r.kind === 'plant')?.resourceName ?? 'Hand tools',
        wastage: wd.wastage,
        sequencing: 'Per method statement; sequence to programme.',
        methodStatementFragment: wd.methodStatementFragment,
        hazardsJson: JSON.stringify(wd.hazards),
        controlsJson: JSON.stringify(wd.controls),
        qualityChecklistJson: JSON.stringify(wd.qualityChecklist),
        requiredPPE: wd.ppe,
        requiredPermits: wd.permits,
        subcontractability: wd.subcontractability,
        commonAssumptions: wd.commonAssumptions,
        commonExclusions: wd.commonExclusions,
        approvalState: 'approved',
        approvedAt: daysAgo(45),
        approvedById: ctx.userIds.kwesi,
      },
    });
    ctx.wdVersionIds.set(wd.wdId, wd.versionId);

    // 4. Link WD.currentVersionId.
    await prisma.workDefinition.update({
      where: { id: wd.wdId },
      data: { currentVersionId: wd.versionId },
    });

    // 5. Create Resource + ResourcePriceObservation for each recipe line.
    for (const r of wd.recipe) {
      if (!createdResources.has(r.resourceCode)) {
        const resourceId = `res-${r.resourceCode.toLowerCase().replace(/_/g, '-')}`;
        await prisma.resource.create({
          data: {
            id: resourceId,
            organizationId: ctx.orgId,
            code: r.resourceCode,
            name: r.resourceName,
            unit: r.unit,
            kind: r.kind,
            currency: 'GHS',
            region: 'Greater Accra',
          },
        });
        ctx.resourceIds.set(r.resourceCode, resourceId);
        createdResources.add(r.resourceCode);
      }

      // Create the price observation (skip if recipe line is unsourced).
      if (!r.unsourced) {
        const resourceId = ctx.resourceIds.get(r.resourceCode)!;
        await prisma.resourcePriceObservation.create({
          data: {
            id: `rpo-${wd.versionId}-${r.resourceCode.toLowerCase().replace(/_/g, '-')}`,
            resourceId,
            workDefinitionVersionId: wd.versionId,
            price: r.price,
            currency: 'GHS',
            provenance: r.provenance,
            sourceReference: r.sourceReference ?? null,
            observedAt: daysAgo(r.observedAtDaysAgo),
            recordedById: ctx.userIds.abena,
          },
        });
      }
    }
  }

  console.log(
    `  ✓ ${WORK_DEFINITIONS.length} work definitions, ${ctx.resourceIds.size} resources, ${await prisma.resourcePriceObservation.count()} price observations.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Opportunities
// ─────────────────────────────────────────────────────────────────────────────

async function seedOpportunities(ctx: SeedCtx): Promise<{
  classroom: string;
  bungalows: string;
  lechall: string;
  office: string;
}> {
  console.log('• Seeding Opportunities...');

  // #1 — Two-Storey Classroom Block (main demo).
  await prisma.opportunity.create({
    data: {
      id: 'opp-classroom',
      organizationId: ctx.orgId,
      clientId: ctx.clientIds.ama,
      ownerId: ctx.userIds.abena,
      title: 'Two-Storey Classroom Block — AMA Basic School',
      reference: 'AMA/TEN/2025/014',
      status: 'estimating',
      source: 'tender-portal',
      description:
        'Construction of a two-storey 12-classroom block with admin wing, library, and staff room for AMA Basic School. Includes structural works, roofing, finishes, MEP first-fix, and external paving.',
      receivedAt: daysAgo(14),
      submissionDeadline: daysFromNow(21),
      location: 'Accra',
    },
  });

  // #2 — Staff Bungalows (Presbyterian Church).
  await prisma.opportunity.create({
    data: {
      id: 'opp-bungalows',
      organizationId: ctx.orgId,
      clientId: ctx.clientIds.presby,
      ownerId: ctx.userIds.kofi,
      title: 'Staff Bungalows (4 Units) — Presbyterian Church',
      reference: 'PCG/EST/2025/003',
      status: 'internal-review',
      source: 'direct',
      description:
        'Design and construction of 4 units of 3-bedroom staff bungalows for the Presbyterian Church Ghana. Includes site works, drainage, and boundary wall.',
      receivedAt: daysAgo(20),
      submissionDeadline: daysFromNow(10),
      location: 'Kumasi',
    },
  });

  // #3 — Lecture Hall Refurbishment (Univ. of Ghana).
  await prisma.opportunity.create({
    data: {
      id: 'opp-lechall',
      organizationId: ctx.orgId,
      clientId: ctx.clientIds.ugh,
      ownerId: ctx.userIds.abena,
      title: 'Lecture Hall Refurbishment — University of Ghana',
      reference: 'UG/EST/RFQ/2025/087',
      status: 'scope-development',
      source: 'tender-portal',
      description:
        'Refurbishment of an existing 250-seat lecture hall: new ceiling, lighting, HVAC, seating, and finishes. Phased works to be carried out during semester break.',
      receivedAt: daysAgo(5),
      submissionDeadline: daysFromNow(30),
      location: 'Legon, Accra',
    },
  });

  // #4 — Office Complex (Zenith Properties) — submitted/won.
  await prisma.opportunity.create({
    data: {
      id: 'opp-office',
      organizationId: ctx.orgId,
      clientId: ctx.clientIds.zenith,
      ownerId: ctx.userIds.kwesi,
      title: 'Office Complex — Zenith Properties',
      reference: 'ZP/RFQ/2025/012',
      status: 'won',
      source: 'referral',
      description:
        'Construction of a 3-storey grade-A office complex with basement parking, ground-floor retail, and rooftop terrace. Includes structural works, MEP, lifts, and external works.',
      receivedAt: daysAgo(60),
      submissionDeadline: daysAgo(5),
      location: 'Osu, Accra',
    },
  });

  console.log('  ✓ 4 opportunities.');
  return {
    classroom: 'opp-classroom',
    bungalows: 'opp-bungalows',
    lechall: 'opp-lechall',
    office: 'opp-office',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope Package for Opportunity #1 (classroom block)
// ─────────────────────────────────────────────────────────────────────────────

interface ScopeCtx {
  packageId: string;
  itemIds: {
    blockwork: string;
    slab: string;
    roofing: string;
    plastering: string;
    elecSpec: string;
    fireResp: string;
  };
  completeness: number;
}

async function seedScopeForClassroom(
  ctx: SeedCtx,
  oppId: string,
): Promise<ScopeCtx> {
  console.log('• Seeding Scope Package for Classroom Block opportunity...');

  const packageId = 'scope-classroom';
  const itemIds = {
    blockwork: 'si-cb-block',
    slab: 'si-cb-slab',
    roofing: 'si-cb-roof',
    plastering: 'si-cb-plast',
    elecSpec: 'si-cb-elec',
    fireResp: 'si-cb-fire',
  };

  // Create the package (we'll update completeness after items are inserted).
  await prisma.scopePackage.create({
    data: {
      id: packageId,
      opportunityId: oppId,
      completeness: 0,
      origin: 'rfq',
    },
  });

  // 6 scope items: 4 known, 1 missing, 1 ambiguous.
  await prisma.scopeItem.create({
    data: {
      id: itemIds.blockwork,
      scopePackageId: packageId,
      description: '150mm Sandcrete blockwork to external and internal walls',
      category: 'masonry',
      origin: 'client',
      status: 'known',
      confidence: 1.0,
    },
  });
  await prisma.scopeItem.create({
    data: {
      id: itemIds.slab,
      scopePackageId: packageId,
      description: 'Reinforced concrete slab (250mm) to first-floor level',
      category: 'structural',
      origin: 'client',
      status: 'known',
      confidence: 1.0,
    },
  });
  await prisma.scopeItem.create({
    data: {
      id: itemIds.roofing,
      scopePackageId: packageId,
      description: 'Aluminium roofing sheets (0.5mm) to classroom roof',
      category: 'roofing',
      origin: 'client',
      status: 'known',
      confidence: 1.0,
    },
  });
  await prisma.scopeItem.create({
    data: {
      id: itemIds.plastering,
      scopePackageId: packageId,
      description: '15mm internal plastering to wall surfaces',
      category: 'finishes',
      origin: 'client',
      status: 'known',
      confidence: 1.0,
    },
  });
  await prisma.scopeItem.create({
    data: {
      id: itemIds.elecSpec,
      scopePackageId: packageId,
      description:
        'Electrical specification — light fitting schedule, socket counts, conduit sizes, distribution board schedule',
      category: 'mep',
      origin: 'estimator',
      status: 'missing',
      confidence: 0.2,
    },
  });
  await prisma.scopeItem.create({
    data: {
      id: itemIds.fireResp,
      scopePackageId: packageId,
      description: 'Fire protection responsibility (client or contractor?)',
      category: 'mep',
      origin: 'estimator',
      status: 'ambiguous',
      confidence: 0.4,
    },
  });

  // 3 ScopeQuestions (1 open).
  await prisma.scopeQuestion.create({
    data: {
      id: 'sq-cb-1',
      scopePackageId: packageId,
      question:
        'Does the blockwork specification include structural columns at grid intersections?',
      category: 'masonry',
      interpretationA: 'Blockwork only — columns priced under RC slab package.',
      interpretationB: 'Blockwork includes integral columns.',
      selectedInterpretation: 'A',
      costImpact: 8500,
      programmeImpact: 3,
      safetyImpact: 'No change',
      contractualImpact: 'Clarifies scope split with concrete package.',
      status: 'clarified',
      resolution: 'Client confirmed interpretation A on tender clarification call.',
    },
  });
  await prisma.scopeQuestion.create({
    data: {
      id: 'sq-cb-2',
      scopePackageId: packageId,
      question:
        'Is the contractor responsible for fire detection and alarm system installation?',
      category: 'mep',
      interpretationA:
        'Contractor installs first-fix conduiting only — specialist sub for second-fix.',
      interpretationB: 'Contractor delivers full fire alarm system (supply + install + commission).',
      selectedInterpretation: null,
      costImpact: 32000,
      programmeImpact: 14,
      safetyImpact: 'Critical for occupancy permit.',
      contractualImpact: 'Could shift 6-8% of contract value.',
      status: 'open',
    },
  });
  await prisma.scopeQuestion.create({
    data: {
      id: 'sq-cb-3',
      scopePackageId: packageId,
      question: 'What is the required concrete grade for the slab (C25 or C30)?',
      category: 'structural',
      interpretationA: 'C25 (standard for school buildings).',
      interpretationB: 'C30 (higher durability for coastal environment).',
      selectedInterpretation: 'A',
      costImpact: 1800,
      programmeImpact: 0,
      safetyImpact: 'No change',
      contractualImpact: 'Minor cost variance.',
      status: 'clarified',
      resolution: 'Default to C25 per Ghana Building Code unless noted by structural engineer.',
    },
  });

  // 2 ScopeAssumptions (1 unacknowledged high-risk).
  await prisma.scopeAssumption.create({
    data: {
      id: 'sa-cb-1',
      scopePackageId: packageId,
      text: 'Site is level and free of obstructions at handover; no demolition required.',
      rationale: 'AMA site visit report dated 5 days ago confirmed clear site.',
      riskLevel: 'low',
      acknowledged: true,
    },
  });
  await prisma.scopeAssumption.create({
    data: {
      id: 'sa-cb-2',
      scopePackageId: packageId,
      text: 'Fire alarm system to be supplied and installed by specialist sub-contractor appointed by the client; we will provide first-fix conduiting only.',
      rationale:
        'Tender drawings are silent on responsibility. Pending clarification (see open question SQ-CB-2).',
      riskLevel: 'high',
      acknowledged: false,
    },
  });

  // 3 ScopeEvidence records.
  await prisma.scopeEvidence.create({
    data: {
      id: 'se-cb-1',
      scopePackageId: packageId,
      type: 'rfq',
      reference: 'AMA/TEN/2025/014',
      summary:
        'Tender invitation published on AMA procurement portal. Includes scope of works, drawings list, and submission requirements.',
    },
  });
  await prisma.scopeEvidence.create({
    data: {
      id: 'se-cb-2',
      scopePackageId: packageId,
      type: 'drawing',
      reference: 'DWG-A-001..A-014',
      summary:
        'Architectural drawings: site plan, ground floor, first floor, roof plan, 4 elevations, 2 sections. Structural drawings deferred to later issue.',
    },
  });
  await prisma.scopeEvidence.create({
    data: {
      id: 'se-cb-3',
      scopePackageId: packageId,
      type: 'specification',
      reference: 'SPEC-AMA-2025-v2',
      summary:
        'Specification notes cover blockwork, concrete, roofing, and finishes. MEP specification marked "TBC" — flagged as scope gap.',
    },
  });

  // Compute scope completeness via the engine.
  const completenessResult = computeScopeCompleteness(
    [
      { description: 'Blockwork', status: 'known' },
      { description: 'RC Slab', status: 'known' },
      { description: 'Roofing', status: 'known' },
      { description: 'Plastering', status: 'known' },
      { description: 'Electrical specification', status: 'missing' },
      { description: 'Fire protection responsibility', status: 'ambiguous' },
    ],
    [
      { status: 'clarified' },
      { status: 'open' },
      { status: 'clarified' },
    ],
  );

  console.log(
    `  • computeScopeCompleteness → score=${completenessResult.score} (known=${completenessResult.knownCount}, missing=${completenessResult.missingCount}, ambiguous=${completenessResult.ambiguousCount}, openQuestions=${completenessResult.openQuestions})`,
  );

  await prisma.scopePackage.update({
    where: { id: packageId },
    data: { completeness: completenessResult.score },
  });

  console.log('  ✓ 1 scope package, 6 items, 3 questions, 2 assumptions, 3 evidence records.');

  return { packageId, itemIds, completeness: completenessResult.score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimate + Lines for Opportunity #1 (classroom block)
// ─────────────────────────────────────────────────────────────────────────────

interface EstimateLineSeed {
  wdId: string;
  description: string;
  quantity: number;
  scopeItemId: string | null;
  executionStrategy: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided';
  /** Optional subcontract quote for pricing (only set when strategy='subcontract' and a quote exists). */
  subcontractQuote?: { totalAmount: number; coveragePct: number } | null;
  /** Optional override for unsourcedRationale / acknowledged. */
  unsourcedRationale?: string;
  acknowledged?: boolean;
}

const CLASSROOM_LINES: EstimateLineSeed[] = [
  {
    wdId: 'wd-msry-001',
    description: '150mm Sandcrete blockwork — external walls',
    quantity: 380,
    scopeItemId: 'si-cb-block',
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-msry-001',
    description: '150mm Sandcrete blockwork — internal partitions',
    quantity: 220,
    scopeItemId: 'si-cb-block',
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-strc-002',
    description: 'Reinforced concrete slab (250mm) — first-floor',
    quantity: 28,
    scopeItemId: 'si-cb-slab',
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-roof-003',
    description: 'Aluminium roofing sheets (0.5mm) — classroom roof',
    quantity: 320,
    scopeItemId: 'si-cb-roof',
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-fnsh-004',
    description: '15mm internal plastering — wall surfaces',
    quantity: 540,
    scopeItemId: 'si-cb-plast',
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-elec-005',
    description: 'First-fix electrical conduiting — provisional, pending subcontractor quote',
    quantity: 480,
    scopeItemId: 'si-cb-elec',
    executionStrategy: 'subcontract',
    // No subcontractQuote — this is the unsourced line.
    unsourcedRationale: 'Awaiting subcontractor quote for electrical first-fix',
    acknowledged: false,
  },
];

interface LinePricingResult {
  lineId: string;
  breakdown: PricingBreakdown;
  confidence: number;
  sellPrice: number;
}

/** Build a human-readable provenance summary from a PricingBreakdown. */
function buildProvenanceSummary(b: PricingBreakdown): string {
  if (b.provenance.length === 0) {
    if (b.unsourcedResources.length > 0) {
      return `UNSOURCED: ${b.unsourcedResources.join(', ')}`;
    }
    return 'No price provenance recorded.';
  }
  return b.provenance
    .map((p) => {
      const refPart = p.sourceReference ? ` #${p.sourceReference}` : '';
      return `${p.resourceName}: ${p.provenance}${refPart} @ ${formatGHS(p.price)}`;
    })
    .join('; ');
}

/** Compute pricing + confidence for a line and persist it. Returns the line id + breakdown. */
async function createEstimateLine(
  ctx: SeedCtx,
  estimateId: string,
  lineSeed: EstimateLineSeed,
  scopeCompleteness: number,
  lineIndex: number,
  estimateCreatedAt: Date,
  lineIdPrefix: string,
): Promise<LinePricingResult> {
  const wdId = ctx.wdIds.get(lineSeed.wdId)!;
  const versionId = ctx.wdVersionIds.get(lineSeed.wdId)!;

  // Look up the WD version (we need name, unit, wastage, productivity, costRecipeJson).
  const wdv = await prisma.workDefinitionVersion.findUnique({
    where: { id: versionId },
    select: {
      version: true,
      wastage: true,
      productivityRule: true,
      costRecipeJson: true,
      approvalState: true,
      workDefinition: { select: { name: true, unit: true } },
    },
  });
  if (!wdv) throw new Error(`WDV ${versionId} not found`);

  // Build the PricingInput.
  const breakdown = priceLine({
    workDefinitionVersion: {
      id: versionId,
      name: wdv.workDefinition.name,
      version: wdv.version,
      unit: wdv.workDefinition.unit,
      wastage: wdv.wastage,
      productivityRule: wdv.productivityRule ?? undefined,
      costRecipeJson: wdv.costRecipeJson,
    },
    quantity: lineSeed.quantity,
    executionStrategy: lineSeed.executionStrategy,
    overheadPct: 0.1,
    profitPct: 0.12,
    contingencyPct: 0.05,
    subcontractQuote: lineSeed.subcontractQuote ?? null,
  });

  // Compute confidence. Use the oldest observedAt in the provenance (or the recipe)
  // for the freshness factor.
  let observedAtForConfidence: string | null = null;
  let provenanceForConfidence: string | null = null;
  if (breakdown.provenance.length > 0) {
    // Use the oldest observation (most conservative freshness).
    const sorted = [...breakdown.provenance].sort(
      (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
    );
    observedAtForConfidence = sorted[0].observedAt;
    provenanceForConfidence = sorted[0].provenance;
  }

  const confidenceResult = computeConfidence({
    observedAt: observedAtForConfidence,
    referenceDate: iso(estimateCreatedAt),
    priceProvenance: provenanceForConfidence,
    workDefinitionApprovalState: wdv.approvalState,
    scopeCompleteness,
    executionStrategy: lineSeed.executionStrategy,
    subcontractQuotePresent:
      lineSeed.executionStrategy === 'subcontract'
        ? Boolean(lineSeed.subcontractQuote)
        : null,
    productivityRule: wdv.productivityRule,
    quantity: lineSeed.quantity,
    unit: wdv.workDefinition.unit,
  });

  const lineId = `${lineIdPrefix}-${lineIndex + 1}`;
  await prisma.estimateLine.create({
    data: {
      id: lineId,
      estimateId,
      scopeItemId: lineSeed.scopeItemId,
      workDefinitionId: wdId,
      workDefinitionVersionId: versionId,
      description: lineSeed.description,
      quantity: lineSeed.quantity,
      unit: wdv.workDefinition.unit,
      executionStrategy: lineSeed.executionStrategy,
      materialCost: breakdown.material,
      labourCost: breakdown.labour,
      plantCost: breakdown.plant,
      subcontractCost: breakdown.subcontract,
      directCost: breakdown.directCost,
      projectCost: breakdown.projectCost,
      riskCost: breakdown.riskCost,
      overheadCost: breakdown.overhead,
      profitCost: breakdown.profit,
      sellPrice: breakdown.sellPrice,
      unitRate: breakdown.unitRate,
      marginPct: breakdown.marginPct,
      confidence: confidenceResult.score,
      provenanceSummary: buildProvenanceSummary(breakdown),
      isUnsourced: breakdown.unsourced,
      unsourcedRationale: breakdown.unsourced
        ? (lineSeed.unsourcedRationale ?? `Unsourced resources: ${breakdown.unsourcedResources.join(', ')}`)
        : null,
      acknowledged: breakdown.unsourced
        ? (lineSeed.acknowledged ?? false)
        : true,
    },
  });

  return {
    lineId,
    breakdown,
    confidence: confidenceResult.score,
    sellPrice: breakdown.sellPrice,
  };
}

interface ClassroomEstimateResult {
  estimateId: string;
  lines: LinePricingResult[];
  totalSellPrice: number;
}

async function seedEstimateForClassroom(
  ctx: SeedCtx,
  oppId: string,
  scope: ScopeCtx,
): Promise<ClassroomEstimateResult> {
  console.log('• Seeding Estimate + EstimateLines for Classroom Block...');

  const estimateId = 'est-classroom';
  const createdAt = daysAgo(3);
  await prisma.estimate.create({
    data: {
      id: estimateId,
      organizationId: ctx.orgId,
      opportunityId: oppId,
      version: 1,
      status: 'draft',
      overheadPct: 0.1,
      profitPct: 0.12,
      contingencyPct: 0.05,
    },
  });

  const lines: LinePricingResult[] = [];
  for (let i = 0; i < CLASSROOM_LINES.length; i++) {
    const seed = CLASSROOM_LINES[i];
    const result = await createEstimateLine(
      ctx,
      estimateId,
      seed,
      scope.completeness,
      i,
      createdAt,
      'el-classroom',
    );
    lines.push(result);
    console.log(
      `  • Line ${i + 1}: "${seed.description}" — sell=${formatGHS(result.sellPrice)} unitRate=${formatGHS(result.breakdown.unitRate)} confidence=${result.confidence.toFixed(4)} unsourced=${result.breakdown.unsourced}`,
    );
  }

  const totalSellPrice = lines.reduce((s, l) => s + l.sellPrice, 0);
  console.log(`  ✓ Estimate total sell price: ${formatGHS(totalSellPrice)} (${lines.length} lines).`);

  return { estimateId, lines, totalSellPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcontract Package + Quotes for Opportunity #1
// ─────────────────────────────────────────────────────────────────────────────

async function seedSubcontractForClassroom(
  ctx: SeedCtx,
  oppId: string,
  estimate: ClassroomEstimateResult,
): Promise<void> {
  console.log('• Seeding Subcontract Package + Quotes for Classroom Block...');

  const packageId = 'subp-classroom-elec';
  await prisma.subcontractPackage.create({
    data: {
      id: packageId,
      organizationId: ctx.orgId,
      opportunityId: oppId,
      name: 'Electrical First-Fix & Conduiting',
      scope:
        'Supply and installation of all first-fix electrical conduiting, switch/socket boxes, and pull-wires to classroom block. Excludes final electrical specification (light fittings, sockets, distribution boards).',
      executionStrategy: 'subcontract',
      status: 'quotes-received',
      selectedQuoteId: null, // Intentionally unselected → triggers gate blocker.
    },
  });

  // Link the electrical estimate line to the package.
  const elecLine = estimate.lines.find(
    (l) => l.lineId === 'el-classroom-6',
  );
  if (!elecLine) throw new Error('Electrical estimate line not found');

  const packageLineId = 'subpl-classroom-elec-1';
  await prisma.subcontractPackageLine.create({
    data: {
      id: packageLineId,
      subcontractPackageId: packageId,
      estimateLineId: elecLine.lineId,
      requiredScope:
        'First-fix electrical conduiting (480m PVC conduit, switch/socket boxes, pull-wires) per tender drawings DWG-E-001..E-004.',
    },
  });

  // Quote A — VoltTech Electricals Ltd.
  const requiredLines = [
    {
      id: elecLine.lineId,
      description: 'First-fix electrical conduiting',
      sellPrice: elecLine.sellPrice,
    },
  ];

  const quoteAExclusions = ['Scaffolding', 'Delivery to site', 'Installation at level 3'];
  const quoteAAssumptions = ['Quotation valid 30 days', 'Excludes VAT'];

  const reconA = reconcileSubcontract({
    requiredLines,
    quote: {
      totalAmount: 18500,
      exclusionsJson: JSON.stringify(quoteAExclusions),
      assumptionsJson: JSON.stringify(quoteAAssumptions),
      // No line detail — whole-quote heuristic.
    },
  });

  console.log(
    `  • Quote A (VoltTech): coveragePct=${reconA.coveragePct} status=${reconA.status} warnings=${reconA.warnings.length}`,
  );

  await prisma.subcontractQuote.create({
    data: {
      id: 'subq-classroom-volttech',
      subcontractPackageId: packageId,
      supplierName: 'VoltTech Electricals Ltd',
      totalAmount: 18500,
      currency: 'GHS',
      receivedAt: daysAgo(2),
      exclusionsJson: JSON.stringify(quoteAExclusions),
      assumptionsJson: JSON.stringify(quoteAAssumptions),
      coveragePct: reconA.coveragePct,
      status: 'received',
    },
  });

  // Quote B — PowerLine Solutions.
  const reconB = reconcileSubcontract({
    requiredLines,
    quote: {
      totalAmount: 21000,
      exclusionsJson: JSON.stringify([]),
      assumptionsJson: JSON.stringify(['Includes delivery']),
    },
  });

  console.log(
    `  • Quote B (PowerLine): coveragePct=${reconB.coveragePct} status=${reconB.status}`,
  );

  // Force coveragePct = 1.0 per spec.
  await prisma.subcontractQuote.create({
    data: {
      id: 'subq-classroom-powerline',
      subcontractPackageId: packageId,
      supplierName: 'PowerLine Solutions',
      totalAmount: 21000,
      currency: 'GHS',
      receivedAt: daysAgo(1),
      exclusionsJson: JSON.stringify([]),
      assumptionsJson: JSON.stringify(['Includes delivery']),
      coveragePct: 1.0,
      status: 'received',
    },
  });

  console.log('  ✓ 1 subcontract package, 2 quotes (UNSELECTED).');
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit Logs for Opportunity #1
// ─────────────────────────────────────────────────────────────────────────────

async function seedAuditLogsForClassroom(
  ctx: SeedCtx,
  oppId: string,
  estimate: ClassroomEstimateResult,
): Promise<void> {
  console.log('• Seeding Audit Logs for Classroom Block...');

  const elecLine = estimate.lines.find((l) => l.lineId === 'el-classroom-6')!;
  const blockLine = estimate.lines.find((l) => l.lineId === 'el-classroom-1')!;

  const entries = [
    {
      id: 'al-cb-1',
      actorId: ctx.userIds.abena,
      action: 'opportunity.created',
      entityType: 'Opportunity',
      entityId: oppId,
      summary: 'Imported opportunity from AMA tender portal.',
      createdAt: daysAgo(14),
    },
    {
      id: 'al-cb-2',
      actorId: ctx.userIds.abena,
      action: 'scope.question-raised',
      entityType: 'ScopeQuestion',
      entityId: 'sq-cb-2',
      summary:
        'Raised open question on fire alarm system responsibility (cost impact ~GHS 32,000).',
      createdAt: daysAgo(10),
    },
    {
      id: 'al-cb-3',
      actorId: ctx.userIds.abena,
      action: 'assumption.added',
      entityType: 'ScopeAssumption',
      entityId: 'sa-cb-2',
      summary:
        'High-risk assumption logged: fire alarm system assumed client-appointed specialist sub.',
      createdAt: daysAgo(9),
    },
    {
      id: 'al-cb-4',
      actorId: ctx.userIds.abena,
      action: 'estimate.created',
      entityType: 'Estimate',
      entityId: estimate.estimateId,
      summary: `Created estimate v1 with ${estimate.lines.length} lines. Total sell: ${formatGHS(estimate.totalSellPrice)}.`,
      beforeJson: null,
      afterJson: JSON.stringify({ lineCount: estimate.lines.length, totalSell: estimate.totalSellPrice }),
      createdAt: daysAgo(3),
    },
    {
      id: 'al-cb-5',
      actorId: ctx.userIds.abena,
      action: 'rate.changed',
      entityType: 'EstimateLine',
      entityId: blockLine.lineId,
      summary: `Blockwork unit rate set to ${formatGHS(blockLine.breakdown.unitRate)}/m² (cement invoice #INV-982 driven).`,
      beforeJson: JSON.stringify({ unitRate: 0 }),
      afterJson: JSON.stringify({ unitRate: blockLine.breakdown.unitRate }),
      createdAt: daysAgo(2),
    },
    {
      id: 'al-cb-6',
      actorId: ctx.userIds.kofi,
      action: 'subcontract.quote-received',
      entityType: 'SubcontractQuote',
      entityId: 'subq-classroom-volttech',
      summary:
        'VoltTech Electricals Ltd submitted quote @ GHS 18,500 (excludes scaffolding, delivery, level 3 works).',
      createdAt: daysAgo(2),
    },
    {
      id: 'al-cb-7',
      actorId: ctx.userIds.kofi,
      action: 'subcontract.quote-received',
      entityType: 'SubcontractQuote',
      entityId: 'subq-classroom-powerline',
      summary: 'PowerLine Solutions submitted quote @ GHS 21,000 (includes delivery).',
      createdAt: daysAgo(1),
    },
    {
      id: 'al-cb-8',
      actorId: ctx.userIds.abena,
      action: 'estimate.line-flagged',
      entityType: 'EstimateLine',
      entityId: elecLine.lineId,
      summary:
        'Electrical first-fix line flagged as UNSOURCED — awaiting subcontractor quote selection. Acknowledged=false.',
      createdAt: daysAgo(1),
    },
  ];

  for (const e of entries) {
    await prisma.auditLog.create({ data: { ...e, organizationId: ctx.orgId } });
  }

  console.log(`  ✓ ${entries.length} audit log entries.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimate + Revision + Bid for Opportunity #4 (won)
// ─────────────────────────────────────────────────────────────────────────────

const OFFICE_LINES: EstimateLineSeed[] = [
  {
    wdId: 'wd-msry-001',
    description: '150mm Sandcrete blockwork — external & internal walls',
    quantity: 250,
    scopeItemId: null,
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-strc-002',
    description: 'Reinforced concrete slab (250mm) — 3 floors',
    quantity: 18,
    scopeItemId: null,
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-roof-003',
    description: 'Aluminium roofing sheets (0.5mm) — main roof',
    quantity: 210,
    scopeItemId: null,
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-fnsh-004',
    description: '15mm internal plastering — all walls',
    quantity: 360,
    scopeItemId: null,
    executionStrategy: 'self-perform',
  },
  {
    wdId: 'wd-extw-007',
    description: 'Concrete paving (100mm) — car park & walkways',
    quantity: 85,
    scopeItemId: null,
    executionStrategy: 'self-perform',
  },
];

async function seedEstimateAndBidForOffice(
  ctx: SeedCtx,
  oppId: string,
): Promise<void> {
  console.log('• Seeding Estimate + Revision + Bid for Office Complex (won)...');

  const estimateId = 'est-office';
  const createdAt = daysAgo(35);
  await prisma.estimate.create({
    data: {
      id: estimateId,
      organizationId: ctx.orgId,
      opportunityId: oppId,
      version: 1,
      status: 'submitted',
      overheadPct: 0.1,
      profitPct: 0.12,
      contingencyPct: 0.05,
    },
  });

  const lines: LinePricingResult[] = [];
  for (let i = 0; i < OFFICE_LINES.length; i++) {
    const result = await createEstimateLine(
      ctx,
      estimateId,
      OFFICE_LINES[i],
      0.85, // assumed scope completeness for the won opp (not in our scope model)
      i,
      createdAt,
      'el-office',
    );
    lines.push(result);
    console.log(
      `  • Line ${i + 1}: "${OFFICE_LINES[i].description}" — sell=${formatGHS(result.sellPrice)}`,
    );
  }

  const finalPrice = lines.reduce((s, l) => s + l.sellPrice, 0);
  console.log(`  • Final bid price: ${formatGHS(finalPrice)}.`);

  // EstimateRevision — immutable snapshot of the lines submitted.
  const snapshot = {
    estimateId,
    finalizedAt: iso(daysAgo(8)),
    overheadPct: 0.1,
    profitPct: 0.12,
    contingencyPct: 0.05,
    lines: lines.map((l, i) => ({
      index: i + 1,
      lineId: l.lineId,
      description: OFFICE_LINES[i].description,
      quantity: OFFICE_LINES[i].quantity,
      unitRate: l.breakdown.unitRate,
      sellPrice: l.sellPrice,
      material: l.breakdown.material,
      labour: l.breakdown.labour,
      plant: l.breakdown.plant,
      subcontract: l.breakdown.subcontract,
    })),
    totalSellPrice: finalPrice,
  };

  const revisionId = 'rev-office-1';
  await prisma.estimateRevision.create({
    data: {
      id: revisionId,
      estimateId,
      revisionNo: 1,
      snapshotJson: JSON.stringify(snapshot),
      finalizedAt: daysAgo(8),
      finalizedById: ctx.userIds.kwesi,
    },
  });

  // Mark estimate as superseded (the revision is the immutable snapshot).
  // Actually keep it as 'submitted' since that was the submitted state.

  // Bid — outcome=won.
  await prisma.bid.create({
    data: {
      id: 'bid-office',
      organizationId: ctx.orgId,
      opportunityId: oppId,
      estimateId,
      estimateRevisionId: revisionId,
      tenderPackStatus: 'submitted',
      finalPrice,
      directorAdjustment: -2500,
      adjustmentRationale:
        'Director shaved GHS 2,500 off final price to match competitor intelligence.',
      submittedAt: daysAgo(8),
      outcome: 'won',
      winningPrice: finalPrice - 2500,
      ourRank: 1,
      clientFeedback:
        'Strong technical submission and competitive pricing. Award letter received.',
    },
  });

  console.log('  ✓ 1 estimate, 1 revision, 1 bid (outcome=won).');
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Alerts
// ─────────────────────────────────────────────────────────────────────────────

async function seedKnowledgeAlerts(ctx: SeedCtx): Promise<void> {
  console.log('• Seeding Knowledge Alerts...');

  const cementResourceId = ctx.resourceIds.get('RES-MAT-CEM425');

  const alerts = [
    {
      id: 'ka-stale-cem',
      type: 'stale-price',
      severity: 'warning',
      title: 'Cement price observation is 120+ days old',
      detail:
        'Cement (42.5R) price of GHS 95.00/ton was last observed 120+ days ago (provenance: historical-bid BID-2024-P018). Re-validate with current supplier quote before next bid submission.',
      entityId: cementResourceId ?? null,
      entityType: 'Resource',
      acknowledged: false,
    },
    {
      id: 'ka-prod-var',
      type: 'productivity-variance',
      severity: 'warning',
      title: 'Blockwork productivity variance >20% on last 3 projects',
      detail:
        'Sandcrete blockwork productivity assumed at 12 m²/crew-day. Actuals on BID-2024-P018, BID-2024-P022, and BID-2024-P031 averaged 9.4 m²/crew-day (variance: -22%). Consider revising the approved WorkDefinition.',
      entityId: 'wd-msry-001-v1',
      entityType: 'WorkDefinitionVersion',
      acknowledged: false,
    },
    {
      id: 'ka-unapproved-rate',
      type: 'unapproved-rate',
      severity: 'warning',
      title: '3 estimate lines use unapproved work definitions',
      detail:
        '3 estimate lines reference work-definition versions still in draft approval state. Submit for approval before bid submission to avoid pre-submission gate blockers.',
      entityId: null,
      entityType: null,
      acknowledged: false,
    },
    {
      id: 'ka-sub-excl',
      type: 'subcontract-exclusion',
      severity: 'info',
      title: 'VoltTech quote excludes scaffolding',
      detail:
        'VoltTech Electricals Ltd quote for "Electrical First-Fix & Conduiting" (subq-classroom-volttech) excludes scaffolding, delivery to site, and installation at level 3. Confirm who covers these costs before awarding.',
      entityId: 'subq-classroom-volttech',
      entityType: 'SubcontractQuote',
      acknowledged: false,
    },
  ];

  for (const a of alerts) {
    await prisma.knowledgeAlert.create({ data: { ...a, organizationId: ctx.orgId } });
  }

  console.log(`  ✓ ${alerts.length} knowledge alerts.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Waitlist sample entries
// ─────────────────────────────────────────────────────────────────────────────

async function seedWaitlist(): Promise<void> {
  console.log('• Seeding waitlist entries...');
  const entries = [
    { name: 'Yaw Antwi', email: 'yaw.antwi@example.com', company: 'Antwi Builders', role: 'estimator' },
    { name: 'Ama Serwaa', email: 'ama.serwaa@example.com', company: 'Serwaa Civils', role: 'manager' },
    { name: 'Kwabena Boateng', email: 'kwabena@example.com', company: 'Boateng & Sons', role: 'director' },
  ];
  for (const e of entries) {
    await prisma.waitlistEntry.create({ data: e });
  }
  console.log(`  ✓ ${entries.length} waitlist entries (pending admin approval).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Final counts
// ─────────────────────────────────────────────────────────────────────────────

async function printCounts(): Promise<void> {
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Final entity counts:');
  console.log('────────────────────────────────────────────────────────────');
  const counts = {
    organizations: await prisma.organization.count(),
    users: await prisma.user.count(),
    clients: await prisma.client.count(),
    opportunities: await prisma.opportunity.count(),
    scopePackages: await prisma.scopePackage.count(),
    scopeItems: await prisma.scopeItem.count(),
    scopeQuestions: await prisma.scopeQuestion.count(),
    scopeAssumptions: await prisma.scopeAssumption.count(),
    scopeEvidence: await prisma.scopeEvidence.count(),
    workDefinitions: await prisma.workDefinition.count(),
    workDefinitionVersions: await prisma.workDefinitionVersion.count(),
    resources: await prisma.resource.count(),
    resourcePriceObservations: await prisma.resourcePriceObservation.count(),
    estimates: await prisma.estimate.count(),
    estimateLines: await prisma.estimateLine.count(),
    estimateRevisions: await prisma.estimateRevision.count(),
    subcontractPackages: await prisma.subcontractPackage.count(),
    subcontractPackageLines: await prisma.subcontractPackageLine.count(),
    subcontractQuotes: await prisma.subcontractQuote.count(),
    subcontractQuoteLines: await prisma.subcontractQuoteLine.count(),
    bids: await prisma.bid.count(),
    auditLogs: await prisma.auditLog.count(),
    knowledgeAlerts: await prisma.knowledgeAlert.count(),
    waitlistEntries: await prisma.waitlistEntry.count(),
  };
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('────────────────────────────────────────────────────────────\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('Contractor OS — Seed Script');
  console.log('============================================================\n');

  await wipeAll();

  const ctx = await seedOrganizationAndUsers();
  await seedWorkDefinitions(ctx);
  const oppIds = await seedOpportunities(ctx);
  const scope = await seedScopeForClassroom(ctx, oppIds.classroom);
  const classroomEstimate = await seedEstimateForClassroom(ctx, oppIds.classroom, scope);
  await seedSubcontractForClassroom(ctx, oppIds.classroom, classroomEstimate);
  await seedAuditLogsForClassroom(ctx, oppIds.classroom, classroomEstimate);
  await seedEstimateAndBidForOffice(ctx, oppIds.office);
  await seedKnowledgeAlerts(ctx);
  await seedWaitlist();

  await printCounts();

  console.log('✓ Seed complete.');
}

main()
  .catch((err) => {
    console.error('✗ Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
