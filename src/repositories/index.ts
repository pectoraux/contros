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
 */

import { db } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import type { ExecutionSegmentInput, PricingInput } from '@/lib/engines'

// ─── Estimate Repository ────────────────────────────────────────────────────

export const estimateRepository = {
  /** Get an estimate scoped to the authenticated organization. */
  async getForOrganization(orgId: string, estimateId: string) {
    return db.estimate.findFirst({
      where: { id: estimateId, organizationId: orgId },
    })
  },

  /** Get an estimate line with full pricing graph, tenant-scoped. */
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
    // Verify ownership before update.
    const line = await db.estimateLine.findFirst({
      where: { id: lineId, estimate: { organizationId: orgId } },
      select: { id: true },
    })
    if (!line) return null
    return db.estimateLine.update({ where: { id: lineId }, data })
  },
}

// ─── Subcontract Quote Repository ───────────────────────────────────────────

export const subcontractQuoteRepository = {
  /**
   * Get a subcontract quote scoped to the authenticated organization.
   * Verifies the full ownership chain: quote → package → opportunity → org.
   * Returns null if the quote doesn't exist OR belongs to another org.
   * Does NOT reveal cross-tenant existence.
   */
  async getForOrganization(
    orgId: string,
    quoteId: string,
  ) {
    return db.subcontractQuote.findFirst({
      where: {
        id: quoteId,
        subcontractPackage: {
          opportunity: {
            organizationId: orgId,
          },
        },
      },
      select: { id: true, totalAmount: true, coveragePct: true },
    })
  },

  /**
   * Get the selected quote for a package line, tenant-scoped.
   * The packageLine must belong to a package → opportunity → org chain.
   */
  async getSelectedQuoteForLine(
    orgId: string,
    estimateLineId: string,
  ) {
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
}

// ─── Execution Segment Repository ───────────────────────────────────────────

export const executionSegmentRepository = {
  /** Get all execution segments for a line, tenant-scoped via the estimate. */
  async getForLine(orgId: string, lineId: string) {
    const line = await db.estimateLine.findFirst({
      where: { id: lineId, estimate: { organizationId: orgId } },
      select: { id: true },
    })
    if (!line) return []
    return db.executionSegment.findMany({
      where: { estimateLineId: lineId },
    })
  },
}
