'use client'

import { useEffect, useState } from 'react'
import { apiGet, type KnowledgeAlertItem } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { severityStyle, relativeTime } from '@/lib/format'
import { Brain, AlertTriangle, TrendingUp, FileWarning, GitCompare, ShieldAlert } from 'lucide-react'

const TYPE_ICONS: Record<string, typeof Brain> = {
  'stale-price': TrendingUp,
  'productivity-variance': TrendingUp,
  'unapproved-rate': FileWarning,
  'subcontract-exclusion': GitCompare,
  'scope-gap': AlertTriangle,
}

const TYPE_LABELS: Record<string, string> = {
  'stale-price': 'Stale Price',
  'productivity-variance': 'Productivity Variance',
  'unapproved-rate': 'Unapproved Rate',
  'subcontract-exclusion': 'Subcontract Exclusion',
  'scope-gap': 'Scope Gap',
}

export function KnowledgeView() {
  const [alerts, setAlerts] = useState<KnowledgeAlertItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    apiGet<{ alerts: KnowledgeAlertItem[] }>('/api/knowledge-alerts')
      .then((r) => mounted && setAlerts(r.alerts))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const bySeverity = {
    blocker: alerts.filter((a) => a.severity === 'blocker'),
    warning: alerts.filter((a) => a.severity === 'warning'),
    info: alerts.filter((a) => a.severity === 'info'),
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Brain className="h-5 w-5" /> Knowledge Health
        </h2>
        <p className="text-sm text-muted-foreground">
          {alerts.length} alerts · {bySeverity.blocker.length} blockers · {bySeverity.warning.length} warnings · {bySeverity.info.length} info
        </p>
      </div>

      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <ShieldAlert className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Knowledge is the company's institutional memory. Approved WorkDefinitions are immutable; price observations are
            append-only. Actuals feed the knowledge loop — generating amendment proposals, never auto-mutating standards.
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(['blocker', 'warning', 'info'] as const).map((sev) => (
          <Card key={sev}>
            <CardHeader>
              <CardTitle className="text-base capitalize flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${sev === 'blocker' ? 'bg-red-500' : sev === 'warning' ? 'bg-amber-500' : 'bg-zinc-400'}`} />
                {sev}s ({bySeverity[sev].length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-96 overflow-y-auto">
              {bySeverity[sev].length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">None</p>
              ) : (
                bySeverity[sev].map((alert) => {
                  const Icon = TYPE_ICONS[alert.type] ?? AlertTriangle
                  return (
                    <div key={alert.id} className="p-3 rounded-md border border-border">
                      <div className="flex items-start gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className="text-[9px] uppercase">
                              {TYPE_LABELS[alert.type] ?? alert.type}
                            </Badge>
                          </div>
                          <p className="text-sm font-medium leading-snug">{alert.title}</p>
                          {alert.detail && (
                            <p className="text-[11px] text-muted-foreground mt-1">{alert.detail}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-1">{relativeTime(alert.createdAt)}</p>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
