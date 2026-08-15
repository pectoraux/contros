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
   * P0-3: WorkDefinition ownership is verified in the service after loading —
   * if a WD/WDV doesn't belong to the same org, it's treated as null.
   */
  async getRevisionContext(orgId: string, estimateId: string) {
    return db.estimate.findFirst({
      where: { id: estimateId, organizationId: orgId },
      include: {
        lines: {
          include: {
            workDefinition: true,
            workDefinitionVersion: { include: { priceObservations: true } },
            executionSegments: true,
          },
        },
        revisions: { orderBy: { revisionNo: 'desc' }, take: 1 },
      },
    })
  },

  /**
   * Get an estimate line with full pricing graph, tenant-scoped.
   * P0-3: WorkDefinition/WDV ownership is verified in the service after loading.
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
        workDefinition: true,
        workDefinitionVersion: { include: { priceObservations: true } },
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
