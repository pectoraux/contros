'use client'

import { useWorkspace } from '@/store/workspace'
import { apiGet, apiPost, type OpportunityDetail } from '@/lib/api'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { X, HelpCircle, ShieldCheck, AlertTriangle, ArrowDown, Sparkles } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { formatGHS, formatPct, formatDate } from '@/lib/format'
import { toast } from 'sonner'

export function ProvenanceDrawer() {
  const lineId = useWorkspace((s) => s.provenanceLineId)
  const opportunityId = useWorkspace((s) => s.opportunityId)
  const closeProvenance = useWorkspace((s) => s.closeProvenance)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)

  const { data: opp } = useQuery({
    queryKey: ['opportunity', opportunityId],
    queryFn: async () => {
      if (!opportunityId) return null
      const r = await apiGet<{ opportunity: OpportunityDetail }>(`/api/opportunities/${opportunityId}`)
      return r.opportunity
    },
    enabled: !!opportunityId,
  })

  const line = opp?.estimates[0]?.lines.find((l) => l.id === lineId) ?? null
  const open = !!lineId && !!line

  let recipe: Array<{
    resourceKind: string
    resourceName: string
    resourceCode: string
    unit: string
    quantityPerUnit: number
    priceObservation: { price: number; provenance: string; sourceReference?: string; observedAt: string } | null
  }> = []

  if (line?.workDefinitionVersion) {
    try {
      recipe = JSON.parse(line.workDefinitionVersion.costRecipeJson || '[]')
    } catch {
      recipe = []
    }
  }

  function recompute() {
    if (!opp?.estimates[0] || !line) return
    apiPost(`/api/estimates/${opp.estimates[0].id}/price-line`, { estimateLineId: line.id })
      .then(() => {
        toast.success('Rate recomputed via deterministic pricing engine')
        closeProvenance()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Recompute failed'))
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeProvenance()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        {line && (
          <>
            <SheetHeader>
              <div className="flex items-center justify-between">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <HelpCircle className="h-4 w-4" />
                  Why this price?
                </SheetTitle>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={closeProvenance}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <SheetDescription className="text-xs">
                Price provenance — fully traceable, deterministic
              </SheetDescription>
            </SheetHeader>

            <div className="px-4 pb-6 space-y-4">
              {/* Line summary */}
              <div className="p-3 rounded-md border border-border bg-muted/30 space-y-2">
                <div className="text-sm font-medium">{line.description}</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Quantity: </span>
                    <span className="font-mono">{line.quantity.toLocaleString()} {line.unit}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Unit rate: </span>
                    <span className="font-mono font-medium">{formatGHS(line.unitRate)}/{line.unit}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Sell price: </span>
                    <span className="font-mono font-medium">{formatGHS(line.sellPrice)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Margin: </span>
                    <span className="font-mono">{formatPct(line.marginPct)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Confidence: </span>
                    <span className="font-mono">{formatPct(line.confidence)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Strategy: </span>
                    <span className="capitalize">{line.executionStrategy}</span>
                  </div>
                </div>
                {line.isUnsourced && (
                  <div className="flex items-start gap-2 p-2 rounded bg-amber-50 border border-amber-200 mt-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-[11px] text-amber-800">
                      <strong>Unsourced estimate.</strong> {line.unsourcedRationale ?? 'Some resources lack price observations.'}
                      <br />
                      Must be acknowledged in the pre-submission control screen before bid finalization.
                    </div>
                  </div>
                )}
              </div>

              {/* Work definition linkage */}
              {line.workDefinition && line.workDefinitionVersion && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" /> Work Definition
                  </h4>
                  <div className="p-3 rounded-md border border-border space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Code</span>
                      <span className="font-mono">{line.workDefinition.code}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Name</span>
                      <span>{line.workDefinition.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Version</span>
                      <span className="font-mono">v{line.workDefinitionVersion.version} ({line.workDefinitionVersion.approvalState})</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Productivity</span>
                      <span className="font-mono">
                        {line.workDefinitionVersion.productivityRule ?? 'n/a'} {line.unit}/crew-day
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Wastage</span>
                      <span className="font-mono">{formatPct(line.workDefinitionVersion.wastage)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Cost recipe with provenance */}
              {recipe.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Cost Recipe & Price Provenance</h4>
                  <div className="space-y-2">
                    {recipe.map((r, i) => (
                      <div key={i} className="p-2 rounded-md border border-border">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge variant="outline" className="text-[9px] capitalize shrink-0">
                              {r.resourceKind}
                            </Badge>
                            <span className="text-xs font-medium truncate">{r.resourceName}</span>
                          </div>
                          <span className="text-[11px] font-mono text-muted-foreground shrink-0">
                            {r.quantityPerUnit} {r.unit}/unit
                          </span>
                        </div>
                        {r.priceObservation ? (
                          <div className="flex items-center gap-2 text-[11px] flex-wrap">
                            <span className="font-mono font-medium">GHS {r.priceObservation.price.toFixed(2)}</span>
                            <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200">
                              {r.priceObservation.provenance}
                            </Badge>
                            {r.priceObservation.sourceReference && (
                              <span className="text-muted-foreground">#{r.priceObservation.sourceReference}</span>
                            )}
                            <span className="text-muted-foreground">{formatDate(r.priceObservation.observedAt)}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-700">
                            <AlertTriangle className="h-3 w-3" />
                            <span>No price observation — UNSOURCED</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Provenance summary text */}
              {line.provenanceSummary && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Provenance Summary</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed p-2 rounded bg-muted/30">
                    {line.provenanceSummary}
                  </p>
                </div>
              )}

              {/* Cost build-up waterfall */}
              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <ArrowDown className="h-4 w-4" /> Cost Build-Up
                </h4>
                <div className="space-y-1 text-xs">
                  {[
                    { label: 'Material', value: line.materialCost },
                    { label: 'Labour', value: line.labourCost },
                    { label: 'Plant', value: line.plantCost },
                    { label: 'Subcontract', value: line.subcontractCost },
                    { label: 'Direct cost', value: line.directCost, bold: true },
                    { label: 'Risk / contingency', value: line.riskCost },
                    { label: 'Overhead', value: line.overheadCost },
                    { label: 'Profit', value: line.profitCost },
                    { label: 'Sell price', value: line.sellPrice, bold: true, highlight: true },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className={`flex items-center justify-between p-1.5 rounded ${
                        row.highlight ? 'bg-primary/10 border border-primary/20' : row.bold ? 'bg-muted/50' : ''
                      }`}
                    >
                      <span className={row.bold ? 'font-medium' : 'text-muted-foreground'}>{row.label}</span>
                      <span className={`font-mono ${row.bold ? 'font-semibold' : ''}`}>{formatGHS(row.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                <Button variant="outline" size="sm" className="gap-2" onClick={recompute}>
                  <ArrowDown className="h-3.5 w-3.5" />
                  Recompute via engine
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    closeProvenance()
                    openAiPanel('explain-rate', line.id)
                  }}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Ask AI to explain
                </Button>
              </div>

              <p className="text-[10px] text-muted-foreground italic">
                INVARIANT: Every important price is traceable. A computed rate is reconstructable from Work Definition
                version → resource price observations → productivity → wastage → overhead/profit policy.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
