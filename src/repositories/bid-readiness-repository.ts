/**
 * Bid Readiness Repository — tenant-aware queries for the bid readiness gate.
 *
 * Every method takes orgId as its first parameter.
 *
 * INVARIANT 12: Every organization is isolated.
 */

import { db } from '@/lib/db'

export const bidReadinessRepository = {
  /**
   * Get estimate lines with their calculationStatus for the latest estimate
   * of an opportunity. Used to determine pricing readiness.
   */
  async getEstimateLineStatuses(orgId: string, opportunityId: string) {
    const estimate = await db.estimate.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        lines: {
          select: {
            id: true,
            calculationStatus: true,
            isUnsourced: true,
            description: true,
            workDefinitionId: true,
            workDefinitionVersionId: true,
          },
        },
      },
    })
    return estimate
  },

  /**
   * Get TenderDeliverable records for the bid linked to this opportunity.
   * Used to determine document readiness.
   */
  async getTenderDeliverables(orgId: string, opportunityId: string) {
    const bid = await db.bid.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!bid) return []

    return db.tenderDeliverable.findMany({
      where: { bidId: bid.id },
      orderBy: { kind: 'asc' },
    })
  },

  /**
   * Check whether a bid exists for this opportunity (tenant-scoped).
   * Used to determine if the document readiness phase has started.
   */
  async bidExists(orgId: string, opportunityId: string): Promise<boolean> {
    const bid = await db.bid.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    return !!bid
  },

  /**
   * Get unacknowledged knowledge alerts that are RELEVANT to this opportunity.
   *
   * An alert is relevant if:
   * - Its entityId matches a WorkDefinitionVersion used by this opportunity's
   *   estimate lines (unapproved-rate, stale-price alerts on those WDVs)
   * - Its entityId matches a Resource used by this opportunity's estimate lines
   *   (stale-price alerts on those resources)
   * - OR it has no entityId (organization-wide alerts that apply to all bids)
   *
   * This prevents an unrelated alert for Opportunity B from blocking
   * Opportunity A's readiness.
   */
  async getOpportunityRelevantAlerts(orgId: string, opportunityId: string) {
    // Get the WorkDefinitionVersion IDs and resource codes used by this opportunity's estimate
    const estimate = await db.estimate.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        lines: {
          select: {
            workDefinitionVersionId: true,
            workDefinitionId: true,
          },
        },
      },
    })

    // Collect all WDV IDs and WD IDs used by this opportunity
    const wdvIds = new Set<string>()
    const wdIds = new Set<string>()
    if (estimate) {
      for (const line of estimate.lines) {
        if (line.workDefinitionVersionId) wdvIds.add(line.workDefinitionVersionId)
        if (line.workDefinitionId) wdIds.add(line.workDefinitionId)
      }
    }

    // Get the resource IDs used by the WDVs (from cost recipe price observations)
    const resourceIds = new Set<string>()
    if (wdvIds.size > 0) {
      const observations = await db.resourcePriceObservation.findMany({
        where: {
          workDefinitionVersionId: { in: Array.from(wdvIds) },
        },
        select: { resourceId: true },
      })
      for (const obs of observations) {
        resourceIds.add(obs.resourceId)
      }
    }

    // Build the relevance filter: alert must be unacknowledged, org-scoped,
    // AND either (a) have no entityId (org-wide), (b) reference a WDV/WD/resource
    // used by this opportunity, or (c) reference the opportunity itself.
    const relevantEntityIds = new Set<string>([
      ...Array.from(wdvIds),
      ...Array.from(wdIds),
      ...Array.from(resourceIds),
      opportunityId, // alerts directly referencing this opportunity
    ])

    const alerts = await db.knowledgeAlert.findMany({
      where: {
        organizationId: orgId,
        acknowledged: false,
        severity: { in: ['blocker', 'warning'] },
        OR: [
          { entityId: null }, // Org-wide alerts with no specific entity
          { entityId: { in: Array.from(relevantEntityIds) } }, // Alerts referencing entities used by this opportunity
        ],
      },
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        detail: true,
        entityId: true,
        entityType: true,
      },
    })

    return alerts
  },

  /**
   * Get scope package completeness and question/assumption counts.
   */
  async getScopeSummary(orgId: string, opportunityId: string) {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: {
        id: true,
        completeness: true,
        _count: {
          select: {
            items: true,
            questions: { where: { status: 'open' } },
            assumptions: { where: { riskLevel: 'high', acknowledged: false } },
          },
        },
      },
    })
    return scopePackage
  },
}
