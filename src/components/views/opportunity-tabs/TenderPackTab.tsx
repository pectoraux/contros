'use client'

import { useEffect, useState } from 'react'
import { apiGet, type PreSubmissionResult } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { useWorkspace } from '@/store/workspace'
import { severityStyle } from '@/lib/format'
import {
  PackageCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  Sparkles,
  Download,
  Info,
} from 'lucide-react'
import { toast } from 'sonner'

export function TenderPackTab({ opp }: { opp: OpportunityDetail }) {
  const [result, setResult] = useState<PreSubmissionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)

  useEffect(() => {
    let mounted = true
    apiGet<PreSubmissionResult>(`/api/pre-submission/${opp.id}`)
      .then((r) => mounted && setResult(r))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [opp.id])

  if (loading) return <Skeleton className="h-96" />

  const estimate = opp.estimates[0]

  function generateTenderPack() {
    if (!result || result.gate.overall === 'blocker') {
      toast.error('Cannot generate tender pack — blockers must be resolved first')
      return
    }
    toast.success('Tender pack generated (BOQ + Programme + Method Statement + JHA — assembled from canonical domain)')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-foreground">Pre-submission control:</strong> a deterministic validation pipeline runs before
            any bid is finalized. BLOCKER requires explicit resolution or an authorized override. INVARIANT: submitted bids
            are reproducible from immutable revisions.
          </div>
        </CardContent>
      </Card>

      {result && (
        <>
          {/* Overall verdict */}
          <Card className={`border-2 ${result.gate.overall === 'pass' ? 'border-emerald-300' : result.gate.overall === 'warning' ? 'border-amber-300' : 'border-red-300'}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" />
                    Pre-Submission Gate
                  </CardTitle>
                  <CardDescription>Deterministic validation across scope, pricing, subcontracting & deliverables</CardDescription>
                </div>
                <Badge variant="outline" className={`text-sm px-3 py-1 ${severityStyle(result.gate.overall === 'pass' ? 'pass' : result.gate.overall === 'warning' ? 'warning' : 'blocker')}`}>
                  {result.gate.overall.toUpperCase()}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {result.gate.checks.map((check) => {
                  const Icon = check.status === 'pass' ? CheckCircle2 : check.status === 'warning' ? AlertTriangle : XCircle
                  return (
                    <div
                      key={check.id}
                      className={`p-2 rounded-md border ${severityStyle(check.status)}`}
                    >
                      <div className="flex items-start gap-2">
                        <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium leading-snug">{check.label}</div>
                          {check.detail && (
                            <div className="text-[10px] opacity-80 mt-0.5 leading-snug">{check.detail}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Scope completeness detail */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Scope Completeness Detail</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 mb-3">
                <div className="text-2xl font-semibold">{(result.scopeCompleteness.score * 100).toFixed(0)}%</div>
                <div className="flex-1">
                  <Progress value={result.scopeCompleteness.score * 100} className="h-2" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <div className="font-medium text-emerald-700 mb-1">Known ({result.scopeCompleteness.knownCount})</div>
                  <ul className="text-[11px] text-emerald-600 space-y-0.5">
                    {result.scopeCompleteness.known.map((k, i) => <li key={i}>· {k}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="font-medium text-red-700 mb-1">Missing ({result.scopeCompleteness.missingCount})</div>
                  <ul className="text-[11px] text-red-600 space-y-0.5">
                    {result.scopeCompleteness.missing.map((k, i) => <li key={i}>· {k}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="font-medium text-amber-700 mb-1">Ambiguous ({result.scopeCompleteness.ambiguousCount})</div>
                  <ul className="text-[11px] text-amber-600 space-y-0.5">
                    {result.scopeCompleteness.ambiguous.map((k, i) => <li key={i}>· {k}</li>)}
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Deliverables checklist */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <PackageCheck className="h-4 w-4" /> Tender Pack Checklist
              </CardTitle>
              <CardDescription>Assembled from canonical domain model — not generated from scratch</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5">
                {[
                  { key: 'boq', label: 'Bill of Quantities', source: 'Estimate projection' },
                  { key: 'programme', label: 'Programme', source: 'CPM from estimate × productivity' },
                  { key: 'methodStatement', label: 'Method Statement', source: 'Work Definition fragments' },
                  { key: 'jha', label: 'Job Hazard Analysis', source: 'Hazard & control library' },
                  { key: 'tenderPack', label: 'Director approval', source: 'Commercial adjudication' },
                ].map((item) => {
                  const ready = result.deliverables[item.key as keyof typeof result.deliverables]
                  return (
                    <div key={item.key} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/30">
                      {ready ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="text-sm font-medium">{item.label}</div>
                        <div className="text-[11px] text-muted-foreground">{item.source}</div>
                      </div>
                      <Badge variant="outline" className={`text-[10px] ${ready ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                        {ready ? 'READY' : 'MISSING'}
                      </Badge>
                    </div>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-border">
                <Button
                  onClick={generateTenderPack}
                  disabled={result.gate.overall === 'blocker'}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  Generate Tender Pack
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => openAiPanel('tender-readiness')}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  AI: assess tender readiness
                </Button>
                {result.gate.overall === 'blocker' && (
                  <span className="text-[11px] text-red-600">
                    Resolve blockers before generating the tender pack.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Bid outcome */}
          {opp.bid && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Bid Record</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-[11px] text-muted-foreground">Final price</div>
                  <div className="font-mono font-medium">
                    GHS {opp.bid.finalPrice?.toFixed(2) ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Director adjustment</div>
                  <div className="font-mono">
                    {opp.bid.directorAdjustment > 0 ? '+' : ''}{opp.bid.directorAdjustment.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Outcome</div>
                  <Badge variant="outline" className={`text-[11px] ${opp.bid.outcome === 'won' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : opp.bid.outcome === 'lost' ? 'bg-red-100 text-red-800 border-red-300' : ''}`}>
                    {opp.bid.outcome ?? 'pending'}
                  </Badge>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Rank</div>
                  <div className="font-mono">{opp.bid.ourRank ?? '—'}</div>
                </div>
                {opp.bid.clientFeedback && (
                  <div className="col-span-2 sm:col-span-4 text-xs text-muted-foreground italic">
                    Client feedback: "{opp.bid.clientFeedback}"
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!result && estimate && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Pre-submission gate unavailable.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
