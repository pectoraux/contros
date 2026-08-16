/**
 * ContractorDashboardService — application service for dashboard aggregation.
 *
 * This service owns all dashboard KPI aggregation logic. The API route
 * is a thin adapter that calls this service. No raw Prisma in the route.
 *
 * Architecture:
 *   RequestContext → Service → Repository → Prisma
 *
 * INVARIANT 12: Every query is scoped by ctx.organizationId.
 */

import type { RequestContext } from '@/lib/context'
import { dashboardRepository } from '@/repositories'

export interface DashboardKpis {
  openOpportunities: number
  bidsDueThisWeek: number
  awaitingQuotes: number
  estimatesNeedingReview: number
  knowledgeAlerts: number
  pipelineValue: number
  blockedPricingItems: number
  submittedBids: number
  awardedProjects: number
}

export interface DashboardRecentActivity {
  id: string
  action: string
  summary: string
  entityType: string
  entityId: string
  actor: string
  createdAt: string
}

export interface DashboardAlert {
  id: string
  type: string
  severity: string
  title: string
  detail: string | null
  entityType: string | null
  entityId: string | null
}

export interface DashboardResult {
  kpis: DashboardKpis
  recentActivity: DashboardRecentActivity[]
  alerts: DashboardAlert[]
  pipelineByStatus: { status: string; count: number }[]
}

export const contractorDashboardService = {
  /**
   * Get the full contractor dashboard data — KPIs, recent activity,
   * knowledge alerts, and pipeline breakdown.
   *
   * All queries are tenant-scoped via ctx.organizationId.
   */
  async getDashboard(input: { ctx: RequestContext }): Promise<DashboardResult> {
    const { ctx } = input
    const now = new Date()
    const weekAhead = new Date(now.getTime() + 7 * 86400000)

    // Run all count queries in parallel for performance
    const [
      openOpportunities,
      bidsDueThisWeek,
      awaitingQuotes,
      estimatesNeedingReview,
      knowledgeAlertsCount,
      blockedPricingItems,
      submittedBids,
      awardedProjects,
      pipelineValue,
      recentActivity,
      alerts,
      pipelineByStatus,
    ] = await Promise.all([
      dashboardRepository.countOpenOpportunities(ctx.organizationId),
      dashboardRepository.countBidsDueThisWeek(ctx.organizationId, now, weekAhead),
      dashboardRepository.countAwaitingQuotes(ctx.organizationId),
      dashboardRepository.countEstimatesNeedingReview(ctx.organizationId),
      dashboardRepository.countKnowledgeAlerts(ctx.organizationId),
      dashboardRepository.countBlockedPricingItems(ctx.organizationId),
      dashboardRepository.countSubmittedBids(ctx.organizationId),
      dashboardRepository.countAwardedProjects(ctx.organizationId),
      dashboardRepository.getPipelineValue(ctx.organizationId),
      dashboardRepository.getRecentActivity(ctx.organizationId),
      dashboardRepository.getUnacknowledgedAlerts(ctx.organizationId),
      dashboardRepository.getPipelineByStatus(ctx.organizationId),
    ])

    return {
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
      pipelineByStatus: pipelineByStatus.map((p) => ({
        status: p.status,
        count: p._count._all,
      })),
    }
  },
}
