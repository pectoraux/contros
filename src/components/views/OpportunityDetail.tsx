'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiGet, type OpportunityDetail, type BidReadiness } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useWorkspace, type OpportunityTab } from '@/store/workspace'
import { statusStyle, statusLabel } from '@/lib/format'
import {
  LayoutDashboard,
  FileSearch,
  Calculator,
  Sheet,
  GitCompareArrows,
  CalendarRange,
  FileText,
  ShieldAlert,
  PackageCheck,
  History,
  Ban,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react'
import { OverviewTab } from './opportunity-tabs/OverviewTab'
import { ScopeTab } from './opportunity-tabs/ScopeTab'
import { EstimateTab } from './opportunity-tabs/EstimateTab'
import { BoqTab } from './opportunity-tabs/BoqTab'
import { SubcontractorsTab } from './opportunity-tabs/SubcontractorsTab'
import { ProgrammeTab } from './opportunity-tabs/ProgrammeTab'
import { MethodStatementTab } from './opportunity-tabs/MethodStatementTab'
import { JhaTab } from './opportunity-tabs/JhaTab'
import { TenderPackTab } from './opportunity-tabs/TenderPackTab'
import { ActivityTab } from './opportunity-tabs/ActivityTab'

const TABS: { id: OpportunityTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'scope', label: 'Scope', icon: FileSearch },
  { id: 'estimate', label: 'Estimate', icon: Calculator },
  { id: 'boq', label: 'BOQ', icon: Sheet },
  { id: 'subcontractors', label: 'Subcontractors', icon: GitCompareArrows },
  { id: 'programme', label: 'Programme', icon: CalendarRange },
  { id: 'method-statement', label: 'Method Statement', icon: FileText },
  { id: 'jha', label: 'JHA', icon: ShieldAlert },
  { id: 'tender-pack', label: 'Tender Pack', icon: PackageCheck },
  { id: 'activity', label: 'Activity', icon: History },
]

