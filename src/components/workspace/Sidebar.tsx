'use client'

import { useState } from 'react'
import { useWorkspace, type ViewId } from '@/store/workspace'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  FolderKanban,
  Library,
  GitCompareArrows,
  Brain,
  Settings,
  HardHat,
  ShieldCheck,
  Menu,
} from 'lucide-react'

interface NavItem {
  id: ViewId
  label: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'opportunities', label: 'Opportunities', icon: FolderKanban },
  { id: 'work-library', label: 'Work Library', icon: Library },
  { id: 'subcontracting', label: 'Subcontracting', icon: GitCompareArrows },
  { id: 'knowledge', label: 'Knowledge', icon: Brain },
  { id: 'admin', label: 'Admin', icon: ShieldCheck, adminOnly: true },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function NavContent({
  view,
  setView,
  closeOpportunity,
  items,
  onNavigate,
}: {
  view: ViewId
  setView: (v: ViewId) => void
  closeOpportunity: () => void
  items: NavItem[]
  onNavigate?: () => void
}) {
  return (
    <>
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
        {items.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => {
                setView(item.id)
                if (item.id === 'opportunities') closeOpportunity()
                onNavigate?.()
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
    </>
  )
}

export function Sidebar({ userRole = 'estimator' }: { userRole?: string }) {
  const view = useWorkspace((s) => s.view)
  const setView = useWorkspace((s) => s.setView)
  const closeOpportunity = useWorkspace((s) => s.closeOpportunity)
  const [mobileOpen, setMobileOpen] = useState(false)

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || userRole === 'admin')

  return (
    <>
      {/* Mobile nav trigger (visible on small screens) */}
      <div className="md:hidden flex items-center">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" className="px-2">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
              <NavContent
                view={view}
                setView={setView}
                closeOpportunity={closeOpportunity}
                items={items}
                onNavigate={() => setMobileOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop sidebar (hidden on small screens) */}
      <aside className="hidden md:flex w-60 flex-col border-r border-border bg-sidebar text-sidebar-foreground shrink-0">
        <NavContent
          view={view}
          setView={setView}
          closeOpportunity={closeOpportunity}
          items={items}
        />
      </aside>
    </>
  )
}
