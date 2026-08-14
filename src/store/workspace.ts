import { create } from 'zustand'

export type ViewId =
  | 'dashboard'
  | 'opportunities'
  | 'work-library'
  | 'subcontracting'
  | 'knowledge'
  | 'admin'
  | 'settings'

export type OpportunityTab =
  | 'overview'
  | 'scope'
  | 'estimate'
  | 'boq'
  | 'subcontractors'
  | 'programme'
  | 'method-statement'
  | 'jha'
  | 'tender-pack'
  | 'activity'

interface WorkspaceState {
  view: ViewId
  opportunityId: string | null
  opportunityTab: OpportunityTab
  aiPanelOpen: boolean
  aiSkill: 'explain-rate' | 'identify-gaps' | 'draft-clarification' | 'tender-readiness' | 'general'
  aiTargetLineId: string | null
  provenanceLineId: string | null

  setView: (view: ViewId) => void
  openOpportunity: (id: string, tab?: OpportunityTab) => void
  setOpportunityTab: (tab: OpportunityTab) => void
  closeOpportunity: () => void
  openAiPanel: (skill?: WorkspaceState['aiSkill'], lineId?: string) => void
  closeAiPanel: () => void
  openProvenance: (lineId: string) => void
  closeProvenance: () => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  view: 'dashboard',
  opportunityId: null,
  opportunityTab: 'overview',
  aiPanelOpen: false,
  aiSkill: 'general',
  aiTargetLineId: null,
  provenanceLineId: null,

  setView: (view) =>
    set({ view, opportunityId: view === 'opportunities' ? null : null }),
  openOpportunity: (id, tab = 'overview') =>
    set({ view: 'opportunities', opportunityId: id, opportunityTab: tab }),
  setOpportunityTab: (tab) => set({ opportunityTab: tab }),
  closeOpportunity: () => set({ view: 'opportunities', opportunityId: null }),
  openAiPanel: (skill = 'general', lineId = null) =>
    set({ aiPanelOpen: true, aiSkill: skill, aiTargetLineId: lineId }),
  closeAiPanel: () => set({ aiPanelOpen: false, aiTargetLineId: null }),
  openProvenance: (lineId) => set({ provenanceLineId: lineId }),
  closeProvenance: () => set({ provenanceLineId: null }),
}))