export function OpportunityDetail() {
  const opportunityId = useWorkspace((s) => s.opportunityId)
  const tab = useWorkspace((s) => s.opportunityTab)
  const setTab = useWorkspace((s) => s.setOpportunityTab)
  const [opp, setOpp] = useState<OpportunityDetail | null>(null)
  const [readiness, setReadiness] = useState<BidReadiness | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((t) => t + 1), [])

  useEffect(() => {
    if (!opportunityId) return
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    Promise.all([
      apiGet<{ opportunity: OpportunityDetail }>(`/api/opportunities/${opportunityId}`),
      apiGet<BidReadiness>(`/api/opportunities/${opportunityId}/readiness`).catch(() => null),
    ])
      .then(([oppRes, readyRes]) => {
        if (mounted) {
          setOpp(oppRes.opportunity)
          setReadiness(readyRes)
        }
      })
      .catch(() => {
        if (mounted) setOpp(null)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [opportunityId, reloadToken])

  if (loading || !opp) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-full max-w-3xl" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  // Compute estimate status summary (display only — authoritative readiness is from the service)
  const estimate = opp.estimates[0]
  const blockedLines = estimate?.lines.filter(l => l.calculationStatus === 'incomplete') ?? []
  const totalLines = estimate?.lines.length ?? 0
  const readyLines = totalLines - blockedLines.length
  const estimateReadyPct = totalLines > 0 ? Math.round((readyLines / totalLines) * 100) : 0

  // Readiness from the authoritative service
  const overallScore = readiness
    ? Math.round((readiness.score.scope + readiness.score.pricing + readiness.score.documents + readiness.score.knowledge) / 4)
    : null

  // Map blocker categories to tabs for navigation
  const blockerTabMap: Record<string, OpportunityTab> = {
    SCOPE: 'scope',
    PRICING: 'estimate',
    DOCUMENT: 'tender-pack',
    KNOWLEDGE: 'overview',
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header card with status + readiness summary */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-semibold tracking-tight truncate">{opp.title}</h2>
                <Badge variant="outline" className={`text-[10px] ${statusStyle(opp.status)}`}>
                  {statusLabel(opp.status)}
                </Badge>
                {blockedLines.length > 0 && (
                  <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">
                    <Ban className="h-2.5 w-2.5 mr-0.5" />
                    {blockedLines.length} blocked
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {opp.client.name}
                {opp.client.sector && <span className="capitalize"> · {opp.client.sector}</span>}
                {opp.location && <span> · {opp.location}</span>}
                {opp.reference && <span> · Ref: {opp.reference}</span>}
              </p>
            </div>

            {/* Bid Readiness Summary — from the authoritative service */}
            {readiness && (
              <div className="shrink-0 w-full lg:w-80 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Bid Readiness</span>
                  {readiness.ready ? (
                    <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                      <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                      Ready
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">
                      <Ban className="h-2.5 w-2.5 mr-0.5" />
                      {readiness.blockers.length} blocker{readiness.blockers.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>

                {/* Readiness score bars — from the service, not computed in React */}
                <div className="space-y-1.5">
                  {[
                    { label: 'Scope', value: readiness.score.scope },
                    { label: 'Pricing', value: readiness.score.pricing },
                    { label: 'Documents', value: readiness.score.documents },
                    { label: 'Knowledge', value: readiness.score.knowledge },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground w-16 shrink-0">{row.label}</span>
                      <Progress
                        value={row.value}
                        className={`h-1.5 flex-1 ${row.value === 100 ? '[&>div]:bg-emerald-500' : row.value < 50 ? '[&>div]:bg-red-500' : '[&>div]:bg-amber-500'}`}
                      />
                      <span className={`text-[11px] font-mono w-8 text-right ${row.value === 100 ? 'text-emerald-600' : row.value < 50 ? 'text-red-600' : 'text-amber-600'}`}>
                        {row.value}%
                      </span>
                    </div>
                  ))}
                </div>

                {/* Top blockers — clickable to navigate to relevant tab */}
                {readiness.blockers.length > 0 && (
                  <div className="space-y-0.5 mt-2">
                    {readiness.blockers.slice(0, 3).map((blocker, i) => (
                      <button
                        key={i}
                        onClick={() => setTab(blockerTabMap[blocker.category] ?? 'overview')}
                        className="flex items-start gap-1.5 w-full text-left text-[10px] text-muted-foreground hover:text-foreground transition-colors py-0.5"
                      >
                        <AlertTriangle className="h-2.5 w-2.5 mt-0.5 shrink-0 text-red-400" />
                        <span className="line-clamp-1">{blocker.message}</span>
                      </button>
                    ))}
                    {readiness.blockers.length > 3 && (
                      <span className="text-[10px] text-muted-foreground pl-4">
                        +{readiness.blockers.length - 3} more…
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Fallback when readiness hasn't loaded */}
            {!readiness && estimate && (
              <div className="flex items-center gap-3 text-xs shrink-0">
                <div className="flex flex-col items-end">
                  <span className="text-muted-foreground">Estimate Readiness</span>
                  <span className={`font-mono font-medium ${estimateReadyPct === 100 ? 'text-emerald-600' : estimateReadyPct < 70 ? 'text-red-600' : 'text-amber-600'}`}>
                    {estimateReadyPct}% ({readyLines}/{totalLines} priced)
                  </span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as OpportunityTab)}>
        <div className="overflow-x-auto">
          <TabsList className="h-auto bg-transparent p-0 gap-1">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = tab === t.id
              return (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">{t.label}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4 focus-visible:outline-none">
          <OverviewTab opp={opp} />
        </TabsContent>
        <TabsContent value="scope" className="mt-4 focus-visible:outline-none">
          <ScopeTab opp={opp} onReload={reload} />
        </TabsContent>
        <TabsContent value="estimate" className="mt-4 focus-visible:outline-none">
          <EstimateTab opp={opp} onReload={reload} />
        </TabsContent>
        <TabsContent value="boq" className="mt-4 focus-visible:outline-none">
          <BoqTab opp={opp} />
        </TabsContent>
        <TabsContent value="subcontractors" className="mt-4 focus-visible:outline-none">
          <SubcontractorsTab opp={opp} />
        </TabsContent>
        <TabsContent value="programme" className="mt-4 focus-visible:outline-none">
          <ProgrammeTab opp={opp} />
        </TabsContent>
        <TabsContent value="method-statement" className="mt-4 focus-visible:outline-none">
          <MethodStatementTab opp={opp} />
        </TabsContent>
        <TabsContent value="jha" className="mt-4 focus-visible:outline-none">
          <JhaTab opp={opp} />
        </TabsContent>
        <TabsContent value="tender-pack" className="mt-4 focus-visible:outline-none">
          <TenderPackTab opp={opp} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4 focus-visible:outline-none">
          <ActivityTab opp={opp} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
