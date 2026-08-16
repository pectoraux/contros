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
   * Get unacknowledged knowledge alerts for the org.
   * Used to determine knowledge readiness.
   */
  async getUnacknowledgedAlerts(orgId: string) {
    return db.knowledgeAlert.findMany({
      where: {
        organizationId: orgId,
        acknowledged: false,
        severity: { in: ['blocker', 'warning'] },
      },
      select: {
        id: true,
        type: true,
        severity: true,
        title: true,
        detail: true,
      },
    })
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
