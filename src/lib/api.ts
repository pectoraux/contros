// Typed fetch helpers for Contractor OS API
// All requests use relative paths (Caddy gateway handles port forwarding).

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DashboardData {
  kpis: {
    openOpportunities: number
    bidsDueThisWeek: number
    awaitingQuotes: number
    estimatesNeedingReview: number
    knowledgeAlerts: number
    pipelineValue: number
    blockedPricingItems: number
    submittedBids: number
    awardedProjects: number
  }
  recentActivity: {
    id: string
    action: string
    summary: string
    entityType: string
    entityId: string
    actor: string
    createdAt: string
  }[]
  alerts: {
    id: string
    type: string
    severity: string
    title: string
    detail: string | null
    entityType: string | null
    entityId: string | null
  }[]
  pipelineByStatus: { status: string; count: number }[]
}

export interface OpportunityListItem {
  id: string
  title: string
  reference: string | null
  status: string
  source: string | null
  location: string | null
  submissionDeadline: string | null
  receivedAt: string
  client: { id: string; name: string; sector: string | null }
  owner: { id: string; name: string } | null
  hasEstimate: boolean
  estimateId: string | null
  estimateValue: number
  estimateStatus: string | null
  blockedLineCount: number
  bidOutcome: string | null
  createdAt: string
  updatedAt: string
}

export interface EstimateLine {
  id: string
  description: string
  quantity: number
  unit: string
  executionStrategy: string
  calculationStatus: string
  blockingInputs: unknown[]
  materialCost: number
  labourCost: number
  plantCost: number
  subcontractCost: number
  feeCost: number
  directCost: number
  projectCost: number
  riskCost: number
  overheadCost: number
  profitCost: number
  estimatedTotalCost: number
  expectedProfit: number
  expectedMarginPct: number
  sellPrice: number
  unitRate: number
  marginPct: number
  confidence: number
  provenanceSummary: string | null
  isUnsourced: boolean
  unsourcedRationale: string | null
  unsourcedConfidence: number | null
  acknowledged: boolean
  executionSegments: {
    id: string
    strategy: string
    scopeDefinition: string
    quantityPct: number
    subcontractQuoteId: string | null
    pricingBasis: string | null
    quoteCoversSegmentScope: boolean
  }[]
  scopeItem: { id: string; description: string; status: string } | null
  workDefinition: { id: string; code: string; name: string; unit: string } | null
  workDefinitionVersion: {
    id: string
    version: number
    approvalState: string
    productivityRule: number | null
    wastage: number
    hazardsJson: string
    controlsJson: string
    methodStatementFragment: string | null
    requiredPPE: string | null
    requiredPermits: string | null
    costRecipeJson: string
    subcontractability: string
  } | null
}

export interface OpportunityDetail {
  id: string
  title: string
  reference: string | null
  status: string
  source: string | null
  description: string | null
  location: string | null
  receivedAt: string
  submissionDeadline: string | null
  createdAt: string
  updatedAt: string
  client: {
    id: string
    name: string
    contactName: string | null
    contactEmail: string | null
    contactPhone: string | null
    sector: string | null
  }
  owner: { id: string; name: string; email: string; role: string } | null
  organization: { id: string; name: string; currency: string }
  scopePackage: {
    id: string
    completeness: number
    origin: string
    items: {
      id: string
      description: string
      category: string | null
      origin: string
      status: string
      confidence: number
    }[]
    questions: {
      id: string
      question: string
      category: string | null
      interpretationA: string | null
      interpretationB: string | null
      selectedInterpretation: string | null
      costImpact: number
      programmeImpact: number
      status: string
      resolution: string | null
    }[]
    assumptions: {
      id: string
      text: string
      rationale: string | null
      riskLevel: string
      acknowledged: boolean
    }[]
    evidence: {
      id: string
      type: string
      reference: string | null
      summary: string
    }[]
  } | null
  estimates: {
    id: string
    status: string
    version: number
    overheadPct: number
    profitPct: number
    contingencyPct: number
    totalDirectCost: number
    totalSellPrice: number
    totalCost: number
    averageMarginPct: number
    averageConfidence: number
    unsourcedLineCount: number
    lines: EstimateLine[]
    revisions: { id: string; revisionNo: number; finalizedAt: string }[]
  }[]
  subcontractPackages: {
    id: string
    name: string
    scope: string | null
    executionStrategy: string
    status: string
    selectedQuoteId: string | null
    lines: {
      id: string
      requiredScope: string
      estimateLineId: string
      estimateLine: { id: string; description: string; sellPrice: number; unit: string; quantity: number } | null
    }[]
    quotes: {
      id: string
      supplierName: string
      totalAmount: number
      currency: string
      receivedAt: string
      exclusionsJson: string
      assumptionsJson: string
      coveragePct: number
      status: string
      lines: { id: string; description: string; amount: number; currency: string }[]
    }[]
  }[]
  bid: {
    id: string
    tenderPackStatus: string
    finalPrice: number | null
    directorAdjustment: number
    adjustmentRationale: string | null
    submittedAt: string | null
    outcome: string | null
    lossReason: string | null
    winningPrice: number | null
    ourRank: number | null
    clientFeedback: string | null
  } | null
  auditLogs: {
    id: string
    action: string
    summary: string
    entityType: string
    entityId: string
    actor: string
    createdAt: string
  }[]
  graphInconsistent?: boolean
  inconsistencies?: { path: string; reason: string; entityId: string }[]
}

