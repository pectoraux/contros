/**
 * Scope Workspace Repository — tenant-aware queries for the scope workspace.
 *
 * Every method takes orgId as its first parameter and scopes via
 * scopePackage → opportunity → organization.
 *
 * INVARIANT 12: Every organization is isolated.
 */

import { db } from '@/lib/db'

export const scopeWorkspaceRepository = {
  /**
   * Get the full scope package for an opportunity with all children:
   * items, questions, assumptions, evidence.
   */
  async getScopePackage(orgId: string, opportunityId: string) {
    return db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      include: {
        items: true,
        questions: true,
        assumptions: true,
        evidence: true,
      },
    })
  },

  /**
   * Get scope items with their linked estimate lines (if any).
   * This lets the workspace show which scope items have been priced.
   */
  async getScopeItemsWithEstimateLinks(orgId: string, opportunityId: string) {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return []

    return db.scopeItem.findMany({
      where: { scopePackageId: scopePackage.id },
      orderBy: { createdAt: 'asc' },
      include: {
        estimateLines: {
          include: {
            estimate: { select: { id: true, status: true } },
          },
        },
      },
    })
  },

  /**
   * Count scope items that have no linked estimate line.
   * These are "unmapped" — the estimator hasn't created a pricing line for them yet.
   */
  async countUnmappedScopeItems(orgId: string, opportunityId: string): Promise<number> {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return 0

    const items = await db.scopeItem.findMany({
      where: { scopePackageId: scopePackage.id },
      include: { estimateLines: { select: { id: true } } },
    })
    return items.filter((i) => i.estimateLines.length === 0).length
  },

  /**
   * Count scope items with status 'missing' — these are explicitly
   * identified as gaps in the scope.
   */
  async countMissingScopeItems(orgId: string, opportunityId: string): Promise<number> {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return 0

    return db.scopeItem.count({
      where: { scopePackageId: scopePackage.id, status: 'missing' },
    })
  },

  /**
   * Count open (unresolved) scope questions.
   */
  async countOpenQuestions(orgId: string, opportunityId: string): Promise<number> {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return 0

    return db.scopeQuestion.count({
      where: { scopePackageId: scopePackage.id, status: 'open' },
    })
  },

  /**
   * Count unacknowledged high-risk assumptions.
   */
  async countUnacknowledgedHighRiskAssumptions(orgId: string, opportunityId: string): Promise<number> {
    const scopePackage = await db.scopePackage.findFirst({
      where: {
        opportunity: { id: opportunityId, organizationId: orgId },
      },
      select: { id: true },
    })
    if (!scopePackage) return 0

    return db.scopeAssumption.count({
      where: {
        scopePackageId: scopePackage.id,
        riskLevel: 'high',
        acknowledged: false,
      },
    })
  },
}
