import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Contractor Dashboard — real KPIs from the domain model.
// Deterministic aggregation — no AI on this path.
// INVARIANT 12: Every query is scoped by ctx.organizationId.
export async function GET() {
  try {
    const ctx = await requireAuth()
    const now = new Date()
    const weekAhead = new Date(now.getTime() + 7 * 86400000)

    const openOpportunities = await db.opportunity.count({
      where: {
        organizationId: ctx.organizationId,
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
    })

    const bidsDueThisWeek = await db.opportunity.count({
      where: {
        organizationId: ctx.organizationId,
        submissionDeadline: { gte: now, lte: weekAhead },
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
    })

    const awaitingQuotes = await db.subcontractPackage.count({
      where: {
        organizationId: ctx.organizationId,
        status: { in: ['enquiry-sent', 'quotes-received'] },
        selectedQuoteId: null,
      },
    })

    const estimatesNeedingReview = await db.estimate.count({
      where: {
        organizationId: ctx.organizationId,
        status: { in: ['draft', 'internal-review'] },
      },
    })

    const knowledgeAlertsCount = await db.knowledgeAlert.count({
      where: {
        organizationId: ctx.organizationId,
        acknowledged: false,
      },
    })

    // Contractor-specific KPI: blocked pricing items
    // Count estimate lines with calculationStatus='incomplete' across all
    // non-submitted/superseded estimates in the org.
    const blockedPricingItems = await db.estimateLine.count({
      where: {
        estimate: {
          organizationId: ctx.organizationId,
          status: { in: ['draft', 'internal-review', 'adjudicated'] },
        },
        calculationStatus: 'incomplete',
      },
    })

    // Contractor-specific KPI: submitted bids
    const submittedBids = await db.bid.count({
      where: {
        organizationId: ctx.organizationId,
        tenderPackStatus: { in: ['submitted', 'clarification'] },
      },
    })

    // Contractor-specific KPI: awarded projects
    const awardedProjects = await db.bid.count({
      where: {
        organizationId: ctx.organizationId,
        outcome: 'won',
      },
    })

    const recentActivity = await db.auditLog.findMany({
      take: 8,
      orderBy: { createdAt: 'desc' },
      where: { organizationId: ctx.organizationId },
      include: { actor: true },
    })

    const alerts = await db.knowledgeAlert.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      where: {
        organizationId: ctx.organizationId,
        acknowledged: false,
      },
    })

    const pipelineByStatus = await db.opportunity.groupBy({
      by: ['status'],
      where: { organizationId: ctx.organizationId },
      _count: { _all: true },
    })

    // Total active pipeline value (sum of latest estimate sellPrice for non-closed opps)
    const activeOpps = await db.opportunity.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
      },
      include: {
        estimates: { include: { lines: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    })
    const pipelineValue = activeOpps.reduce((sum, o) => {
      const est = o.estimates[0]
      if (!est) return sum
      const total = est.lines.reduce((s, l) => s + l.sellPrice, 0)
      return sum + total
    }, 0)

    return NextResponse.json({
      kpis: {
        openOpportunities,
        bidsDueThisWeek,
        awaitingQuotes,
        estimatesNeedingReview,
        knowledgeAlerts: knowledgeAlertsCount,
        pipelineValue,
        blockedPricingItems,
        submittedBids,
        awardedProjects,
      },
      recentActivity: recentActivity.map((a) => ({
        id: a.id,
        action: a.action,
        summary: a.summary,
        entityType: a.entityType,
        entityId: a.entityId,
        actor: a.actor?.name ?? 'System',
        createdAt: a.createdAt,
      })),
      alerts: alerts.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        entityType: a.entityType,
        entityId: a.entityId,
      })),
      pipelineByStatus: pipelineByStatus.map((p) => ({ status: p.status, count: p._count._all })),
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
