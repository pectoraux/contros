'use client'

import { useEffect, useState } from 'react'
import { apiGet, type SubcontractReconciliation } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { useWorkspace } from '@/store/workspace'
import { formatGHS, formatPct, severityStyle } from '@/lib/format'
import { GitCompareArrows, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react'

export function SubcontractorsTab({ opp }: { opp: OpportunityDetail }) {
  const [data, setData] = useState<SubcontractReconciliation | null>(null)
  const [loading, setLoading] = useState(true)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)

  useEffect(() => {
    let mounted = true
    apiGet<SubcontractReconciliation>(`/api/subcontract/${opp.id}`)
      .then((d) => mounted && setData(d))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [opp.id])

  if (loading) return <Skeleton className="h-96" />
  if (!data || data.packages.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No subcontract packages for this opportunity.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <GitCompareArrows className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-foreground">INVARIANT:</strong> Subcontract scope must be reconciled against required scope.
            No subcontract quote is selectable without coverage being visible.
          </div>
        </CardContent>
      </Card>

      {data.packages.map((pkg) => (
        <Card key={pkg.id}>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">{pkg.name}</CardTitle>
                <CardDescription className="capitalize">
                  {pkg.executionStrategy} · status {pkg.status} · {pkg.quotes.length} quote{pkg.quotes.length !== 1 ? 's' : ''}
                </CardDescription>
              </div>
              {pkg.hasUnselectedQuote && (
                <Badge variant="outline" className="text-[11px] bg-amber-50 text-amber-700 border-amber-200">
                  No quote selected
                </Badge>
              )}
              {pkg.hasNoQuotes && (
                <Badge variant="outline" className="text-[11px] bg-red-50 text-red-700 border-red-200">
                  No quotes received
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Required scope */}
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Required Scope — {formatGHS(pkg.requiredScopeValue)}
              </div>
              <div className="space-y-1">
                {pkg.requiredLines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-muted/40">
                    <span>{l.description}</span>
                    <span className="font-mono text-xs">{formatGHS(l.sellPrice)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quotes with reconciliation */}
            <div className="space-y-3">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Supplier Quotes — Reconciled
              </div>
              {pkg.quotes.map((q) => {
                const isSelected = pkg.selectedQuoteId === q.id
                return (
                  <div
                    key={q.id}
                    className={`p-3 rounded-md border ${isSelected ? 'border-emerald-300 bg-emerald-50/30' : 'border-border'}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{q.supplierName}</span>
                          {isSelected && (
                            <Badge variant="outline" className="text-[10px] bg-emerald-100 text-emerald-800 border-emerald-300">
                              <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                              selected
                            </Badge>
                          )}
                          <Badge variant="outline" className={`text-[10px] ${severityStyle(q.reconciliationStatus)}`}>
                            {q.reconciliationStatus}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {formatGHS(q.totalAmount)} · received {new Date(q.receivedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-mono font-semibold">{formatPct(q.coveragePct)}</div>
                        <div className="text-[11px] text-muted-foreground">coverage</div>
                      </div>
                    </div>

                    <Progress value={q.coveragePct * 100} className="h-1.5 mb-2" />

                    {(q.exclusions.length > 0 || q.assumptions.length > 0 || q.gaps.length > 0) && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                        {q.exclusions.length > 0 && (
                          <div className="p-2 rounded bg-red-50 border border-red-200">
                            <div className="text-[10px] font-medium text-red-700 uppercase mb-1">Exclusions</div>
                            <ul className="text-[11px] text-red-600 space-y-0.5">
                              {q.exclusions.map((e, i) => (
                                <li key={i}>· {e}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {q.gaps.length > 0 && (
                          <div className="p-2 rounded bg-amber-50 border border-amber-200">
                            <div className="text-[10px] font-medium text-amber-700 uppercase mb-1">Uncovered scope</div>
                            <ul className="text-[11px] text-amber-700 space-y-0.5">
                              {q.gaps.map((g, i) => (
                                <li key={i}>· {g}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {q.assumptions.length > 0 && (
                          <div className="p-2 rounded bg-muted/50 border border-border">
                            <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Assumptions</div>
                            <ul className="text-[11px] text-muted-foreground space-y-0.5">
                              {q.assumptions.map((a, i) => (
                                <li key={i}>· {a}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {q.warnings.length > 0 && (
                      <div className="mt-2 flex items-start gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                        <div className="text-[11px] text-amber-700">
                          {q.warnings.join(' · ')}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => openAiPanel('general')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Compare quotes with AI
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
