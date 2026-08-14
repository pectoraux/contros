import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { reconcileSubcontract, type ReconcileSubcontractInput } from '@/lib/engines'

// Reconcile subcontract scope: required vs quoted
// Returns coverage %, gaps, exclusions, warnings, status
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params

  const packages = await db.subcontractPackage.findMany({
    where: { opportunityId },
    include: {
      lines: { include: { estimateLine: true } },
      quotes: true,
    },
  })

  const reconciled = packages.map((sp) => {
    const requiredLines = sp.lines.map((l) => ({
      id: l.estimateLineId,
      description: l.requiredScope || l.estimateLine?.description || '',
      sellPrice: l.estimateLine?.sellPrice ?? 0,
    }))

    const quotes = sp.quotes.map((q) => {
      const input: ReconcileSubcontractInput = {
        requiredLines,
        quote: {
          totalAmount: q.totalAmount,
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
        coveragePct: result.coveragePct,
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
}
