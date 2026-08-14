'use client'

import { useWorkspace, type ViewId } from '@/store/workspace'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  FolderKanban,
  Library,
  GitCompareArrows,
  Brain,
  Settings,
  HardHat,
} from 'lucide-react'

const NAV_ITEMS: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'opportunities', label: 'Opportunities', icon: FolderKanban },
  { id: 'work-library', label: 'Work Library', icon: Library },
  { id: 'subcontracting', label: 'Subcontracting', icon: GitCompareArrows },
  { id: 'knowledge', label: 'Knowledge', icon: Brain },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const view = useWorkspace((s) => s.view)
  const setView = useWorkspace((s) => s.setView)
  const closeOpportunity = useWorkspace((s) => s.closeOpportunity)

  return (
    <aside className="hidden md:flex w-60 flex-col border-r border-border bg-sidebar text-sidebar-foreground shrink-0">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <HardHat className="h-5 w-5" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Contractor OS</span>
          <span className="text-[11px] text-muted-foreground">Adom Construction Ltd</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => {
                setView(item.id)
                if (item.id === 'opportunities') closeOpportunity()
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="border-t border-sidebar-border px-5 py-4 space-y-2">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
          Domain Invariants
        </div>
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          Estimate is canonical.<br />
          BOQ is a projection.<br />
          AI never commits prices.
        </div>
      </div>
    </aside>
  )
}
