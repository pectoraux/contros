'use client'

import { useWorkspace } from '@/store/workspace'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sparkles, ChevronLeft, Plus } from 'lucide-react'
import { formatDate, daysUntil } from '@/lib/format'

const VIEW_TITLES: Record<string, { title: string; subtitle: string }> = {
  dashboard: { title: 'Dashboard', subtitle: 'Estimating & operating memory overview' },
  opportunities: { title: 'Opportunities', subtitle: 'Incoming RFQs and active bids' },
  'work-library': { title: 'Work Library', subtitle: 'Versioned institutional memory' },
  subcontracting: { title: 'Subcontracting', subtitle: 'Scope reconciliation across packages' },
  knowledge: { title: 'Knowledge Health', subtitle: 'Stale prices, variances, unapproved rates' },
  settings: { title: 'Settings', subtitle: 'Organization & policy configuration' },
}

export function Header() {
  const view = useWorkspace((s) => s.view)
  const opportunityId = useWorkspace((s) => s.opportunityId)
  const closeOpportunity = useWorkspace((s) => s.closeOpportunity)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)

  const meta = VIEW_TITLES[view]
  const today = new Date()
  const greeting = today.getHours() < 12 ? 'Good morning' : today.getHours() < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border bg-background/95 backdrop-blur px-6 py-4">
      <div className="flex items-center gap-3 min-w-0">
        {opportunityId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={closeOpportunity}
            className="shrink-0"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight truncate">
            {opportunityId ? 'Opportunity Workspace' : meta?.title ?? 'Contractor OS'}
          </h1>
          <p className="text-xs text-muted-foreground truncate">
            {opportunityId ? 'Scope · Estimate · BOQ · Programme · Tender Pack' : meta?.subtitle}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden lg:flex flex-col items-end text-right pr-3 border-r border-border">
          <span className="text-xs text-muted-foreground">{greeting}, Abena</span>
          <span className="text-[11px] text-muted-foreground">{formatDate(today.toISOString())}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAiPanel('general')}
          className="gap-2"
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">Ask Assistant</span>
        </Button>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Opportunity</span>
        </Button>
      </div>
    </header>
  )
}

export function DeadlineBadge({ deadline }: { deadline: string | null }) {
  if (!deadline) return null
  const days = daysUntil(deadline)
  if (days === null) return null
  const variant = days < 0 ? 'destructive' : days <= 7 ? 'warning' : 'default'
  return (
    <Badge variant="outline" className="text-[11px]">
      {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d to deadline`}
    </Badge>
  )
}
