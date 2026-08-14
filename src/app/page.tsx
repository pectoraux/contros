'use client'

import { useEffect, useState } from 'react'
import { useWorkspace } from '@/store/workspace'
import { Sidebar } from '@/components/workspace/Sidebar'
import { Header } from '@/components/workspace/Header'
import { Footer } from '@/components/workspace/Footer'
import { DashboardView } from '@/components/views/DashboardView'
import { OpportunitiesView } from '@/components/views/OpportunitiesView'
import { OpportunityDetail } from '@/components/views/OpportunityDetail'
import { WorkLibraryView } from '@/components/views/WorkLibraryView'
import { SubcontractingView } from '@/components/views/SubcontractingView'
import { KnowledgeView } from '@/components/views/KnowledgeView'
import { SettingsView } from '@/components/views/SettingsView'
import { AdminView } from '@/components/views/AdminView'
import { AiAssistantPanel } from '@/components/ai/AiAssistantPanel'
import { ProvenanceDrawer } from '@/components/ai/ProvenanceDrawer'
import { AuthScreen } from '@/components/auth/AuthScreen'
import { Skeleton } from '@/components/ui/skeleton'

interface CurrentUser {
  id: string
  name: string | null
  email: string | null
  role: string
  organizationId: string
  isDemo: boolean
}

export default function Home() {
  const view = useWorkspace((s) => s.view)
  const opportunityId = useWorkspace((s) => s.opportunityId)
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined)

  useEffect(() => {
    let mounted = true
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { user: CurrentUser | null }) => mounted && setUser(data.user))
      .catch(() => mounted && setUser(null))
    return () => {
      mounted = false
    }
  }, [])

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="space-y-3 w-full max-w-md px-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (user === null) {
    return <AuthScreen />
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-1">
        <Sidebar userRole={user.role} />
        <div className="flex flex-1 flex-col min-w-0">
          <Header user={user} />
          <main className="flex-1 overflow-y-auto">
            {view === 'dashboard' && <DashboardView />}
            {view === 'opportunities' &&
              (opportunityId ? <OpportunityDetail /> : <OpportunitiesView />)}
            {view === 'work-library' && <WorkLibraryView />}
            {view === 'subcontracting' && <SubcontractingView />}
            {view === 'knowledge' && <KnowledgeView />}
            {view === 'admin' && user.role === 'admin' && <AdminView />}
            {view === 'settings' && <SettingsView user={user} />}
          </main>
        </div>
      </div>
      <Footer />
      <AiAssistantPanel />
      <ProvenanceDrawer />
    </div>
  )
}
