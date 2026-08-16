/**
 * Scope Workspace Service — application service for the scope workspace.
 *
 * Architecture:
 *   RequestContext → Service → Repository → Prisma
 *
 * INVARIANT 12: Every query is scoped by ctx.organizationId.
 */

import type { RequestContext } from '@/lib/context'
import { scopeWorkspaceRepository } from '@/repositories'

export interface ScopeBlocker {
  type: 'MISSING_QUANTITY' | 'MISSING_WORK_DEFINITION' | 'UNMAPPED_SCOPE_ITEM' | 'OPEN_QUESTION' | 'UNACKNOWLEDGED_HIGH_RISK_ASSUMPTION'
  severity: 'blocking'
  description: string
}

export interface ScopeWorkspaceItem {
  id: string
  description: string
  category: string | null
  status: string
  origin: string
  hasEstimateLine: boolean
  estimateLineId: string | null
  estimateStatus: string | null
}

export interface ScopeWorkspaceResult {
  completenessPct: number
  totalItems: number
  knownItems: number
  missingItems: number
  ambiguousItems: number
  openQuestions: number
  unacknowledgedHighRiskAssumptions: number
  blockers: ScopeBlocker[]
  items: ScopeWorkspaceItem[]
}

export const scopeWorkspaceService = {
  /**
   * Get the full scope workspace for an opportunity — completeness,
   * blockers, and items with estimate-line links.
   */
  async getScopeWorkspace(input: {
    ctx: RequestContext
    opportunityId: string
  }): Promise<ScopeWorkspaceResult> {
    const { ctx, opportunityId } = input

    const scopePackage = await scopeWorkspaceRepository.getScopePackage(
      ctx.organizationId, opportunityId,
    )

    if (!scopePackage) {
      return {
        completenessPct: 0,
        totalItems: 0,
        knownItems: 0,
        missingItems: 0,
        ambiguousItems: 0,
        openQuestions: 0,
        unacknowledgedHighRiskAssumptions: 0,
        blockers: [{
          type: 'UNMAPPED_SCOPE_ITEM',
          severity: 'blocking',
          description: 'No scope package exists for this opportunity.',
        }],
        items: [],
      }
    }

    // Get items with estimate line links
    const itemsWithLinks = await scopeWorkspaceRepository.getScopeItemsWithEstimateLinks(
      ctx.organizationId, opportunityId,
    )

    // Build item list
    const items: ScopeWorkspaceItem[] = itemsWithLinks.map((item) => ({
      id: item.id,
      description: item.description,
      category: item.category,
      status: item.status,
      origin: item.origin,
      hasEstimateLine: item.estimateLines.length > 0,
      estimateLineId: item.estimateLines[0]?.id ?? null,
      estimateStatus: item.estimateLines[0]?.estimate.status ?? null,
    }))

    // Count blockers
    const unmappedCount = await scopeWorkspaceRepository.countUnmappedScopeItems(
      ctx.organizationId, opportunityId,
    )
    const missingCount = await scopeWorkspaceRepository.countMissingScopeItems(
      ctx.organizationId, opportunityId,
    )
    const openQuestions = await scopeWorkspaceRepository.countOpenQuestions(
      ctx.organizationId, opportunityId,
    )
    const unackHighRisk = await scopeWorkspaceRepository.countUnacknowledgedHighRiskAssumptions(
      ctx.organizationId, opportunityId,
    )

    // Build blockers list
    const blockers: ScopeBlocker[] = []

    if (missingCount > 0) {
      blockers.push({
        type: 'MISSING_QUANTITY',
        severity: 'blocking',
        description: `${missingCount} scope item(s) are marked as "missing" — the scope is incomplete.`,
      })
    }

    if (unmappedCount > 0) {
      blockers.push({
        type: 'UNMAPPED_SCOPE_ITEM',
        severity: 'blocking',
        description: `${unmappedCount} scope item(s) have no linked estimate line — the estimator cannot price them without mapping.`,
      })
    }

    if (openQuestions > 0) {
      blockers.push({
        type: 'OPEN_QUESTION',
        severity: 'blocking',
        description: `${openQuestions} open scope question(s) must be clarified before pricing.`,
      })
    }

    if (unackHighRisk > 0) {
      blockers.push({
        type: 'UNACKNOWLEDGED_HIGH_RISK_ASSUMPTION',
        severity: 'blocking',
        description: `${unackHighRisk} unacknowledged high-risk assumption(s) must be acknowledged before estimating.`,
      })
    }

    return {
      completenessPct: Math.round(scopePackage.completeness * 100),
      totalItems: items.length,
      knownItems: items.filter((i) => i.status === 'known').length,
      missingItems: items.filter((i) => i.status === 'missing').length,
      ambiguousItems: items.filter((i) => i.status === 'ambiguous').length,
      openQuestions,
      unacknowledgedHighRiskAssumptions: unackHighRisk,
      blockers,
      items,
    }
  },
}
