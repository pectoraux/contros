'use client'

import { useEffect, useState } from 'react'
import { apiGet, type SubcontractReconciliation, type OpportunityListItem } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { useWorkspace } from '@/store/workspace'
import { formatGHS, formatPct, severityStyle } from '@/lib/format'
import { GitCompareArrows, ChevronRight, Info, AlertTriangle } from 'lucide-react'

export function SubcontractingView() {
  const [opps, setOpps] = useState<OpportunityListItem[]>([])
  const [reconciliations, setReconciliations] = useState<Record<string, SubcontractReconciliation>>({})
  const [loading, setLoading] = useState(true)
  const openOpportunity = useWorkspace((s) => s.openOpportunity)

  useEffect(() => {
    let mounted = true
    apiGet<{ opportunities: OpportunityListItem[] }>('/api/opportunities')
      .then(async (r) => {
        setOpps(r.opportunities)
        const results: Record<string, SubcontractReconciliation> = {}
        await Promise.all(
          r.opportunities.map(async (o) => {
            try {
              const rec = await apiGet<SubcontractReconciliation>(`/api/subcontract/${o.id}`)
              if (rec.packages.length > 0) results[o.id] = rec
            } catch {
              // ignore
            }
          }),
        )
        if (mounted) setReconciliations(results)
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const oppsWithPackages = opps.filter((o) => reconciliations[o.id])
  const totalPackages = Object.values(reconciliations).reduce((s, r) => s + r.packages.length, 0)
  const unselected = Object.values(reconciliations).reduce(
    (s, r) => s + r.packages.filter((p) => !p.selectedQuoteId).length,
    0,
  )

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <GitCompareArrows className="h-5 w-5" /> Subcontracting
        </h2>
        <p className="text-sm text-muted-foreground">
          {totalPackages} packages across {oppsWithPackages.length} opportunities · {unselected} awaiting quote selection
        </p>
      </div>

      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-foreground">INVARIANT:</strong> Subcontract scope must be reconciled against required scope.
            Coverage gaps and exclusions are surfaced explicitly — never buried.
          </div>
        </CardContent>
      </Card>

      {opssWithPackages.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No subcontract packages across any opportunity.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {opssWithPackages.map((o) => {
            const rec = reconciliations[o.id]
            return (
              <Card key={o.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{o.title}</CardTitle>
                      <CardDescription>{o.client.name} · {rec.packages.length} package(s)</CardDescription>
                    </div>
                    <button
                      onClick={() => openOpportunity(o.id, 'subcontractors')}
                      className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                      Open <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {rec.packages.map((pkg) => (
                    <div key={pkg.id} className="p-3 rounded-md border border-border">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{pkg.name}</span>
                          {!pkg.selectedQuoteId && pkg.quotes.length > 0 && (
                            <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                              No quote selected
                            </Badge>
                          )}
                          {pkg.quotes.length === 0 && (
                            <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">
                              No quotes received
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Required: {formatGHS(pkg.requiredScopeValue)}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {pkg.quotes.map((q) => (
                          <div key={q.id} className="flex items-center gap-3">
                            <div className="w-40 text-xs truncate">{q.supplierName}</div>
                            <div className="flex-1">
                              <Progress value={q.coveragePct * 100} className="h-1.5" />
                            </div>
                            <div className="w-12 text-right text-xs font-mono">{formatPct(q.coveragePct, 0)}</div>
                            <Badge variant="outline" className={`text-[9px] w-16 justify-center ${severityStyle(q.reconciliationStatus)}`}>
                              {q.reconciliationStatus}
                            </Badge>
                            <span className="text-xs font-mono w-24 text-right">{formatGHS(q.totalAmount)}</span>
                          </div>
                        ))}
                      </div>
                      {pkg.quotes.some((q) => q.exclusions.length > 0) && (
                        <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-border/50">
                          <AlertTriangle className="h-3 w-3 text-amber-600 shrink-0 mt-0.5" />
                          <div className="text-[11px] text-amber-700">
                            Exclusions detected: {pkg.quotes.flatMap((q) => q.exclusions).slice(0, 3).join(', ')}
                            {pkg.quotes.flatMap((q) => q.exclusions).length > 3 && '...'}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
