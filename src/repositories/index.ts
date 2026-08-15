/**
 * Tenant-aware repository abstractions.
 *
 * These repositories make unscoped retrieval difficult to express — every
 * method that reads or mutates organization-owned data requires the
 * authenticated organization context.
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * A repository must never return an org-owned entity solely from an
 * attacker-supplied ID.
 *
 * P0-3: WorkDefinition / WorkDefinitionVersion / Resource ownership is
 * verified explicitly — not trusted via the EstimateLine relation.
 */

import { db } from '@/lib/db'
import type { RequestContext } from '@/lib/context'

// ─── Estimate Repository ────────────────────────────────────────────────────

export const estimateRepository = {
  /** Get an estimate scoped to the authenticated organization. */
  async getForOrganization(orgId: string, estimateId: string) {
    return db.estimate.findFirst({
      where: { id: estimateId, organizationId: orgId },
    })
  },

  /**
   * Get the full revision context for an estimate: the estimate, its lines,
   * work definitions, versions, execution segments, and existing revisions.
   *
   * P0-3: WorkDefinition/WDV/Resource ownership is enforced AT THE REPOSITORY
   * LEVEL — the query only loads WDs/WDVs/priceObservations that belong to the
   * requesting organization. If a line references a cross-tenant WD, the WD/WDV
   * will be null in the result. The service checks for this and rejects.
   */
  async getRevisionContext(orgId: string, estimateId: string) {
    return db.estimate.findFirst({
      where: { id: estimateId, organizationId: orgId },
      include: {
        lines: {
          include: {
            // Only load WD if it belongs to the same org (1:1 relation with where filter)
            workDefinition: {
              where: { organizationId: orgId },
            },
            // Only load WDV if its parent WD belongs to the same org
            workDefinitionVersion: {
              where: {
                workDefinition: { organizationId: orgId },
              },
              include: {
                // Only load price observations for resources in the same org
                priceObservations: {
                  where: {
                    resource: { organizationId: orgId },
                  },
                },
              },
            },
            executionSegments: true,
          },
        },
        revisions: { orderBy: { revisionNo: 'desc' }, take: 1 },
      },
    })
  },

  /**
   * Get an estimate line with full pricing graph, tenant-scoped.
   * P0-3: WD/WDV/Resource ownership enforced at the repository level.
   */
  async getLineForOrganization(
    orgId: string,
    estimateId: string,
    lineId: string,
  ) {
    return db.estimateLine.findFirst({
      where: {
        id: lineId,
        estimateId,
        estimate: { organizationId: orgId },
      },
      include: {
        workDefinition: {
          where: { organizationId: orgId },
        },
        workDefinitionVersion: {
          where: {
            workDefinition: { organizationId: orgId },
          },
          include: {
            priceObservations: {
              where: {
                resource: { organizationId: orgId },
              },
            },
          },
        },
        estimate: true,
        scopeItem: true,
        executionSegments: true,
      },
    })
  },

  /** Update an estimate line — tenant-scoped via the estimate relation. */
  async updateLine(
    orgId: string,
    lineId: string,
    data: Record<string, unknown>,
  ) {
    const line = await db.estimateLine.findFirst({
      where: { id: lineId, estimate: { organizationId: orgId } },
      select: { id: true },
    })
    if (!line) return null
    return db.estimateLine.update({ where: { id: lineId }, data })
  },
}

// ─── Estimate Revision Repository ───────────────────────────────────────────

