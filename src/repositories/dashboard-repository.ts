/**
 * Dashboard Repository — tenant-aware aggregation queries for the contractor dashboard.
 *
 * Every method takes orgId as its first parameter and scopes all queries
 * by organizationId. No method accepts an attacker-supplied org ID.
 *
 * INVARIANT 12: Every organization is isolated.
 */

import { db } from '@/lib/db'

export const dashboardRepository = {
  /** Count open opportunities (not in terminal status). */
  async countOpenOpportunities(orgId: string): Promise<number> {
    return db.opportunity.count({
      where: {
        organizationId: orgId,
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
    })
  },

  /** Count opportunities with deadlines within the next 7 days. */
  async countBidsDueThisWeek(orgId: string, now: Date, weekAhead: Date): Promise<number> {
    return db.opportunity.count({
      where: {
        organizationId: orgId,
        submissionDeadline: { gte: now, lte: weekAhead },
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
    })
  },

  /** Count subcontract packages awaiting quote selection. */
  async countAwaitingQuotes(orgId: string): Promise<number> {
    return db.subcontractPackage.count({
      where: {
        organizationId: orgId,
        status: { in: ['enquiry-sent', 'quotes-received'] },
        selectedQuoteId: null,
      },
    })
  },

  /** Count estimates in draft or internal-review status. */
  async countEstimatesNeedingReview(orgId: string): Promise<number> {
    return db.estimate.count({
      where: {
        organizationId: orgId,
        status: { in: ['draft', 'internal-review'] },
      },
    })
  },

  /** Count unacknowledged knowledge alerts. */
  async countKnowledgeAlerts(orgId: string): Promise<number> {
    return db.knowledgeAlert.count({
      where: {
        organizationId: orgId,
        acknowledged: false,
      },
    })
  },

  /**
   * Count estimate lines with calculationStatus='incomplete' across all
   * non-submitted/superseded estimates in the org.
   */
  async countBlockedPricingItems(orgId: string): Promise<number> {
    return db.estimateLine.count({
      where: {
        estimate: {
          organizationId: orgId,
          status: { in: ['draft', 'internal-review', 'adjudicated'] },
        },
        calculationStatus: 'incomplete',
      },
    })
  },

  /** Count submitted/clarification bids. */
  async countSubmittedBids(orgId: string): Promise<number> {
    return db.bid.count({
      where: {
        organizationId: orgId,
        tenderPackStatus: { in: ['submitted', 'clarification'] },
      },
    })
  },

  /** Count awarded (won) bids. */
  async countAwardedProjects(orgId: string): Promise<number> {
    return db.bid.count({
      where: {
        organizationId: orgId,
        outcome: 'won',
      },
    })
  },

  /** Get recent audit log entries with actor included. */
  async getRecentActivity(orgId: string, take = 8) {
    return db.auditLog.findMany({
      take,
      orderBy: { createdAt: 'desc' },
      where: { organizationId: orgId },
      include: { actor: true },
    })
  },

  /** Get unacknowledged knowledge alerts. */
  async getUnacknowledgedAlerts(orgId: string, take = 5) {
    return db.knowledgeAlert.findMany({
      take,
      orderBy: { createdAt: 'desc' },
      where: {
        organizationId: orgId,
        acknowledged: false,
      },
    })
  },

  /** Get pipeline breakdown by opportunity status. */
  async getPipelineByStatus(orgId: string) {
    return db.opportunity.groupBy({
      by: ['status'],
      where: { organizationId: orgId },
      _count: { _all: true },
    })
  },

  /**
   * Calculate total active pipeline value (sum of latest estimate sellPrice
   * for non-closed opportunities).
   */
  async getPipelineValue(orgId: string): Promise<number> {
    const activeOpps = await db.opportunity.findMany({
      where: {
        organizationId: orgId,
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
      include: {
        estimates: { include: { lines: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    })
    return activeOpps.reduce((sum, o) => {
      const est = o.estimates[0]
      if (!est) return sum
      const total = est.lines.reduce((s, l) => s + l.sellPrice, 0)
      return sum + total
    }, 0)
  },
}
