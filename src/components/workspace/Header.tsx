'use client'

import { useState } from 'react'
import { signOut } from 'next-auth/react'
import { useWorkspace } from '@/store/workspace'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NewOpportunityDialog } from '@/components/workspace/NewOpportunityDialog'
import { Sparkles, ChevronLeft, Plus, LogOut, User as UserIcon } from 'lucide-react'
import { formatDate } from '@/lib/format'
import { toast } from 'sonner'

interface CurrentUser {
  id: string
  name: string | null
  email: string | null
  role: string
  organizationId: string
  isDemo: boolean
}

const VIEW_TITLES: Record<string, { title: string; subtitle: string }> = {
  dashboard: { title: 'Dashboard', subtitle: 'Estimating & operating memory overview' },
  opportunities: { title: 'Opportunities', subtitle: 'Incoming RFQs and active bids' },
  'work-library': { title: 'Work Library', subtitle: 'Versioned institutional memory' },
  subcontracting: { title: 'Subcontracting', subtitle: 'Scope reconciliation across packages' },
  knowledge: { title: 'Knowledge Health', subtitle: 'Stale prices, variances, unapproved rates' },
  admin: { title: 'Admin', subtitle: 'Waitlist & user management' },
  settings: { title: 'Settings', subtitle: 'Organization & policy configuration' },
}

export function Header({ user }: { user: CurrentUser }) {
  const view = useWorkspace((s) => s.view)
  const opportunityId = useWorkspace((s) => s.opportunityId)
  const closeOpportunity = useWorkspace((s) => s.closeOpportunity)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)
  const [showNewOpp, setShowNewOpp] = useState(false)

  const meta = VIEW_TITLES[view]
  const today = new Date()
  const greeting = today.getHours() < 12 ? 'Good morning' : today.getHours() < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = user.name?.split(' ')[0] ?? 'there'
  const initials = user.name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() ?? 'U'

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border bg-background/95 backdrop-blur px-6 py-3">
      <div className="flex items-center gap-3 min-w-0">
        {opportunityId && (
          <Button variant="ghost" size="sm" onClick={closeOpportunity} className="shrink-0">
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
          <span className="text-xs text-muted-foreground">{greeting}, {firstName}</span>
          <span className="text-[11px] text-muted-foreground">{formatDate(today.toISOString())}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => openAiPanel('general')} className="gap-2">
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">Ask Assistant</span>
        </Button>
        <Button size="sm" className="gap-2" onClick={() => setShowNewOpp(true)}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Opportunity</span>
        </Button>
        <NewOpportunityDialog open={showNewOpp} onOpenChange={setShowNewOpp} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-full hover:bg-muted/50 p-0.5 pr-2 transition-colors">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <div className="hidden sm:flex flex-col items-start leading-tight">
                <span className="text-xs font-medium">{firstName}</span>
                <span className="text-[10px] text-muted-foreground capitalize">{user.role}</span>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-1">
              <span>{user.name}</span>
              <span className="text-xs font-normal text-muted-foreground">{user.email}</span>
              {user.isDemo && (
                <Badge variant="outline" className="text-[10px] w-fit bg-amber-50 text-amber-700 border-amber-200">
                  Demo account
                </Badge>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                signOut({ redirect: false }).then(() => window.location.reload())
                toast.success('Signed out')
              }}
              className="text-red-600 focus:text-red-600 cursor-pointer"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
