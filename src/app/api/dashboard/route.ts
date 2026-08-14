import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

// Dashboard KPIs + recent activity + knowledge alerts
// Deterministic aggregation — no AI on this path.
export async function GET() {
  const now = new Date()
  const weekAhead = new Date(now.getTime() + 7 * 86400000)

  const openOpportunities = await db.opportunity.count({
    where: { status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] } },
  })

  const bidsDueThisWeek = await db.opportunity.count({
    where: {
      submissionDeadline: { gte: now, lte: weekAhead },
      status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] },
    },
  })

  const awaitingQuotes = await db.subcontractPackage.count({
    where: { status: { in: ['enquiry-sent', 'quotes-received'] }, selectedQuoteId: null },
  })

  const estimatesNeedingReview = await db.estimate.count({
    where: { status: { in: ['draft', 'internal-review'] } },
  })

  const knowledgeAlertsCount = await db.knowledgeAlert.count({
    where: { acknowledged: false },
  })

  const recentActivity = await db.auditLog.findMany({
    take: 8,
    orderBy: { createdAt: 'desc' },
    include: { actor: true },
  })

  const alerts = await db.knowledgeAlert.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    where: { acknowledged: false },
  })

  const pipelineByStatus = await db.opportunity.groupBy({
    by: ['status'],
    _count: { _all: true },
  })

  // Total active pipeline value (sum of latest estimate sellPrice for non-closed opps)
  const activeOpps = await db.opportunity.findMany({
    where: { status: { notIn: ['won', 'lost', 'withdrawn', 'lapsed', 'no-bid'] } },
    include: { estimates: { include: { lines: true }, orderBy: { updatedAt: 'desc' }, take: 1 } },
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
}
