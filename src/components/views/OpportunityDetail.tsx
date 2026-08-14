'use client'

import { useEffect, useState, useCallback } from 'react'
import { apiGet, type OpportunityDetail } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useWorkspace, type OpportunityTab } from '@/store/workspace'
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
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((t) => t + 1), [])

  useEffect(() => {
    if (!opportunityId) return
    let mounted = true
    // setLoading(true) is intentionally synchronous here to reset the skeleton on refetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    apiGet<{ opportunity: OpportunityDetail }>(`/api/opportunities/${opportunityId}`)
      .then((r) => {
        if (mounted) setOpp(r.opportunity)
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

  return (
    <div className="p-6 space-y-4">
      {/* Header card */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight truncate">{opp.title}</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {opp.client.name}
                {opp.client.sector && <span className="capitalize"> · {opp.client.sector}</span>}
                {opp.location && <span> · {opp.location}</span>}
                {opp.reference && <span> · Ref: {opp.reference}</span>}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
              <span>Owner: {opp.owner?.name ?? 'Unassigned'}</span>
              <span>·</span>
              <span>Received {new Date(opp.receivedAt).toLocaleDateString()}</span>
            </div>
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