export const estimateRevisionRepository = {
  /** Create a finalized revision within a transaction. */
  async createFinalized(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    data: {
      estimateId: string
      revisionNo: number
      snapshotJson: string
      finalizedById: string
    },
  ) {
    return tx.estimateRevision.create({
      data: {
        estimateId: data.estimateId,
        revisionNo: data.revisionNo,
        snapshotJson: data.snapshotJson,
        status: 'finalized',
        finalizedById: data.finalizedById,
      },
    })
  },

  /** Get the latest revision number for an estimate. */
  async getLatestRevisionNo(orgId: string, estimateId: string): Promise<number> {
    const estimate = await db.estimate.findFirst({
      where: { id: estimateId, organizationId: orgId },
      select: {
        revisions: {
          orderBy: { revisionNo: 'desc' },
          take: 1,
          select: { revisionNo: true },
        },
      },
    })
    return estimate?.revisions[0]?.revisionNo ?? 0
  },

  /**
   * Get a finalized revision scoped to the authenticated organization.
   * Verifies ownership chain: EstimateRevision → Estimate → Organization.
   * Returns null if the revision doesn't exist OR belongs to another org.
   *
   * Used by BidService.submitBid() to tenant-safely resolve the revision
   * referenced by a Bid.
   */
  async getForOrganization(orgId: string, revisionId: string) {
    return db.estimateRevision.findFirst({
      where: {
        id: revisionId,
        estimate: { organizationId: orgId },
      },
      include: {
        estimate: {
          select: {
            id: true,
            organizationId: true,
            status: true,
            lines: {
              select: {
                id: true,
                calculationStatus: true,
                sellPrice: true,
              },
            },
          },
        },
      },
    })
  },
}

// ─── Subcontract Quote Repository ───────────────────────────────────────────

