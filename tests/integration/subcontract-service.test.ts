/**
 * SubcontractService integration tests — REAL adversarial tests with actual
 * Neon DB data.
 *
 * Two test groups:
 *   1. Cross-tenant isolation: Org A cannot operate on Org B's subcontract data
 *      (and vice versa).
 *   2. Commercial adversarial: lump-sum, exclusions, low coverage, invalid
 *      inputs, illegal state transitions, approved-exception override.
 *
 * Run: bun test tests/integration/subcontract-service.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { subcontractService } from '../../src/application/subcontract-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

// ─── Test fixture IDs (fixed for reproducibility) ───────────────────────────

const ORG_A = 'test-sc-org-a'
const ORG_B = 'test-sc-org-b'
const USER_A = 'test-sc-user-a'
const USER_B = 'test-sc-user-b'
const CLIENT_A = 'test-sc-client-a'
const CLIENT_B = 'test-sc-client-b'
const OPP_A = 'test-sc-opp-a'
const OPP_B = 'test-sc-opp-b'
const EST_A = 'test-sc-est-a'
const EST_B = 'test-sc-est-b'
const LINE_A = 'test-sc-line-a'
const LINE_B = 'test-sc-line-b'

// Cross-tenant test packages
const PKG_A = 'test-sc-pkg-a'
const PKG_B = 'test-sc-pkg-b'
const ATOM_A1 = 'test-sc-atom-a1'
const ATOM_B1 = 'test-sc-atom-b1'
const QUOTE_B = 'test-sc-quote-b' // Org B's quote (target of cross-tenant attack)
const QUOTE_A_SHARED = 'test-sc-quote-a-shared' // Org A's quote

// Per-test commercial packages (all in Org A, created fresh per test).
// Use distinct prefixes so afterAll cleanup-by-org catches everything.
const PKG_LUMPSUM = 'test-sc-pkg-lumpsum'
const PKG_EXCLUDED = 'test-sc-pkg-excluded'
const PKG_FULL = 'test-sc-pkg-full'
const PKG_LOWCOV = 'test-sc-pkg-lowcov'
const PKG_EXCEPTION = 'test-sc-pkg-exception'
const PKG_STATE = 'test-sc-pkg-state'

const ctxA: RequestContext = {
  userId: USER_A,
  organizationId: ORG_A,
  role: 'estimator',
  isDemo: false,
  name: 'Test User A',
  email: 'a-sc@test.com',
}

const ctxB: RequestContext = {
  userId: USER_B,
  organizationId: ORG_B,
  role: 'estimator',
  isDemo: false,
  name: 'Test User B',
  email: 'b-sc@test.com',
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wipe all subcontract test data for the two test orgs (robust to partial failures). */
async function cleanupOrgData() {
  // 1. Fetch all package IDs for the two orgs (and any test-sc prefixed packages,
  //    in case a previous run left data with a different org assignment).
  const packages = await db.subcontractPackage.findMany({
    where: {
      OR: [
        { organizationId: { in: [ORG_A, ORG_B] } },
        { id: { startsWith: 'test-sc-' } },
      ],
    },
    select: { id: true },
  })
  const packageIds = packages.map((p) => p.id)

  if (packageIds.length > 0) {
    // 2. Delete children by packageId (direct scalar filter — more reliable
    //    than relation filters, which can miss orphaned records).
    await db.quoteScopeCoverage.deleteMany({
      where: { quote: { subcontractPackageId: { in: packageIds } } },
    })
    await db.subcontractQuoteLine.deleteMany({
      where: { quote: { subcontractPackageId: { in: packageIds } } },
    })
    await db.subcontractQuote.deleteMany({
      where: { subcontractPackageId: { in: packageIds } },
    })
    await db.scopeAtom.deleteMany({
      where: { subcontractPackageId: { in: packageIds } },
    })
    await db.subcontractPackageLine.deleteMany({
      where: { subcontractPackageId: { in: packageIds } },
    })
    await db.subcontractPackage.deleteMany({
      where: { id: { in: packageIds } },
    })
  }

  // 3. Clean up any orphaned subcontract records with test-sc prefix (defensive).
  await db.subcontractQuote.deleteMany({ where: { id: { startsWith: 'test-sc-' } } })
  await db.scopeAtom.deleteMany({ where: { id: { startsWith: 'test-sc-' } } })

  // 4. Delete the rest by orgId.
  await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await db.commercialException.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await db.estimateLine.deleteMany({ where: { id: { in: [LINE_A, LINE_B] } } })
  await db.estimate.deleteMany({ where: { id: { in: [EST_A, EST_B] } } })
  await db.opportunity.deleteMany({ where: { id: { in: [OPP_A, OPP_B] } } })
  await db.client.deleteMany({ where: { id: { in: [CLIENT_A, CLIENT_B] } } })
  await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
  await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
}