export interface WorkDefinitionItem {
  id: string
  code: string
  name: string
  industry: string
  category: string | null
  unit: string
  approvalState: string
  currentVersionId: string | null
  versionCount: number
  currentVersion: {
    id: string
    version: number
    approvalState: string
    productivityRule: number | null
    wastage: number
    subcontractability: string
    crewComposition: string | null
    equipment: string | null
    methodStatementFragment: string | null
    hazardsJson: string
    controlsJson: string
    qualityChecklistJson: string
    requiredPPE: string | null
    requiredPermits: string | null
    commonAssumptions: string | null
    commonExclusions: string | null
    costRecipeJson: string
    measurementRule: string | null
    sequencing: string | null
    approvedAt: string | null
  } | null
  versions: { id: string; version: number; approvalState: string; approvedAt: string | null }[]
}

export interface SubcontractReconciliation {
  packages: {
    id: string
    name: string
    scope: string | null
    executionStrategy: string
    status: string
    selectedQuoteId: string | null
    requiredLines: { id: string; description: string; sellPrice: number }[]
    requiredScopeValue: number
    quotes: {
      id: string
      supplierName: string
      totalAmount: number
      currency: string
      status: string
      receivedAt: string
      exclusions: string[]
      assumptions: string[]
      coveragePct: number
      coveredScopeValue: number
      uncoveredValue: number
      gaps: string[]
      warnings: string[]
      reconciliationStatus: string
    }[]
    selectedQuote: SubcontractReconciliation['packages'][number]['quotes'][number] | null
    hasUnselectedQuote: boolean
    hasNoQuotes: boolean
  }[]
}

export interface PreSubmissionResult {
  opportunityId: string
  opportunityTitle: string
  gate: {
    overall: 'pass' | 'warning' | 'blocker'
    checks: { id: string; label: string; status: 'pass' | 'warning' | 'blocker'; detail?: string }[]
  }
  scopeCompleteness: {
    score: number
    knownCount: number
    missingCount: number
    ambiguousCount: number
    known: string[]
    missing: string[]
    ambiguous: string[]
    openQuestions: number
  }
  deliverables: {
    boq: boolean
    programme: boolean
    methodStatement: boolean
    jha: boolean
    tenderPack: boolean
  }
  estimateStatus: string | null
  estimateId: string | null
}

export interface KnowledgeAlertItem {
  id: string
  type: string
  severity: string
  title: string
  detail: string | null
  entityType: string | null
  entityId: string | null
  acknowledged: boolean
  createdAt: string
}

export interface AiAssistantResponse {
  response: string
  skill: string
  context: {
    opportunityId: string | null
    estimateLineId: string | null
    warning: string
  }
  error?: string
  detail?: string
  fallback?: string
}