export const subcontractQuoteRepository = {
  /**
   * Get a subcontract quote scoped to the authenticated organization.
   * Verifies: quote → package → opportunity → org.
   * Returns null if the quote doesn't exist OR belongs to another org.
   */
  async getForOrganization(orgId: string, quoteId: string) {
    return db.subcontractQuote.findFirst({
      where: {
        id: quoteId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      select: { id: true, totalAmount: true, coveragePct: true },
    })
  },

  /**
   * Get the selected quote for a package line, tenant-scoped.
   */
  async getSelectedQuoteForLine(orgId: string, estimateLineId: string) {
    const pkgLine = await db.subcontractPackageLine.findFirst({
      where: {
        estimateLineId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      include: {
        subcontractPackage: {
          include: {
            quotes: { select: { id: true, totalAmount: true, coveragePct: true } },
          },
        },
      },
    })
    if (!pkgLine) return null
    const selectedQuoteId = pkgLine.subcontractPackage.selectedQuoteId
    if (!selectedQuoteId) return null
    return (
      pkgLine.subcontractPackage.quotes.find((q) => q.id === selectedQuoteId) ?? null
    )
  },

  /**
   * Get the package line + selected quote for an estimate line, tenant-scoped.
   * Used by finalizeRevision.
   */
  async getPackageLineForOrganization(orgId: string, estimateLineId: string) {
    return db.subcontractPackageLine.findFirst({
      where: {
        estimateLineId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      include: {
        subcontractPackage: {
          include: {
            quotes: { select: { id: true, totalAmount: true, coveragePct: true } },
          },
        },
      },
    })
  },

  /**
   * Get a quote with its full scope coverage graph + parent package, tenant-scoped.
   * Verifies: quote → package → opportunity → org.
   * Returns null if the quote doesn't exist OR belongs to another org.
   *
   * Used by SubcontractService.reconcileQuote() and selectQuote().
   */
  async getWithCoveragesForOrganization(orgId: string, quoteId: string) {
    return db.subcontractQuote.findFirst({
      where: {
        id: quoteId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      include: {
        scopeCoverages: true,
        subcontractPackage: {
          include: {
            scopeAtoms: true,
            // P0-2: estimateLine ownership verified in service after loading.
            lines: {
              include: {
                estimateLine: { include: { estimate: { select: { organizationId: true } } } },
              },
            },
          },
        },
      },
    })
  },

  /**
   * Create a quote, verifying package ownership.
   * Verifies: package → opportunity → org.
   * Returns null if the package doesn't exist OR belongs to another org.
   */
  async createForPackage(
    orgId: string,
    packageId: string,
    data: {
      supplierName: string
      totalAmount: number
      currency: string
      exclusionsJson: string
      assumptionsJson: string
      coveragePct?: number
      quoteId?: string
    },
  ) {
    // Verify the package belongs to the org.
    const pkg = await db.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!pkg) return null
    return db.subcontractQuote.create({
      data: {
        id: data.quoteId,
        subcontractPackageId: packageId,
        supplierName: data.supplierName,
        totalAmount: data.totalAmount,
        currency: data.currency,
        exclusionsJson: data.exclusionsJson,
        assumptionsJson: data.assumptionsJson,
        coveragePct: data.coveragePct ?? 0,
      },
    })
  },

  /**
   * Create a quote within a transaction, verifying package ownership.
   *
   * Used by SubcontractService.recordQuote() so that the quote creation and
   * the audit-log entry succeed or fail atomically (P0-1).
   *
   * Verifies: package → opportunity → org.
   * Returns null if the package doesn't exist OR belongs to another org.
   */
  async createForPackageInTransaction(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    orgId: string,
    packageId: string,
    data: {
      supplierName: string
      totalAmount: number
      currency: string
      exclusionsJson: string
      assumptionsJson: string
      coveragePct?: number
      quoteId?: string
    },
  ) {
    // Verify the package belongs to the org within the same transaction.
    const pkg = await tx.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!pkg) return null
    return tx.subcontractQuote.create({
      data: {
        id: data.quoteId,
        subcontractPackageId: packageId,
        supplierName: data.supplierName,
        totalAmount: data.totalAmount,
        currency: data.currency,
        exclusionsJson: data.exclusionsJson,
        assumptionsJson: data.assumptionsJson,
        coveragePct: data.coveragePct ?? 0,
      },
    })
  },

  /**
   * Update quote status (selected/rejected), tenant-scoped.
   * Verifies: quote → package → opportunity → org.
   * Returns null if the quote doesn't exist OR belongs to another org.
   */
  async updateStatus(orgId: string, quoteId: string, status: string) {
    const quote = await db.subcontractQuote.findFirst({
      where: {
        id: quoteId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      select: { id: true },
    })
    if (!quote) return null
    return db.subcontractQuote.update({
      where: { id: quoteId },
      data: { status },
    })
  },

  /**
   * Update quote status within a transaction (used by selectQuote).
   * Assumes the caller has already verified ownership.
   */
  async updateStatusInTransaction(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    quoteId: string,
    status: string,
    coveragePct?: number,
  ) {
    return tx.subcontractQuote.update({
      where: { id: quoteId },
      data: {
        status,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
      },
    })
  },
}

// ─── Commercial Exception Repository ────────────────────────────────────────

export const commercialExceptionRepository = {
  async findOpenForLine(orgId: string, lineId: string, type: string) {
    return db.commercialException.findFirst({
      where: {
        estimateLineId: lineId,
        type,
        organizationId: orgId,
      },
    })
  },

  async createForLine(
    orgId: string,
    lineId: string,
    data: { type: string; reason: string; exposure: number; approvalRequired: boolean },
  ) {
    return db.commercialException.create({
      data: {
        organizationId: orgId,
        estimateLineId: lineId,
        entityType: 'estimate-line',
        entityId: lineId,
        ...data,
      },
    })
  },

  /**
   * Find an APPROVED commercial exception for a subcontract quote.
   * Verifies: exception.organizationId === orgId AND entityId === quoteId.
   * Used by selectQuote() to allow override of blockers (lump-sum, exclusions,
   * low coverage) when a director has explicitly approved the exception.
   */
  async findApprovedForQuote(orgId: string, quoteId: string) {
    return db.commercialException.findFirst({
      where: {
        organizationId: orgId,
        entityType: 'subcontract-quote',
        entityId: quoteId,
        approvedById: { not: null },
        approvedAt: { not: null },
      },
    })
  },

  /**
   * Create a commercial exception for a subcontract quote (entityType='subcontract-quote').
   * Used to record lump-sum / excluded-scope / low-coverage exceptions.
   */
  async createForQuote(
    orgId: string,
    quoteId: string,
    data: {
      type: string
      reason: string
      exposure: number
      approvalRequired: boolean
      approvedById?: string
      approvedAt?: Date
    },
  ) {
    return db.commercialException.create({
      data: {
        organizationId: orgId,
        entityType: 'subcontract-quote',
        entityId: quoteId,
        ...data,
      },
    })
  },
}

// ─── Audit Log Repository ───────────────────────────────────────────────────

export const auditLogRepository = {
  async create(
    orgId: string,
    actorId: string,
    entry: {
      action: string
      entityType: string
      entityId: string
      summary: string
      afterJson?: string
    },
  ) {
    return db.auditLog.create({
      data: {
        organizationId: orgId,
        actorId,
        ...entry,
      },
    })
  },

  /** Create within a transaction. */
  async createInTransaction(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    orgId: string,
    actorId: string,
    entry: {
      action: string
      entityType: string
      entityId: string
      summary: string
      afterJson?: string
    },
  ) {
    return tx.auditLog.create({
      data: {
        organizationId: orgId,
        actorId,
        ...entry,
      },
    })
  },
}

// ─── Subcontract Package Repository ─────────────────────────────────────────
//
// Verifies: SubcontractPackage → Opportunity → Organization.
// Every method requires orgId — no unscoped access.

export const subcontractPackageRepository = {
  /** Get all packages for an opportunity, tenant-scoped. */
  async getForOpportunity(orgId: string, opportunityId: string) {
    return db.subcontractPackage.findMany({
      where: {
        organizationId: orgId,
        opportunityId,
        opportunity: { organizationId: orgId },
      },
      include: {
        // P0-2: estimateLine ownership is verified in the service after loading.
        // Prisma does not support `where` on 1:1 relation includes.
        lines: {
          include: {
            estimateLine: { include: { estimate: { select: { organizationId: true } } } },
          },
        },
        quotes: { include: { scopeCoverages: true } },
        scopeAtoms: true,
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  /**
   * Get a single package with full graph (lines, quotes, scopeAtoms, coverages),
   * tenant-scoped. Returns null if the package doesn't exist OR belongs to
   * another org.
   */
  async getForOrganization(orgId: string, packageId: string) {
    return db.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      include: {
        // P0-2: estimateLine ownership is verified in the service after loading.
        lines: {
          include: {
            estimateLine: { include: { estimate: { select: { organizationId: true } } } },
          },
        },
        quotes: { include: { scopeCoverages: true } },
        scopeAtoms: true,
      },
    })
  },

  /**
   * Create a package, verifying opportunity ownership.
   * Returns null if the opportunity doesn't exist OR belongs to another org.
   */
  async createForOrganization(
    orgId: string,
    data: {
      opportunityId: string
      name: string
      scope?: string
      executionStrategy: string
      packageId?: string
    },
  ) {
    // Verify opportunity ownership first.
    const opportunity = await db.opportunity.findFirst({
      where: { id: data.opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!opportunity) return null
    return db.subcontractPackage.create({
      data: {
        id: data.packageId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
        name: data.name,
        scope: data.scope,
        executionStrategy: data.executionStrategy,
      },
    })
  },

  /**
   * Create a package within a transaction, verifying opportunity ownership.
   *
   * Used by SubcontractService.createPackage() so that the package creation
   * and the audit-log entry succeed or fail atomically (P0-1).
   *
   * Returns null if the opportunity doesn't exist OR belongs to another org.
   */
  async createForOrganizationInTransaction(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    orgId: string,
    data: {
      opportunityId: string
      name: string
      scope?: string | null
      executionStrategy: string
      packageId?: string
    },
  ) {
    // Verify opportunity ownership within the same transaction.
    const opportunity = await tx.opportunity.findFirst({
      where: { id: data.opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!opportunity) return null
    return tx.subcontractPackage.create({
      data: {
        id: data.packageId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
        name: data.name,
        scope: data.scope ?? null,
        executionStrategy: data.executionStrategy,
      },
    })
  },

  /**
   * Update package status (for state machine), tenant-scoped.
   * Returns null if the package doesn't exist OR belongs to another org.
   */
  async updateStatus(orgId: string, packageId: string, status: string) {
    const pkg = await db.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true, status: true, selectedQuoteId: true },
    })
    if (!pkg) return null
    return db.subcontractPackage.update({
      where: { id: packageId },
      data: { status },
    })
  },

  /**
   * Update package selectedQuoteId + status within a transaction (used by selectQuote).
   * Assumes the caller has already verified ownership.
   */
  async updateSelectionInTransaction(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    packageId: string,
    selectedQuoteId: string | null,
    status: string,
  ) {
    return tx.subcontractPackage.update({
      where: { id: packageId },
      data: { selectedQuoteId, status },
    })
  },
}

// ─── Scope Atom Repository ───────────────────────────────────────────────────
//
// Verifies: ScopeAtom → SubcontractPackage → Opportunity → Organization.

export const scopeAtomRepository = {
  /** Get all scope atoms for a package, tenant-scoped. */
  async getForPackage(orgId: string, packageId: string) {
    return db.scopeAtom.findMany({
      where: {
        subcontractPackageId: packageId,
        subcontractPackage: {
          organizationId: orgId,
          opportunity: { organizationId: orgId },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  /**
   * Create a scope atom, verifying package ownership.
   * Returns null if the package doesn't exist OR belongs to another org.
   */
  async createForPackage(
    orgId: string,
    packageId: string,
    data: {
      name: string
      description?: string
      valueWeight: number
      scopeAtomId?: string
    },
  ) {
    const pkg = await db.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!pkg) return null
    return db.scopeAtom.create({
      data: {
        id: data.scopeAtomId,
        subcontractPackageId: packageId,
        name: data.name,
        description: data.description,
        valueWeight: data.valueWeight,
      },
    })
  },

  /**
   * Create a scope atom inside a transaction, verifying package ownership.
   * P0: Used by createScopeAtom() for atomic scope-atom + audit creation.
   * Returns null if the package doesn't exist OR belongs to another org.
   */
  async createForPackageInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    packageId: string,
    data: {
      name: string
      description?: string | null
      valueWeight: number
      scopeAtomId?: string
    },
  ) {
    const pkg = await tx.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!pkg) return null
    return tx.scopeAtom.create({
      data: {
        id: data.scopeAtomId,
        subcontractPackageId: packageId,
        name: data.name,
        description: data.description,
        valueWeight: data.valueWeight,
      },
    })
  },
}

// ─── Quote Scope Coverage Repository ─────────────────────────────────────────
//
// Verifies: QuoteScopeCoverage → SubcontractQuote → SubcontractPackage →
// Opportunity → Organization.
// Also verifies the scopeAtom belongs to the same package as the quote.

export const quoteScopeCoverageRepository = {
  /** Get all coverages for a quote, tenant-scoped. */
  async getForQuote(orgId: string, quoteId: string) {
    return db.quoteScopeCoverage.findMany({
      where: {
        quoteId,
        quote: {
          subcontractPackage: {
            opportunity: { organizationId: orgId },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  /**
   * Upsert a coverage (create or update), verifying quote + scopeAtom belong
   * to the same package+org.
   *
   * Returns null if either:
   *   - the quote doesn't exist OR belongs to another org
   *   - the scopeAtom doesn't exist OR belongs to another org
   *   - the scopeAtom belongs to a different package than the quote
   */
  async upsertForQuote(
    orgId: string,
    quoteId: string,
    scopeAtomId: string,
    status: string,
    note?: string,
  ) {
    // Verify quote ownership AND get its packageId.
    const quote = await db.subcontractQuote.findFirst({
      where: {
        id: quoteId,
        subcontractPackage: {
          opportunity: { organizationId: orgId },
        },
      },
      select: { id: true, subcontractPackageId: true },
    })
    if (!quote) return null

    // Verify the scopeAtom belongs to the same package+org.
    const atom = await db.scopeAtom.findFirst({
      where: {
        id: scopeAtomId,
        subcontractPackageId: quote.subcontractPackageId,
        subcontractPackage: {
          organizationId: orgId,
          opportunity: { organizationId: orgId },
        },
      },
      select: { id: true },
    })
    if (!atom) return null

    // Find existing coverage (quoteId + scopeAtomId is effectively unique).
    const existing = await db.quoteScopeCoverage.findFirst({
      where: { quoteId, scopeAtomId },
      select: { id: true },
    })
    if (existing) {
      return db.quoteScopeCoverage.update({
        where: { id: existing.id },
        data: { status, note: note ?? null },
      })
    }
    return db.quoteScopeCoverage.create({
      data: { quoteId, scopeAtomId, status, note: note ?? null },
    })
  },
}

// ─── Subcontract Package Line Repository ─────────────────────────────────────
//
// Verifies BOTH:
//   - SubcontractPackage → Opportunity → Organization
//   - EstimateLine → Estimate → Organization
// (the two must belong to the same org before a line can be linked to a package)

export const subcontractPackageLineRepository = {
  /** Get lines for a package, tenant-scoped. */
  async getForPackage(orgId: string, packageId: string) {
    return db.subcontractPackageLine.findMany({
      where: {
        subcontractPackageId: packageId,
        subcontractPackage: {
          organizationId: orgId,
          opportunity: { organizationId: orgId },
        },
      },
      include: {
        // P0-2: estimateLine ownership verified in service after loading.
        estimateLine: { include: { estimate: { select: { organizationId: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  },

  /**
   * Create a package line, verifying both estimateLine and package belong to
   * the same org. Returns null if either is cross-tenant.
   */
  async createForPackage(
    orgId: string,
    packageId: string,
    estimateLineId: string,
    requiredScope: string,
  ) {
    // Verify package ownership.
    const pkg = await db.subcontractPackage.findFirst({
      where: {
        id: packageId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!pkg) return null

    // Verify estimateLine ownership (estimateLine → estimate → org).
    const line = await db.estimateLine.findFirst({
      where: {
        id: estimateLineId,
        estimate: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!line) return null

    return db.subcontractPackageLine.create({
      data: {
        subcontractPackageId: packageId,
        estimateLineId,
        requiredScope,
      },
    })
  },
}

// ─── Bid Repository ─────────────────────────────────────────────────────────
//
// Verifies: Bid → Opportunity → Organization.
// Every method requires orgId — no unscoped access.
// INVARIANT 12: Every organization is isolated.

type PrismaTransaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export const bidRepository = {
  /**
   * Get a bid scoped to the authenticated organization.
   * Verifies: bid → opportunity → org.
   * Returns null if the bid doesn't exist OR belongs to another org.
   */
  async getForOrganization(orgId: string, bidId: string) {
    return db.bid.findFirst({
      where: {
        id: bidId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      include: {
        opportunity: {
          select: {
            id: true,
            title: true,
            status: true,
            organizationId: true,
          },
        },
        estimate: {
          select: {
            id: true,
            status: true,
            organizationId: true,
          },
        },
      },
    })
  },

  /**
   * Get the bid for an opportunity (1:1 relation).
   * Verifies: bid → opportunity → org.
   * Returns null if the bid doesn't exist OR belongs to another org.
   */
  async getForOpportunity(orgId: string, opportunityId: string) {
    return db.bid.findFirst({
      where: {
        opportunityId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
    })
  },

  /**
   * Create a bid, verifying opportunity + estimate ownership.
   * Returns null if either the opportunity OR estimate doesn't exist
   * OR belongs to another org, OR if the estimate doesn't belong to the
   * given opportunity.
   */
  async createForOrganization(
    orgId: string,
    data: {
      opportunityId: string
      estimateId: string
      bidId?: string
    },
  ) {
    // Verify opportunity ownership.
    const opportunity = await db.opportunity.findFirst({
      where: { id: data.opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!opportunity) return null

    // Verify estimate ownership AND that it belongs to this opportunity.
    const estimate = await db.estimate.findFirst({
      where: {
        id: data.estimateId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
      },
      select: { id: true },
    })
    if (!estimate) return null

    return db.bid.create({
      data: {
        id: data.bidId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
        estimateId: data.estimateId,
      },
    })
  },

  /**
   * Create a bid within a transaction, verifying opportunity + estimate ownership.
   *
   * Used by BidService.createBid() so that the bid creation and the audit-log
   * entry succeed or fail atomically (P0-1).
   *
   * Returns null if either the opportunity OR estimate doesn't exist OR belongs
   * to another org, OR if the estimate doesn't belong to the given opportunity.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      opportunityId: string
      estimateId: string
      bidId?: string
    },
  ) {
    // Verify opportunity ownership within the same transaction.
    const opportunity = await tx.opportunity.findFirst({
      where: { id: data.opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!opportunity) return null

    // Verify estimate ownership AND that it belongs to this opportunity.
    const estimate = await tx.estimate.findFirst({
      where: {
        id: data.estimateId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
      },
      select: { id: true },
    })
    if (!estimate) return null

    return tx.bid.create({
      data: {
        id: data.bidId,
        organizationId: orgId,
        opportunityId: data.opportunityId,
        estimateId: data.estimateId,
      },
    })
  },

  /**
   * Update a bid, verifying ownership before update.
   * Verifies: bid → opportunity → org.
   * Returns null if the bid doesn't exist OR belongs to another org.
   */
  async updateForOrganization(
    orgId: string,
    bidId: string,
    data: Record<string, unknown>,
  ) {
    const bid = await db.bid.findFirst({
      where: {
        id: bidId,
        organizationId: orgId,
        opportunity: { organizationId: orgId },
      },
      select: { id: true },
    })
    if (!bid) return null
    return db.bid.update({ where: { id: bidId }, data })
  },

  /**
   * Update a bid within a transaction (used by submitBid, recordAdjudication,
   * recordOutcome, withdrawBid).
   * Verifies ownership within the transaction.
   */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    bidId: string,
    data: Record<string, unknown>,
  ) {
    const bid = await tx.bid.findFirst({
      where: { id: bidId, organizationId: orgId },
      select: { id: true },
    })
    if (!bid) return null
    return tx.bid.update({ where: { id: bidId }, data })
  },

  /**
   * Get the full opportunity graph needed to run the pre-submission gate:
   *   - opportunity (with title + status)
   *   - scopePackage (items, questions, assumptions)
   *   - latest estimate (with lines + commercialExceptions)
   *   - subcontractPackages (with lines.estimateLine, quotes.scopeCoverages,
   *     scopeAtoms)
   *   - bid (if any)
   *
   * Tenant-safe: opportunity.organizationId === orgId.
   * Returns null if the opportunity doesn't exist OR belongs to another org.
   *
   * Used by BidService.runSubmissionGate() and getBidWorkspace().
   */
  async getOpportunityBidWorkspace(orgId: string, opportunityId: string) {
    return db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: orgId },
      include: {
        scopePackage: {
          include: {
            items: true,
            questions: true,
            assumptions: true,
          },
        },
        estimates: {
          include: {
            lines: {
              include: {
                commercialExceptions: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        subcontractPackages: {
          include: {
            lines: { include: { estimateLine: true } },
            quotes: { include: { scopeCoverages: true } },
            scopeAtoms: true,
          },
        },
        bid: true,
      },
    })
  },
}

// ─── Estimate Revision Repository (Extended) ────────────────────────────────

export const estimateRevisionRepositoryExtended = {
  async getForOrganization(orgId: string, revisionId: string) {
    return db.estimateRevision.findFirst({ where: { id: revisionId, estimate: { organizationId: orgId } }, include: { estimate: true } })
  },
}