/** Create a package + atoms directly in the DB (for test setup). */
async function createPackageWithAtoms(
  orgId: string,
  packageId: string,
  opportunityId: string,
  atoms: Array<{ id: string; name: string; valueWeight: number }>,
) {
  await db.subcontractPackage.create({
    data: {
      id: packageId,
      organizationId: orgId,
      opportunityId,
      name: `Test Package ${packageId}`,
      executionStrategy: 'subcontract',
    },
  })
  for (const a of atoms) {
    await db.scopeAtom.create({
      data: {
        id: a.id,
        subcontractPackageId: packageId,
        name: a.name,
        valueWeight: a.valueWeight,
      },
    })
  }
}

/** Create a quote + coverages directly in the DB (for test setup). */
async function createQuoteWithCoverages(
  orgId: string,
  packageId: string,
  quoteId: string,
  supplierName: string,
  totalAmount: number,
  coverages: Array<{ atomId: string; status: 'covered' | 'excluded' | 'unstated' }>,
) {
  await db.subcontractQuote.create({
    data: {
      id: quoteId,
      subcontractPackageId: packageId,
      supplierName,
      totalAmount,
      currency: 'GHS',
    },
  })
  for (const c of coverages) {
    await db.quoteScopeCoverage.create({
      data: {
        quoteId,
        scopeAtomId: c.atomId,
        status: c.status,
      },
    })
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('SubcontractService integration tests', () => {
  beforeAll(async () => {
    // Clean up any stale test data first.
    await cleanupOrgData()

    // Create Org A.
    await db.organization.create({ data: { id: ORG_A, name: 'SC Org A', currency: 'GHS' } })
    await db.user.create({
      data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a-sc@test.com', role: 'estimator' },
    })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({
      data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' },
    })
    await db.estimate.create({
      data: { id: EST_A, organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' },
    })
    await db.estimateLine.create({
      data: {
        id: LINE_A,
        estimateId: EST_A,
        description: 'Line A',
        quantity: 100,
        unit: 'm2',
        executionStrategy: 'self-perform',
        sellPrice: 50000,
      },
    })

    // Create Org B.
    await db.organization.create({ data: { id: ORG_B, name: 'SC Org B', currency: 'GHS' } })
    await db.user.create({
      data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b-sc@test.com', role: 'estimator' },
    })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({
      data: { id: OPP_B, organizationId: ORG_B, clientId: CLIENT_B, title: 'Opp B', status: 'estimating' },
    })
    await db.estimate.create({
      data: { id: EST_B, organizationId: ORG_B, opportunityId: OPP_B, status: 'draft' },
    })
    await db.estimateLine.create({
      data: {
        id: LINE_B,
        estimateId: EST_B,
        description: 'Line B',
        quantity: 50,
        unit: 'm2',
        executionStrategy: 'self-perform',
        sellPrice: 30000,
      },
    })

    // Cross-tenant test data.
    // Org A: package with 1 scope atom + 1 quote.
    await createPackageWithAtoms(ORG_A, PKG_A, OPP_A, [
      { id: ATOM_A1, name: 'installation', valueWeight: 1.0 },
    ])
    await createQuoteWithCoverages(ORG_A, PKG_A, QUOTE_A_SHARED, 'Supplier A Shared', 40000, [
      { atomId: ATOM_A1, status: 'covered' },
    ])

    // Org B: package with 1 scope atom + 1 quote (target of cross-tenant attack).
    await createPackageWithAtoms(ORG_B, PKG_B, OPP_B, [
      { id: ATOM_B1, name: 'manufacture', valueWeight: 1.0 },
    ])
    await createQuoteWithCoverages(ORG_B, PKG_B, QUOTE_B, 'Supplier B Secret', 99999, [
      { atomId: ATOM_B1, status: 'covered' },
    ])
  }, 120000)

  afterAll(async () => {
    await cleanupOrgData()
    await db.$disconnect()
  }, 120000)

  // ─── Cross-tenant tests ─────────────────────────────────────────────────

  test('Org A cannot read Org B package workspace', async () => {
    const result = await subcontractService.getPackageWorkspace({
      ctx: ctxA,
      opportunityId: OPP_B, // Org B's opportunity
    })
    // The service returns an empty package list (Org A has no packages in OPP_B).
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Org A sees zero packages in Org B's opportunity — the packages belong
      // to Org B and the repository scopes them out.
      expect(result.packages.length).toBe(0)
      // Org B's quote amount (99999) must NOT appear.
      const allQuotes = result.packages.flatMap((p) => p.quotes)
      expect(allQuotes.some((q) => q.totalAmount === 99999)).toBe(false)
    }
  }, 60000)

  test('Org A cannot create a quote on Org B package', async () => {
    const result = await subcontractService.recordQuote({
      ctx: ctxA,
      packageId: PKG_B, // Org B's package
      supplierName: 'Attacker Supplier',
      totalAmount: 1,
      currency: 'GHS',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // 404 — the package doesn't exist in Org A.
      expect(result.status).toBe(404)
    }
    // Verify no quote was actually created on Org B's package.
    const quotesOnB = await db.subcontractQuote.findMany({
      where: { subcontractPackageId: PKG_B, supplierName: 'Attacker Supplier' },
    })
    expect(quotesOnB.length).toBe(0)
  }, 60000)

  test('Org A cannot select Org B quote', async () => {
    const result = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_B, // Org B's package
      quoteId: QUOTE_B,  // Org B's quote
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
    // Verify Org B's package was NOT awarded to Org A's selection.
    const pkgB = await db.subcontractPackage.findUnique({ where: { id: PKG_B } })
    expect(pkgB?.status).not.toBe('awarded')
    expect(pkgB?.selectedQuoteId).not.toBe(QUOTE_B)
  }, 60000)

  test('Org A cannot create a scope atom on Org B package', async () => {
    const result = await subcontractService.createScopeAtom({
      ctx: ctxA,
      packageId: PKG_B, // Org B's package
      name: 'Attacker Atom',
      valueWeight: 0.5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
    // Verify no atom was created on Org B's package.
    const atomsOnB = await db.scopeAtom.findMany({
      where: { subcontractPackageId: PKG_B, name: 'Attacker Atom' },
    })
    expect(atomsOnB.length).toBe(0)
  }, 60000)

  test('Inverse: Org B cannot read Org A package workspace', async () => {
    const result = await subcontractService.getPackageWorkspace({
      ctx: ctxB,
      opportunityId: OPP_A, // Org A's opportunity
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.packages.length).toBe(0)
      const allQuotes = result.packages.flatMap((p) => p.quotes)
      // Org A's quote amount (40000) must NOT appear to Org B.
      expect(allQuotes.some((q) => q.totalAmount === 40000)).toBe(false)
    }
  }, 60000)

  // ─── Commercial adversarial tests ───────────────────────────────────────

  test('Lump-sum quote (no scope coverages) → reconciliation blocker, selection rejected', async () => {
    // Package with 3 scope atoms but the quote has NO scope coverages (lump-sum).
    await createPackageWithAtoms(ORG_A, PKG_LUMPSUM, OPP_A, [
      { id: 'test-sc-atom-lumpsum-1', name: 'manufacture', valueWeight: 0.34 },
      { id: 'test-sc-atom-lumpsum-2', name: 'delivery', valueWeight: 0.33 },
      { id: 'test-sc-atom-lumpsum-3', name: 'installation', valueWeight: 0.33 },
    ])
    // Lump-sum quote: no coverages.
    await db.subcontractQuote.create({
      data: {
        id: 'test-sc-quote-lumpsum',
        subcontractPackageId: PKG_LUMPSUM,
        supplierName: 'Lump Sum Supplier',
        totalAmount: 45000,
        currency: 'GHS',
      },
    })

    // Reconcile — should return blocker.
    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: PKG_LUMPSUM,
      quoteId: 'test-sc-quote-lumpsum',
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      expect(reconResult.reconciliation.isLumpSum).toBe(true)
      expect(reconResult.reconciliation.status).toBe('blocker')
      expect(reconResult.reconciliation.coverageBasis).toBe('lump-sum')
    }

    // Attempt selection — should be rejected.
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_LUMPSUM,
      quoteId: 'test-sc-quote-lumpsum',
    })
    expect(selectResult.ok).toBe(false)
    if (!selectResult.ok) {
      expect(selectResult.status).toBe(400)
      expect(selectResult.error).toContain('lump-sum')
    }
    // Verify package was NOT awarded.
    const pkg = await db.subcontractPackage.findUnique({ where: { id: PKG_LUMPSUM } })
    expect(pkg?.status).not.toBe('awarded')
    expect(pkg?.selectedQuoteId).toBeNull()
  }, 60000)

  test('Quote with excluded critical atom → reconciliation blocker, selection rejected', async () => {
    // Package with 3 atoms. Quote covers 2, excludes 1 (critical).
    await createPackageWithAtoms(ORG_A, PKG_EXCLUDED, OPP_A, [
      { id: 'test-sc-atom-excl-1', name: 'manufacture', valueWeight: 0.34 },
      { id: 'test-sc-atom-excl-2', name: 'delivery', valueWeight: 0.33 },
      { id: 'test-sc-atom-excl-3', name: 'installation', valueWeight: 0.33 },
    ])
    await createQuoteWithCoverages(
      ORG_A,
      PKG_EXCLUDED,
      'test-sc-quote-excl',
      'Excluding Supplier',
      42000,
      [
        { atomId: 'test-sc-atom-excl-1', status: 'covered' },
        { atomId: 'test-sc-atom-excl-2', status: 'covered' },
        { atomId: 'test-sc-atom-excl-3', status: 'excluded' }, // critical atom excluded
      ],
    )

    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: PKG_EXCLUDED,
      quoteId: 'test-sc-quote-excl',
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      expect(reconResult.reconciliation.excludedAtoms.length).toBe(1)
      expect(reconResult.reconciliation.excludedAtoms).toContain('installation')
      expect(reconResult.reconciliation.status).toBe('blocker')
      // Economic coverage = (0.34 + 0.33) / (0.34 + 0.33 + 0.33) = 0.67 / 1.0 = 0.67
      expect(reconResult.reconciliation.coveragePct).toBeLessThan(0.8)
    }

    // Attempt selection — should be rejected (both exclusion AND low coverage).
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_EXCLUDED,
      quoteId: 'test-sc-quote-excl',
    })
    expect(selectResult.ok).toBe(false)
    if (!selectResult.ok) {
      expect(selectResult.status).toBe(400)
      expect(selectResult.error).toContain('excludes')
    }
    const pkg = await db.subcontractPackage.findUnique({ where: { id: PKG_EXCLUDED } })
    expect(pkg?.status).not.toBe('awarded')
  }, 60000)

  test('Quote with full coverage → selection succeeds', async () => {
    // Package with 3 atoms. Quote covers all 3.
    await createPackageWithAtoms(ORG_A, PKG_FULL, OPP_A, [
      { id: 'test-sc-atom-full-1', name: 'manufacture', valueWeight: 0.34 },
      { id: 'test-sc-atom-full-2', name: 'delivery', valueWeight: 0.33 },
      { id: 'test-sc-atom-full-3', name: 'installation', valueWeight: 0.33 },
    ])
    await createQuoteWithCoverages(
      ORG_A,
      PKG_FULL,
      'test-sc-quote-full',
      'Full Coverage Supplier',
      48000,
      [
        { atomId: 'test-sc-atom-full-1', status: 'covered' },
        { atomId: 'test-sc-atom-full-2', status: 'covered' },
        { atomId: 'test-sc-atom-full-3', status: 'covered' },
      ],
    )

    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: PKG_FULL,
      quoteId: 'test-sc-quote-full',
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      expect(reconResult.reconciliation.coveragePct).toBe(1)
      expect(reconResult.reconciliation.status).toBe('ok')
      expect(reconResult.reconciliation.excludedAtoms.length).toBe(0)
      expect(reconResult.reconciliation.isLumpSum).toBe(false)
    }

    // Attempt selection — should succeed.
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_FULL,
      quoteId: 'test-sc-quote-full',
    })
    expect(selectResult.ok).toBe(true)
    if (selectResult.ok) {
      expect(selectResult.packageStatus).toBe('awarded')
      expect(selectResult.selectedQuoteId).toBe('test-sc-quote-full')
    }

    // Verify the package + quote were updated atomically.
    const pkg = await db.subcontractPackage.findUnique({ where: { id: PKG_FULL } })
    expect(pkg?.status).toBe('awarded')
    expect(pkg?.selectedQuoteId).toBe('test-sc-quote-full')
    const quote = await db.subcontractQuote.findUnique({ where: { id: 'test-sc-quote-full' } })
    expect(quote?.status).toBe('selected')
    // The coveragePct should be persisted on the quote (for downstream use).
    expect(quote?.coveragePct).toBe(1)

    // Verify an audit log entry was created.
    const audit = await db.auditLog.findFirst({
      where: {
        organizationId: ORG_A,
        action: 'subcontract.quote-selected',
        entityId: PKG_FULL,
      },
    })
    expect(audit).not.toBeNull()
  }, 60000)

  test('Invalid valueWeight > 1 → rejected', async () => {
    const result = await subcontractService.createScopeAtom({
      ctx: ctxA,
      packageId: PKG_A, // valid package in Org A
      name: 'Bad Weight High',
      valueWeight: 1.5, // > 1 — invalid
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('valueWeight')
    }
    // Verify no atom was created.
    const atom = await db.scopeAtom.findFirst({
      where: { subcontractPackageId: PKG_A, name: 'Bad Weight High' },
    })
    expect(atom).toBeNull()
  }, 60000)

  test('Invalid valueWeight < 0 → rejected', async () => {
    const result = await subcontractService.createScopeAtom({
      ctx: ctxA,
      packageId: PKG_A,
      name: 'Bad Weight Low',
      valueWeight: -0.1, // < 0 — invalid
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('valueWeight')
    }
    const atom = await db.scopeAtom.findFirst({
      where: { subcontractPackageId: PKG_A, name: 'Bad Weight Low' },
    })
    expect(atom).toBeNull()
  }, 60000)

  test('Negative quote amount → rejected', async () => {
    const result = await subcontractService.recordQuote({
      ctx: ctxA,
      packageId: PKG_A,
      supplierName: 'Negative Amount Supplier',
      totalAmount: -100, // negative — invalid
      currency: 'GHS',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('totalAmount')
    }
    // Verify no quote was created.
    const quote = await db.subcontractQuote.findFirst({
      where: { subcontractPackageId: PKG_A, supplierName: 'Negative Amount Supplier' },
    })
    expect(quote).toBeNull()
  }, 60000)

  test('Select quote with coverage < 80% → rejected', async () => {
    // Package with 3 atoms. Quote covers only 1 (weight 0.34 → coverage 0.34 < 0.8).
    await createPackageWithAtoms(ORG_A, PKG_LOWCOV, OPP_A, [
      { id: 'test-sc-atom-low-1', name: 'manufacture', valueWeight: 0.34 },
      { id: 'test-sc-atom-low-2', name: 'delivery', valueWeight: 0.33 },
      { id: 'test-sc-atom-low-3', name: 'installation', valueWeight: 0.33 },
    ])
    await createQuoteWithCoverages(
      ORG_A,
      PKG_LOWCOV,
      'test-sc-quote-low',
      'Low Coverage Supplier',
      30000,
      [
        { atomId: 'test-sc-atom-low-1', status: 'covered' },
        { atomId: 'test-sc-atom-low-2', status: 'unstated' },
        { atomId: 'test-sc-atom-low-3', status: 'unstated' },
      ],
    )

    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: PKG_LOWCOV,
      quoteId: 'test-sc-quote-low',
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      // Economic coverage = 0.34 / 1.0 = 0.34
      expect(reconResult.reconciliation.coveragePct).toBeLessThan(0.8)
      expect(reconResult.reconciliation.status).toBe('blocker')
      expect(reconResult.reconciliation.excludedAtoms.length).toBe(0) // not excluded, just unstated
    }

    // Attempt selection — should be rejected (low coverage).
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_LOWCOV,
      quoteId: 'test-sc-quote-low',
    })
    expect(selectResult.ok).toBe(false)
    if (!selectResult.ok) {
      expect(selectResult.status).toBe(400)
      expect(selectResult.error).toContain('80%')
    }
    const pkg = await db.subcontractPackage.findUnique({ where: { id: PKG_LOWCOV } })
    expect(pkg?.status).not.toBe('awarded')
  }, 60000)

  test('Select quote with approved CommercialException → allowed', async () => {
    // Same setup as the low-coverage test, but with an approved exception.
    await createPackageWithAtoms(ORG_A, PKG_EXCEPTION, OPP_A, [
      { id: 'test-sc-atom-exc-1', name: 'manufacture', valueWeight: 0.34 },
      { id: 'test-sc-atom-exc-2', name: 'delivery', valueWeight: 0.33 },
      { id: 'test-sc-atom-exc-3', name: 'installation', valueWeight: 0.33 },
    ])
    await createQuoteWithCoverages(
      ORG_A,
      PKG_EXCEPTION,
      'test-sc-quote-exc',
      'Exception Supplier',
      32000,
      [
        { atomId: 'test-sc-atom-exc-1', status: 'covered' },
        { atomId: 'test-sc-atom-exc-2', status: 'unstated' },
        { atomId: 'test-sc-atom-exc-3', status: 'unstated' },
      ],
    )

    // Create an APPROVED CommercialException for this quote.
    await db.commercialException.create({
      data: {
        organizationId: ORG_A,
        entityType: 'subcontract-quote',
        entityId: 'test-sc-quote-exc',
        type: 'low-coverage-override',
        reason: 'Director approved low coverage due to single-source supplier constraint',
        exposure: 30000,
        approvalRequired: true,
        approvedById: USER_A,
        approvedAt: new Date(),
      },
    })

    // Reconcile first — should still be a blocker (low coverage).
    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: PKG_EXCEPTION,
      quoteId: 'test-sc-quote-exc',
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      expect(reconResult.reconciliation.coveragePct).toBeLessThan(0.8)
      expect(reconResult.reconciliation.status).toBe('blocker')
    }

    // Attempt selection — should SUCCEED because of the approved exception.
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_EXCEPTION,
      quoteId: 'test-sc-quote-exc',
    })
    expect(selectResult.ok).toBe(true)
    if (selectResult.ok) {
      expect(selectResult.packageStatus).toBe('awarded')
    }

    // Verify the package + quote were awarded.
    const pkg = await db.subcontractPackage.findUnique({ where: { id: PKG_EXCEPTION } })
    expect(pkg?.status).toBe('awarded')
    expect(pkg?.selectedQuoteId).toBe('test-sc-quote-exc')
    const quote = await db.subcontractQuote.findUnique({ where: { id: 'test-sc-quote-exc' } })
    expect(quote?.status).toBe('selected')

    // Verify the audit log notes the exception override.
    const audit = await db.auditLog.findFirst({
      where: {
        organizationId: ORG_A,
        action: 'subcontract.quote-selected',
        entityId: PKG_EXCEPTION,
      },
    })
    expect(audit).not.toBeNull()
    expect(audit?.summary).toContain('approved exception')
  }, 60000)

  test('Illegal state transition (awarded → draft) → rejected', async () => {
    // Setup: create a package, select a quote (moves to awarded), then attempt
    // to transition back to draft (illegal).
    await createPackageWithAtoms(ORG_A, PKG_STATE, OPP_A, [
      { id: 'test-sc-atom-st-1', name: 'manufacture', valueWeight: 0.5 },
      { id: 'test-sc-atom-st-2', name: 'installation', valueWeight: 0.5 },
    ])
    await createQuoteWithCoverages(
      ORG_A,
      PKG_STATE,
      'test-sc-quote-st',
      'State Test Supplier',
      46000,
      [
        { atomId: 'test-sc-atom-st-1', status: 'covered' },
        { atomId: 'test-sc-atom-st-2', status: 'covered' },
      ],
    )

    // First: select the quote — package goes to awarded.
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: PKG_STATE,
      quoteId: 'test-sc-quote-st',
    })
    expect(selectResult.ok).toBe(true)
    if (selectResult.ok) {
      expect(selectResult.packageStatus).toBe('awarded')
    }

    // Verify the package is in awarded state.
    const pkgAwarded = await db.subcontractPackage.findUnique({ where: { id: PKG_STATE } })
    expect(pkgAwarded?.status).toBe('awarded')

    // Attempt illegal transition: awarded → draft.
    const transitionResult = await subcontractService.transitionPackageStatus({
      ctx: ctxA,
      packageId: PKG_STATE,
      status: 'draft',
    })
    expect(transitionResult.ok).toBe(false)
    if (!transitionResult.ok) {
      expect(transitionResult.status).toBe(400)
      expect(transitionResult.error).toContain('Illegal state transition')
    }

    // Verify the package is STILL in awarded state (not changed).
    const pkgAfter = await db.subcontractPackage.findUnique({ where: { id: PKG_STATE } })
    expect(pkgAfter?.status).toBe('awarded')

    // Control: awarded → abandoned IS allowed.
    const abandonResult = await subcontractService.transitionPackageStatus({
      ctx: ctxA,
      packageId: PKG_STATE,
      status: 'abandoned',
    })
    expect(abandonResult.ok).toBe(true)
    if (abandonResult.ok) {
      expect(abandonResult.status).toBe('abandoned')
    }
  }, 60000)

  // ─── Additional control tests ───────────────────────────────────────────

  test('Same-org getPackageWorkspace returns packages with reconciliation', async () => {
    // Org A reading its own OPP_A workspace — should include PKG_A.
    const result = await subcontractService.getPackageWorkspace({
      ctx: ctxA,
      opportunityId: OPP_A,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The commercial test packages were created in OPP_A too — they should
      // all be visible. We just verify PKG_A is present and reconciled.
      const pkgA = result.packages.find((p) => p.id === PKG_A)
      expect(pkgA).toBeDefined()
      if (pkgA) {
        expect(pkgA.scopeAtoms.length).toBe(1)
        expect(pkgA.quotes.length).toBe(1)
        const q = pkgA.quotes[0]
        expect(q.coveragePct).toBe(1) // full coverage
        expect(q.reconciliationStatus).toBe('ok')
        expect(q.supplierName).toBe('Supplier A Shared')
      }
    }
  }, 60000)

  test('Same-org createPackage + createScopeAtom + recordQuote works end-to-end', async () => {
    // Use the service to create a fresh package, atom, and quote, then
    // verify the workspace reflects them.
    const pkgResult = await subcontractService.createPackage({
      ctx: ctxA,
      opportunityId: OPP_A,
      name: 'End-to-End Test Package',
      executionStrategy: 'subcontract',
    })
    expect(pkgResult.ok).toBe(true)
    if (!pkgResult.ok) return
    const newPkgId = pkgResult.package.id

    const atomResult = await subcontractService.createScopeAtom({
      ctx: ctxA,
      packageId: newPkgId,
      name: 'e2e-atom',
      valueWeight: 1.0,
    })
    expect(atomResult.ok).toBe(true)
    if (!atomResult.ok) return
    const newAtomId = atomResult.scopeAtom.id

    const quoteResult = await subcontractService.recordQuote({
      ctx: ctxA,
      packageId: newPkgId,
      supplierName: 'E2E Supplier',
      totalAmount: 25000,
      currency: 'GHS',
    })
    expect(quoteResult.ok).toBe(true)
    if (!quoteResult.ok) return
    const newQuoteId = quoteResult.quote.id

    // Record full coverage.
    const covResult = await subcontractService.recordQuoteScopeCoverage({
      ctx: ctxA,
      quoteId: newQuoteId,
      scopeAtomId: newAtomId,
      status: 'covered',
    })
    expect(covResult.ok).toBe(true)

    // Reconcile via the service.
    const reconResult = await subcontractService.reconcileQuote({
      ctx: ctxA,
      packageId: newPkgId,
      quoteId: newQuoteId,
    })
    expect(reconResult.ok).toBe(true)
    if (reconResult.ok) {
      expect(reconResult.reconciliation.coveragePct).toBe(1)
      expect(reconResult.reconciliation.status).toBe('ok')
    }

    // Select the quote — should succeed (full coverage).
    const selectResult = await subcontractService.selectQuote({
      ctx: ctxA,
      packageId: newPkgId,
      quoteId: newQuoteId,
    })
    expect(selectResult.ok).toBe(true)
  }, 60000)
})
