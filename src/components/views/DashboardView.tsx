'use client'

import { useEffect, useState } from 'react'
import { apiGet, type DashboardData } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  FolderKanban,
  CalendarClock,
  GitCompareArrows,
  ClipboardCheck,
  Brain,
  TrendingUp,
  Activity,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react'
import { formatGHSCompact, formatGHS, relativeTime, severityStyle } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const openOpportunity = useWorkspace((s) => s.openOpportunity)
  const setView = useWorkspace((s) => s.setView)

  useEffect(() => {
    let mounted = true
    apiGet<DashboardData>('/api/dashboard')
      .then((d) => mounted && setData(d))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  if (loading || !data) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  const kpis = [
    { label: 'Open Opportunities', value: data.kpis.openOpportunities, icon: FolderKanban, hint: 'Active pipeline' },
    { label: 'Bids Due This Week', value: data.kpis.bidsDueThisWeek, icon: CalendarClock, hint: 'Within 7 days' },
    { label: 'Awaiting Quotes', value: data.kpis.awaitingQuotes, icon: GitCompareArrows, hint: 'Subcontract packages' },
    { label: 'Estimates Needing Review', value: data.kpis.estimatesNeedingReview, icon: ClipboardCheck, hint: 'Draft or in review' },
    { label: 'Knowledge Alerts', value: data.kpis.knowledgeAlerts, icon: Brain, hint: 'Stale / unapproved' },
    { label: 'Pipeline Value', value: formatGHSCompact(data.kpis.pipelineValue), icon: TrendingUp, hint: 'Active estimates' },
  ]

  const maxPipeline = Math.max(...data.pipelineByStatus.map((p) => p.count), 1)

  return (
    <div className="p-6 space-y-6">
      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon
          return (
            <Card key={kpi.label} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardDescription className="text-[11px] uppercase tracking-wider">
                    {kpi.label}
                  </CardDescription>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tracking-tight">{kpi.value}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{kpi.hint}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Primary action */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-5">
          <div>
            <div className="text-sm font-semibold">Ready to estimate a new RFQ?</div>
            <div className="text-xs text-muted-foreground mt-1">
              Open an opportunity and run the deterministic pricing engine. AI assists with scope extraction — it never commits prices.
            </div>
          </div>
          <Button onClick={() => setView('opportunities')} className="gap-2 shrink-0">
            Open Opportunities
            <ArrowRight className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent activity */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4" /> Recent Activity
                </CardTitle>
                <CardDescription>Append-only audit trail</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setView('opportunities')}>
                View all
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 max-h-96 overflow-y-auto">
            {data.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No activity yet.</p>
            ) : (
              data.recentActivity.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-muted/50 transition-colors"
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-primary mt-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug">{a.summary}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {a.actor} · {relativeTime(a.createdAt)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Knowledge alerts */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> Knowledge Alerts
                </CardTitle>
                <CardDescription>Stale prices, variances, unapproved rates</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setView('knowledge')}>
                View all
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-y-auto">
            {data.alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No alerts — knowledge is healthy.</p>
            ) : (
              data.alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-start gap-3 p-3 rounded-md border border-border hover:bg-muted/30 transition-colors"
                >
                  <Badge variant="outline" className={`text-[10px] uppercase ${severityStyle(alert.severity)}`}>
                    {alert.severity}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{alert.title}</p>
                    {alert.detail && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{alert.detail}</p>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pipeline by status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pipeline by Status</CardTitle>
          <CardDescription>Opportunity distribution across the tender lifecycle</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data.pipelineByStatus.map((p) => (
              <div key={p.status} className="flex items-center gap-3">
                <div className="w-40 text-xs text-muted-foreground capitalize">{p.status.replace(/-/g, ' ')}</div>
                <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
                  <div
                    className="h-full bg-primary/80 transition-all"
                    style={{ width: `${(p.count / maxPipeline) * 100}%` }}
                  />
                </div>
                <div className="w-8 text-right text-xs font-mono">{p.count}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
