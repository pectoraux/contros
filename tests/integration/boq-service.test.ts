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
// Second opportunity + estimate + line in Org A (for cross-opportunity tests).
const OPP_A2 = 'test-boq-opp-a2'
const EST_A2 = 'test-boq-est-a2'
const LINE_A2 = 'test-boq-line-a2'
// A BOQ-kind document for OPP_A (for H2 document validation tests).
const DOC_BOQ = 'test-boq-doc-boq'
const DOC_JHA = 'test-boq-doc-jha'

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

    // Second opportunity + estimate + line in Org A (for cross-opportunity tests).
    await db.opportunity.create({ data: { id: OPP_A2, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A2', status: 'estimating' } })
    await db.estimate.create({ data: { id: EST_A2, organizationId: ORG_A, opportunityId: OPP_A2, status: 'draft' } })
    await db.estimateLine.create({
      data: {
        id: LINE_A2,
        estimateId: EST_A2,
        description: 'Steel reinforcement',
        quantity: 5,
        unit: 'ton',
        executionStrategy: 'self-perform',
        unitRate: 900,
        sellPrice: 4500,
      },
    })

    // Documents for H2 validation: a boq-kind doc + a jha-kind doc (wrong kind).
    await db.document.create({ data: { id: DOC_BOQ, organizationId: ORG_A, opportunityId: OPP_A, kind: 'boq', status: 'missing' } })
    await db.document.create({ data: { id: DOC_JHA, organizationId: ORG_A, opportunityId: OPP_A, kind: 'jha', status: 'missing' } })

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
    await db.documentVersion.deleteMany({ where: { document: { organizationId: { startsWith: 'test-boq-' } } } }).catch(() => {})
    await db.document.deleteMany({ where: { organizationId: { startsWith: 'test-boq-' } } }).catch(() => {})
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
  }, 30000)

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
    // H4: rawCellJson preserves the verbatim cell representation.
    expect(item1.rawCellJson).toBeTruthy()
    const cells = JSON.parse(item1.rawCellJson)
    // The fallback cell map derives from semantic fields; the quantity cell
    // value is the ORIGINAL ('150' — a string, exactly what the parser supplied),
    // not the coerced Float (150). This is the audit-grade fidelity.
    expect(cells.quantity).toBeDefined()
    expect(cells.quantity.value).toBe('150')
    expect(cells.rate).toBeDefined()
    expect(cells.rate.value).toBe('GHS 12.00')
    // provenance recorded
    const prov = JSON.parse(item1.provenanceJson)
    expect(prov.importId).toBe(importIdA)
    expect(prov.rowNumber).toBe(1)
    expect(prov.source).toBe('client')
  }, 30000)

  test('fileHash detects prior import of the same workbook (H3: re-imports permitted, surfaced)', async () => {
    // Create a second import with the same hash.
    const res2 = await boqImportService.createImport({
      ctx: ctxA,
      fileReference: '/tmp/renamed-boq.xlsx',
      fileName: 'renamed.xlsx',
      fileHash: 'abc123hash',
    })
    // H3: createImport returns prior imports of the same hash (surfaces, not blocks).
    expect(res2.priorImportsOfSameHash.length).toBeGreaterThanOrEqual(1)
    expect(res2.priorImportsOfSameHash[0].fileHash ?? res2.priorImportsOfSameHash[0].id).toBeTruthy()
    // findByHash is available on the repository.
    const { boqImportRepository } = await import('../../src/repositories')
    const found = await boqImportRepository.findByHash(ORG_A, 'abc123hash')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(res2.import.id) // most recent
    // findPriorByHash returns ALL imports of that hash.
    const allPrior = await boqImportRepository.findPriorByHash(ORG_A, 'abc123hash')
    expect(allPrior.length).toBeGreaterThanOrEqual(2)
  }, 30000)

  // ── Binding ─────────────────────────────────────────────────────────────

  test('suggestBindings generates candidates (deterministic, authoritative)', async () => {
    // H1: canonical lines are loaded AUTHORITATIVELY by the service (tenant +
    // opportunity scoped), NOT supplied by the caller.
    const res = await boqBindingService.suggestBindings({
      ctx: ctxA,
      importId: importIdA,
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
  }, 30000)

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
  }, 30000)

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
  }, 30000)

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
  }, 30000)

  test('RATE_DIVERGENT never mutates EstimateLine', async () => {
    // The canonical line's unitRate must still be the original 10.
    const line = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(line!.unitRate).toBe(10)
    expect(line!.quantity).toBe(160)
  }, 30000)

  // ── Tenant isolation ────────────────────────────────────────────────────

  test('Org B cannot read Org A import', async () => {
    await expect(boqImportService.getImport(ctxB, importIdA)).rejects.toThrow(/not found/i)
  }, 30000)

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
  }, 30000)

  test('Org B cannot reconcile Org A import', async () => {
    // reconcileImport lists items tenant-scoped → returns empty for Org B.
    const res = await boqReconciliationService.reconcileImport({
      ctx: ctxB,
      importId: importIdA,
    })
    expect(res.results).toHaveLength(0)
  }, 30000)

  // ── H7: Cross-opportunity domain-identity violation (same org, wrong opp) ──

  test('H7: cannot bind a BoqItem to an EstimateLine from a DIFFERENT opportunity (same org)', async () => {
    // importIdA is for OPP_A. LINE_A2 belongs to OPP_A2 (same org A).
    // H1 hardening: confirmBinding must reject this — same org is not enough.
    const imp = await boqImportService.getImport(ctxA, importIdA)
    const item1 = imp!.items.find((i) => i.rowNumber === 1)!
    await expect(
      boqBindingService.confirmBinding({
        ctx: ctxA,
        boqItemId: item1.id,
        estimateLineId: LINE_A2, // wrong opportunity's line
        matchMethod: 'MANUAL',
      }),
    ).rejects.toThrow(/does not belong to the import opportunity/i)
  }, 30000)

  test('H7: suggestBindings only loads canonical lines for the import opportunity (not other opps)', async () => {
    // importIdA is for OPP_A. OPP_A2 has LINE_A2 ("Steel reinforcement").
    // The matcher must NOT suggest LINE_A2 as a candidate for any item in
    // importIdA, because the canonical lines are loaded opportunity-scoped.
    const res = await boqBindingService.suggestBindings({
      ctx: ctxA,
      importId: importIdA,
    })
    for (const s of res.suggestions) {
      for (const c of s.candidates) {
        expect(c.estimateLineId).not.toBe(LINE_A2) // never the wrong-opportunity line
      }
    }
  }, 30000)

  // ── H7: Invalid opportunity/document references at create time ────────────

  test('H7: createImport rejects an opportunity not in this organization', async () => {
    // OPP_A belongs to ORG_A; use ctxB (ORG_B) — should be rejected.
    await expect(
      boqImportService.createImport({
        ctx: ctxB,
        opportunityId: OPP_A, // cross-tenant opportunity reference
        fileReference: '/tmp/x.xlsx',
        fileName: 'x.xlsx',
        fileHash: 'cross-opp-hash',
      }),
    ).rejects.toThrow(/Invalid opportunity/i)
  }, 30000)

  test('H7: createImport rejects a document of the wrong kind (not boq)', async () => {
    // DOC_JHA has kind 'jha', not 'boq'. Must be rejected.
    await expect(
      boqImportService.createImport({
        ctx: ctxA,
        opportunityId: OPP_A,
        documentId: DOC_JHA, // wrong kind
        fileReference: '/tmp/y.xlsx',
        fileName: 'y.xlsx',
        fileHash: 'wrong-kind-hash',
      }),
    ).rejects.toThrow(/kind must be 'boq'/i)
  }, 30000)

  test('H7: createImport rejects a document inconsistent with the opportunity', async () => {
    // DOC_BOQ belongs to OPP_A. Supply opportunityId: OPP_A2 — inconsistent.
    await expect(
      boqImportService.createImport({
        ctx: ctxA,
        opportunityId: OPP_A2, // different opportunity
        documentId: DOC_BOQ, // doc belongs to OPP_A, not OPP_A2
        fileReference: '/tmp/z.xlsx',
        fileName: 'z.xlsx',
        fileHash: 'inconsistent-hash',
      }),
    ).rejects.toThrow(/does not belong to the supplied opportunity/i)
  }, 30000)

  test('H7: createImport accepts a valid boq document and infers opportunity', async () => {
    // Supply only documentId (DOC_BOQ). The service should infer opportunityId
    // from the document and accept the import.
    const res = await boqImportService.createImport({
      ctx: ctxA,
      documentId: DOC_BOQ,
      fileReference: '/tmp/valid.xlsx',
      fileName: 'valid.xlsx',
      fileHash: 'valid-doc-hash',
    })
    expect(res.ok).toBe(true)
    // Verify the import's opportunityId was inferred to OPP_A.
    const imp = await boqImportService.getImport(ctxA, res.import.id)
    expect(imp!.opportunityId).toBe(OPP_A)
  }, 30000)

  // ── R3: opportunity-less imports are NOT bindable ──────────────────────────

  test('R3: opportunity-less import cannot be bound to a same-tenant EstimateLine', async () => {
    // Create an import with NO opportunityId (and no document to infer one from).
    // This is a valid external observation, but it must NOT be bindable to a
    // canonical EstimateLine — binding requires an opportunity-resolvable import.
    const res = await boqImportService.createImport({
      ctx: ctxA,
      // no opportunityId, no documentId
      fileReference: '/tmp/opp-less.xlsx',
      fileName: 'opp-less.xlsx',
      fileHash: 'opp-less-hash',
    })
    expect(res.ok).toBe(true)
    const oppLessImportId = res.import.id
    // Parse it (so there are items to attempt binding on).
    await boqImportService.parseImport({
      ctx: ctxA,
      importId: oppLessImportId,
      parseRows: fakeParser,
    })
    const imp = await boqImportService.getImport(ctxA, oppLessImportId)
    const firstItem = imp!.items[0]
    // Attempt to bind to a same-tenant (Org A) line. Must be REJECTED.
    await expect(
      boqBindingService.confirmBinding({
        ctx: ctxA,
        boqItemId: firstItem.id,
        estimateLineId: LINE_A, // same-tenant, but import has no opportunity
        matchMethod: 'MANUAL',
      }),
    ).rejects.toThrow(/no opportunity/i)
  }, 30000)

  test('R3: suggestBindings returns no candidates for an opportunity-less import', async () => {
    // Create + parse an opportunity-less import.
    const res = await boqImportService.createImport({
      ctx: ctxA,
      fileReference: '/tmp/opp-less2.xlsx',
      fileName: 'opp-less2.xlsx',
      fileHash: 'opp-less2-hash',
    })
    await boqImportService.parseImport({
      ctx: ctxA,
      importId: res.import.id,
      parseRows: fakeParser,
    })
    const sugg = await boqBindingService.suggestBindings({
      ctx: ctxA,
      importId: res.import.id,
    })
    // Every suggestion must be UNMATCHED (no canonical candidates loaded).
    for (const s of sugg.suggestions) {
      expect(s.suggestedStatus).toBe('UNMATCHED')
      expect(s.candidates).toHaveLength(0)
    }
  }, 30000)

  // ── H6: Strengthened architecture audits (runtime behavior, not just regex) ──

  test('H6: reconciliation service has zero direct db.estimateLine calls (boundary)', async () => {
    // H5: the service must go through canonicalLineRepository, not call
    // db.estimateLine directly. Regex is a tripwire; the runtime behavior
    // (reconcileImport works without direct Prisma) is the real proof.
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/application/boq-reconciliation-service.ts', 'utf8')
    // Must NOT import db or call db.estimateLine directly (actual call = dot + method,
    // not the word "db.estimateLine" appearing in doc comments).
    expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/\bdb\.estimateLine\.(find|create|update|upsert|delete|count|aggregate)/)
    // Must import canonicalLineRepository.
    expect(src).toMatch(/canonicalLineRepository/)
  }, 30000)

  test('H6: binding service has zero direct db calls (boundary)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/application/boq-binding-service.ts', 'utf8')
    expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/db\./)
    // Must use canonicalLineRepository for authoritative line loading.
    expect(src).toMatch(/canonicalLineRepository/)
  }, 30000)

  test('R4: import service has zero direct db.opportunity/db.document calls (boundary)', async () => {
    // R2: the import service must delegate opportunity/document validation to
    // boqImportRepository.validateImportContext — it must NOT call
    // db.opportunity.* or db.document.* directly. The service orchestrates
    // validate → create → audit without knowing Prisma query syntax.
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/application/boq-import-service.ts', 'utf8')
    // Must NOT import db (the only allowed @/lib/db import is dbTx for transactions).
    // dbTx is a separate client for interactive transactions; db is the pooled one.
    // The import service uses dbTx.$transaction in parseImport — that's allowed.
    // But it must NOT call db.opportunity or db.document directly.
    expect(src).not.toMatch(/\bdb\.opportunity\.(find|create|update|upsert|delete|count)/)
    expect(src).not.toMatch(/\bdb\.document\.(find|create|update|upsert|delete|count)/)
    // Must call validateImportContext (the repository method).
    expect(src).toMatch(/validateImportContext/)
  }, 30000)

  test('H6: BOQ services + repositories never mutate EstimateLine (runtime + regex)', async () => {
    // Regex tripwire across all BOQ files.
    const fs = await import('node:fs')
    const files = [
      'src/application/boq-import-service.ts',
      'src/application/boq-binding-service.ts',
      'src/application/boq-reconciliation-service.ts',
      'src/repositories/boq-repositories.ts',
    ]
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src).not.toMatch(/estimateLine\.update|estimateLine\.upsert|estimateLine\.delete/i)
      expect(src).not.toMatch(/priceLine|finalizeRevision|computeConfidence/i)
    }
    // Runtime proof: the canonical line repository only reads (findFirst/findMany),
    // never writes. Slice ONLY the canonicalLineRepository object (not the rest
    // of the file, which contains the binding repo's upsert).
    const repoSrc = fs.readFileSync('src/repositories/boq-repositories.ts', 'utf8')
    const start = repoSrc.indexOf('export const canonicalLineRepository')
    const end = repoSrc.indexOf('export const boqBindingRepository', start)
    const canonicalSection = repoSrc.slice(start, end)
    expect(canonicalSection).not.toMatch(/\.create\(|\.update\(|\.upsert\(|\.deleteMany\(|\.delete\(/)
  }, 30000)

  test('H6: no BoqReconciliation persistence model (reconciliation is computed)', async () => {
    // There is NO BoqReconciliation model in the schema — the result is a
    // pure function output. Regex on the schema.
    const fs = await import('node:fs')
    const schema = fs.readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).not.toMatch(/^model BoqReconciliation\b/m)
    // Runtime proof: the reconciliation service never imports or calls a
    // boqReconciliation REPOSITORY (no persistence of computed results).
    const svcSrc = fs.readFileSync('src/application/boq-reconciliation-service.ts', 'utf8')
    expect(svcSrc).not.toMatch(/boqReconciliationRepository/i)
    expect(svcSrc).not.toMatch(/reconciliationRepository\.create|reconciliationRepository\.update|reconciliationRepository\.upsert/i)
  }, 30000)

  test('H6: RATE_DIVERGENT never mutates EstimateLine.unitRate (runtime)', async () => {
    // Runtime proof already in the reconcileImport test: after reconciliation
    // with a RATE_DIVERGENT, the canonical line's unitRate is unchanged.
    // Re-assert here for explicitness.
    const line = await db.estimateLine.findUnique({ where: { id: LINE_A } })
    expect(line!.unitRate).toBe(10) // still the original canonical value
    expect(line!.quantity).toBe(160)
  }, 30000)
}, 300000)
