'use client'

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
import { AiAssistantPanel } from '@/components/ai/AiAssistantPanel'
import { ProvenanceDrawer } from '@/components/ai/ProvenanceDrawer'

export default function Home() {
  const view = useWorkspace((s) => s.view)
  const opportunityId = useWorkspace((s) => s.opportunityId)

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-1">
        <Sidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <Header />
          <main className="flex-1 overflow-y-auto">
            {view === 'dashboard' && <DashboardView />}
            {view === 'opportunities' &&
              (opportunityId ? <OpportunityDetail /> : <OpportunitiesView />)}
            {view === 'work-library' && <WorkLibraryView />}
            {view === 'subcontracting' && <SubcontractingView />}
            {view === 'knowledge' && <KnowledgeView />}
            {view === 'settings' && <SettingsView />}
          </main>
        </div>
      </div>
      <Footer />
      <AiAssistantPanel />
      <ProvenanceDrawer />
    </div>
  )
}
