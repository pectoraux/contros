import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import {
  reconcileSubcontract,
  type ReconcileSubcontractInput,
  type ScopeAtomInput,
  type QuoteScopeCoverageInput,
} from '@/lib/engines'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Reconcile subcontract scope: required vs quoted.
// P0-7: structured scope-atom reconciliation (no substring matching, no lump-sum 100%).
// Returns coverage %, coverageBasis, atomReconciliations, excluded/unstated/covered atoms,
// gaps, exclusions, warnings, status.
// INVARIANT 12: scoped by ctx.organizationId — verifies opportunity ownership.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId } = await params

    // Verify the opportunity belongs to ctx.organizationId.
    const opportunity = await db.opportunity.findFirst({
      where: { id: opportunityId, organizationId: ctx.organizationId },
      select: { id: true },
    })
    if (!opportunity) {
      return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
    }

    const packages = await db.subcontractPackage.findMany({
      where: { organizationId: ctx.organizationId, opportunityId },
      include: {
        lines: { include: { estimateLine: true } },
        quotes: { include: { scopeCoverages: true } },
        scopeAtoms: true,
      },
    })

    const reconciled = packages.map((sp) => {
      const requiredLines = sp.lines.map((l) => ({
        id: l.estimateLineId,
        description: l.requiredScope || l.estimateLine?.description || '',
        sellPrice: l.estimateLine?.sellPrice ?? 0,
      }))

      // P0-7: structured scope atoms.
      const scopeAtoms: ScopeAtomInput[] = sp.scopeAtoms.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? undefined,
      }))

      const quotes = sp.quotes.map((q) => {
        // P0-7: quote.scopeCoverages replaces the legacy `lines` heuristic.
        const scopeCoverages: QuoteScopeCoverageInput[] = q.scopeCoverages.map((c) => ({
          scopeAtomId: c.scopeAtomId,
          status: c.status as 'covered' | 'excluded' | 'unstated',
          note: c.note ?? undefined,
        }))
        const input: ReconcileSubcontractInput = {
          requiredLines,
          scopeAtoms,
          quote: {
            id: q.id,
            totalAmount: q.totalAmount,
            scopeCoverages,
            exclusionsJson: q.exclusionsJson,
            assumptionsJson: q.assumptionsJson,
          },
        }
        const result = reconcileSubcontract(input)
        return {
          id: q.id,
          supplierName: q.supplierName,
          totalAmount: q.totalAmount,
          currency: q.currency,
          status: q.status,
          receivedAt: q.receivedAt,
          exclusions: JSON.parse(q.exclusionsJson || '[]') as string[],
          assumptions: JSON.parse(q.assumptionsJson || '[]') as string[],
          // P0-7 new fields
          coveragePct: result.coveragePct,
          coverageBasis: result.coverageBasis,
          isLumpSum: result.isLumpSum,
          atomReconciliations: result.atomReconciliations,
          excludedAtoms: result.excludedAtoms,
          unstatedAtoms: result.unstatedAtoms,
          coveredAtoms: result.coveredAtoms,
          // legacy fields (kept for backward-compat)
          coveredScopeValue: result.coveredScopeValue,
          uncoveredValue: result.uncoveredValue,
          gaps: result.gaps,
          warnings: result.warnings,
          reconciliationStatus: result.status,
        }
      })

      const selectedQuote = quotes.find((q) => q.id === sp.selectedQuoteId) ?? null
      const requiredScopeValue = requiredLines.reduce((s, l) => s + l.sellPrice, 0)

      return {
        id: sp.id,
        name: sp.name,
        scope: sp.scope,
        executionStrategy: sp.executionStrategy,
        status: sp.status,
        selectedQuoteId: sp.selectedQuoteId,
        scopeAtoms: scopeAtoms.map((a) => ({ id: a.id, name: a.name, description: a.description })),
        requiredLines: requiredLines.map((l) => ({
          id: l.id,
          description: l.description,
          sellPrice: l.sellPrice,
        })),
        requiredScopeValue,
        quotes,
        selectedQuote,
        hasUnselectedQuote: !sp.selectedQuoteId && quotes.length > 0,
        hasNoQuotes: quotes.length === 0,
      }
    })

    return NextResponse.json({ packages: reconciled })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
