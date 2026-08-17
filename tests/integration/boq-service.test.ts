/**
 * BOQ integration tests — against Neon PostgreSQL.
 *
 * Exercises the full BOQ Phase 1 flow end-to-end through the application
 * services and repositories:
 *   BoqImportService.createImport → parseImport
 *   BoqBindingService.suggestBindings → confirmBinding → rejectBinding
 *   BoqReconciliationService.reconcileImport → reconcileItem
 *
 * Verifies:
 *   - Tenant isolation (Org A cannot see/touch Org B's imports/items/bindings)
 *   - raw* values preserved verbatim alongside normalized* values (audit)
 *   - fileHash re-upload detection
 *   - Binding is human-only (AI actor rejected)
 *   - Reconciliation is computed (never stored as truth); RATE_DIVERGENT is
 *     asymmetric (canonical authoritative)
 *   - EstimateLine is NEVER mutated by any BOQ operation
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL (enforced by tests/setup.ts).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { boqImportService } from '../../src/application/boq-import-service'
import { boqBindingService } from '../../src/application/boq-binding-service'
import { boqReconciliationService } from '../../src/application/boq-reconciliation-service'
import type { RequestContext } from '../../src/lib/context'
import type { RawBoqRow } from '../../src/lib/boq'

const db = new PrismaClient()

const ORG_A = 'test-boq-org-a'
const ORG_B = 'test-boq-org-b'
const USER_A = 'test-boq-user-a'
const USER_B = 'test-boq-user-b'
const CLIENT_A = 'test-boq-client-a'
const OPP_A = 'test-boq-opp-a'
const EST_A = 'test-boq-est-a'
const LINE_A = 'test-boq-line-a'
const WD_A = 'test-boq-wd-a'
const WDV_A = 'test-boq-wdv-a'

const ctxA: RequestContext = {
  userId: USER_A,
  organizationId: ORG_A,
  role: 'estimator',
  isDemo: false,
  actorType: 'human',
  name: 'Test A',
  email: 'a@boq.test',
}
const ctxA_ai: RequestContext = { ...ctxA, actorType: 'ai' }
const ctxB: RequestContext = {
  userId: USER_B,
  organizationId: ORG_B,
  role: 'estimator',
  isDemo: false,
  actorType: 'human',
  name: 'Test B',
  email: 'b@boq.test',
}

// A fake parser that returns deterministic rows — no real XLSX needed.
const fakeParser = (_fileRef: string): Promise<RawBoqRow[]> =>
  Promise.resolve([
    {
      worksheet: 'BOQ',
      rowNumber: 1,
      description: 'PVC Conduit 25mm',
      code: 'WD-014',
      quantity: '150',
      unit: 'Mtrs',
      rate: 'GHS 12.00',
      amount: 1800,
    },
    {
      worksheet: 'BOQ',
      rowNumber: 2,
      description: 'Concrete work in foundation',
      code: null,
      quantity: 50,
      unit: 'm3',
      rate: 450,
      amount: 22500,
    },
    {
      worksheet: 'BOQ',
      rowNumber: 3,
      description: 'Unknown item',
      code: null,
      quantity: 1,
      unit: 'nr',
      rate: 99,
      amount: 99,
    },
  ])

describe('BOQ integration tests', () => {
  beforeAll(async () => {
    // Clean up any prior test data — strict FK order, scoped to test-boq-* IDs.
    // AuditLog has FK to organization, so it must be deleted before orgs.
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.boqBinding.deleteMany({ where: { boqItem: { boqImport: { organizationId: { startsWith: 'test-boq-' } } } } }).catch(() => {})
    await db.boqItem.deleteMany({ where: { boqImport: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.boqImport.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { id: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-boq-' } } }).catch(() => {})

    // Org A with an estimate + one line (the canonical binding target).
    await db.organization.create({ data: { id: ORG_A, name: 'BOQ Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@boq.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' } })
    await db.workDefinition.create({ data: { id: WD_A, organizationId: ORG_A, code: 'WD-014', name: 'PVC Conduit', unit: 'm' } })
    await db.workDefinitionVersion.create({
      data: { id: WDV_A, workDefinitionId: WD_A, version: 1, wastage: 0.05, costRecipeJson: '[]', approvalState: 'approved', hazardsJson: '[]', controlsJson: '[]', qualityChecklistJson: '[]' },
    })
    await db.estimateLine.create({
      data: {
        id: LINE_A,
        estimateId: EST_A,
        workDefinitionId: WD_A,
        workDefinitionVersionId: WDV_A,
        description: 'PVC conduit 25mm',
        quantity: 160,
        unit: 'm',
        executionStrategy: 'self-perform',
        unitRate: 10,
        sellPrice: 1600,
      },
    })

    // Org B (for tenant isolation tests).
    await db.organization.create({ data: { id: ORG_B, name: 'BOQ Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@boq.test', role: 'estimator' } })
  }, 120000)

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.boqBinding.deleteMany({ where: { boqItem: { boqImport: { organizationId: { startsWith: 'test-boq-' } } } } }).catch(() => {})
    await db.boqItem.deleteMany({ where: { boqImport: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.boqImport.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { id: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.estimateRevision.deleteMany({ where: { estimate: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.workDefinitionVersion.deleteMany({ where: { workDefinition: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.workDefinition.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-boq-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── Import ──────────────────────────────────────────────────────────────

  let importIdA: string

  test('createImport creates a pending import (tenant-scoped)', async () => {
    const res = await boqImportService.createImport({
      ctx: ctxA,
      opportunityId: OPP_A,
      fileReference: '/tmp/fake-boq.xlsx',
      fileName: 'client-boq.xlsx',
      fileHash: 'abc123hash',
      source: 'client',
    })
    expect(res.ok).toBe(true)
    expect(res.import.status).toBe('pending')
    importIdA = res.import.id
  })

  test('parseImport extracts items with raw* AND normalized* preserved', async () => {
    const res = await boqImportService.parseImport({
      ctx: ctxA,
      importId: importIdA,
      parseRows: fakeParser,
    })
    expect(res.ok).toBe(true)
    expect(res.itemCount).toBe(3)
    expect(res.status).toBe('parsed')

    // Verify raw + normalized are both persisted.
    const imp = await boqImportService.getImport(ctxA, importIdA)
    const item1 = imp!.items.find((i) => i.rowNumber === 1)!
    expect(item1.rawDescription).toBe('PVC Conduit 25mm') // raw verbatim
    expect(item1.rawCode).toBe('WD-014')
    expect(item1.rawUnit).toBe('Mtrs')
    expect(item1.rawRate).toBe(12)
    expect(item1.normalizedDescription).toBe('pvc conduit 25mm') // normalized
    expect(item1.normalizedCode).toBe('WD014')
    expect(item1.normalizedUnit).toBe('m')
    expect(item1.normalizedRate).toBe(12)
    // provenance recorded
    const prov = JSON.parse(item1.provenanceJson)
    expect(prov.importId).toBe(importIdA)
    expect(prov.rowNumber).toBe(1)
    expect(prov.source).toBe('client')
  }, 30000)

  test('fileHash detects prior import of the same workbook', async () => {
    // Create a second import with the same hash.
    const res2 = await boqImportService.createImport({
      ctx: ctxA,
      fileReference: '/tmp/renamed-boq.xlsx',
      fileName: 'renamed.xlsx',
      fileHash: 'abc123hash',
    })
    const prior = await boqImportService.listImports(ctxA)
    // findByHash is available on the repository.
    const { boqImportRepository } = await import('../../src/repositories')
    const found = await boqImportRepository.findByHash(ORG_A, 'abc123hash')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(res2.import.id) // most recent
  }, 30000)

  // ── Binding ─────────────────────────────────────────────────────────────

  test('suggestBindings generates candidates (deterministic)', async () => {
    const res = await boqBindingService.suggestBindings({
      ctx: ctxA,
      importId: importIdA,
      canonicalLines: [
        {
          estimateLineId: LINE_A,
          estimateId: EST_A,
          description: 'PVC conduit 25mm',
          unit: 'm',
          quantity: 160,
          unitRate: 10,
          workDefinitionCode: 'WD-014',
        },
      ],
    })
    expect(res.ok).toBe(true)
    // The PVC conduit row (row 1) should match via CODE_EXACT or DESCRIPTION_UNIT.
    const row1 = res.suggestions.find((s) => s.rawDescription === 'PVC Conduit 25mm')!
    expect(row1.suggestedStatus).toBe('MATCHED')
    expect(row1.candidates.length).toBeGreaterThanOrEqual(1)
    expect(['CODE_EXACT', 'DESCRIPTION_UNIT_EXACT']).toContain(row1.suggestedMethod)
    // The unknown item should be UNMATCHED.
    const row3 = res.suggestions.find((s) => s.rawDescription === 'Unknown item')!
    expect(row3.suggestedStatus).toBe('UNMATCHED')
  })

  test('confirmBinding is human-only — AI actor rejected', async () => {
    let aiItem = await boqImportService.getImport(ctxA, importIdA)
    const firstItemId = aiItem!.items[0].id
    await expect(
      boqBindingService.confirmBinding({
        ctx: ctxA_ai,
        boqItemId: firstItemId,
        estimateLineId: LINE_A,
        matchMethod: 'CODE_EXACT',
      }),
    ).rejects.toThrow(/human actor/i)
  })

  test('confirmBinding (human) links BoqItem to EstimateLine', async () => {
    const imp = await boqImportService.getImport(ctxA, importIdA)
    const item1 = imp!.items.find((i) => i.rowNumber === 1)!
    const res = await boqBindingService.confirmBinding({
      ctx: ctxA,
      boqItemId: item1.id,
      estimateLineId: LINE_A,
      matchMethod: 'CODE_EXACT',
    })
    expect(res.ok).toBe(true)
    expect(res.binding.status).toBe('MATCHED')
    expect(res.binding.estimateLineId).toBe(LINE_A)
  }, 30000)

  test('rejectBinding (human) marks an item REJECTED', async () => {
    const imp = await boqImportService.getImport(ctxA, importIdA)
    const item3 = imp!.items.find((i) => i.rowNumber === 3)!
    const res = await boqBindingService.rejectBinding({
      ctx: ctxA,
      boqItemId: item3.id,
      reason: 'not in scope',
    })
    expect(res.ok).toBe(true)
    expect(res.binding.status).toBe('REJECTED')
  })

  // ── Reconciliation ──────────────────────────────────────────────────────

  test('reconcileImport computes results (never stored as truth)', async () => {
    const res = await boqReconciliationService.reconcileImport({
      ctx: ctxA,
      importId: importIdA,
    })
    expect(res.ok).toBe(true)
    expect(res.results).toHaveLength(3)
    // The MATCHED item (row 1): qty 150 vs 160 → QTY_MISMATCH, rate 12 vs 10 → RATE_DIVERGENT.
    const matched = res.results.find((r) => r.bindingStatus === 'MATCHED')!
    expect(matched).toBeDefined()
    expect(matched.differences.some((d) => d.kind === 'QTY_MISMATCH')).toBe(true)
    expect(matched.differences.some((d) => d.kind === 'RATE_DIVERGENT')).toBe(true)
    const rateDiff = matched.differences.find((d) => d.kind === 'RATE_DIVERGENT')!
    expect(rateDiff.canonical).toBe(10) // canonical authoritative
    expect(rateDiff.external).toBe(12) // external observation
    // Summary
    expect(res.summary.total).toBe(3)
    expect(res.summary.matched).toBeGreaterThanOrEqual(1)
  })

  test('RATE_DIVERGENT never mutates EstimateLine', async () => {
    // The canonical line's unitRate must still be the original 10.
    const line = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(line!.unitRate).toBe(10)
    expect(line!.quantity).toBe(160)
  })

  // ── Tenant isolation ────────────────────────────────────────────────────

  test('Org B cannot read Org A import', async () => {
    await expect(boqImportService.getImport(ctxB, importIdA)).rejects.toThrow(/not found/i)
  })

  test('Org B cannot bind Org A items', async () => {
    const imp = await boqImportService.getImport(ctxA, importIdA)
    const item1 = imp!.items.find((i) => i.rowNumber === 1)!
    // The repository verifies the item belongs to the org.
    await expect(
      boqBindingService.confirmBinding({
        ctx: ctxB,
        boqItemId: item1.id,
        estimateLineId: LINE_A,
        matchMethod: 'MANUAL',
      }),
    ).rejects.toThrow(/not found in this organization/i)
  })

  test('Org B cannot reconcile Org A import', async () => {
    // reconcileImport lists items tenant-scoped → returns empty for Org B.
    const res = await boqReconciliationService.reconcileImport({
      ctx: ctxB,
      importId: importIdA,
    })
    expect(res.results).toHaveLength(0)
  })

  // ── Architecture audits ─────────────────────────────────────────────────

  test('BOQ services never import PricingEngine or estimate mutation', async () => {
    const fs = await import('node:fs')
    const files = [
      'src/application/boq-import-service.ts',
      'src/application/boq-binding-service.ts',
      'src/application/boq-reconciliation-service.ts',
      'src/repositories/boq-repositories.ts',
    ]
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      // Must NOT mutate EstimateLine or invoke the pricing engine.
      expect(src).not.toMatch(/estimateLine\.update|estimateLine\.upsert/i)
      expect(src).not.toMatch(/priceLine|finalizeRevision|computeConfidence/i)
    }
  })

  test('reconciliation is computed on demand, not persisted as truth', async () => {
    // There is NO BoqReconciliation model in the schema — the result is a
    // pure function output. Verify the schema has no such model.
    const fs = await import('node:fs')
    const schema = fs.readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).not.toMatch(/^model BoqReconciliation\b/m)
  })
}, 300000)
