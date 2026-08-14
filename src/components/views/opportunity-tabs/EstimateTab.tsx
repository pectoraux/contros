'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { apiPost } from '@/lib/api'
import type { OpportunityDetail, EstimateLine } from '@/lib/api'
import { formatGHS, formatPct, statusStyle, statusLabel, EXECUTION_STRATEGY_LABELS } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { toast } from 'sonner'
import {
  Sparkles,
  HelpCircle,
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react'

export function EstimateTab({ opp, onReload }: { opp: OpportunityDetail; onReload: () => void }) {
  const estimate = opp.estimates[0]
  const openProvenance = useWorkspace((s) => s.openProvenance)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)
  const [recomputing, setRecomputing] = useState<string | null>(null)

  if (!estimate) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No estimate yet for this opportunity.
        </CardContent>
      </Card>
    )
  }

  async function recompute(line: EstimateLine) {
    setRecomputing(line.id)
    try {
      const result = await apiPost<{ line: EstimateLine }>(
        `/api/estimates/${estimate!.id}/price-line`,
        { estimateLineId: line.id },
      )
      toast.success(`Rate recomputed: GHS ${result.line.unitRate.toFixed(2)}/${result.line.unit}${result.line.isUnsourced ? ' [UNSOURCED]' : ''}`)
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recompute failed')
    } finally {
      setRecomputing(null)
    }
  }

  const totalDirect = estimate.lines.reduce((s, l) => s + l.directCost, 0)
  const totalRisk = estimate.lines.reduce((s, l) => s + l.riskCost, 0)
  const totalOverhead = estimate.lines.reduce((s, l) => s + l.overheadCost, 0)
  const totalProfit = estimate.lines.reduce((s, l) => s + l.profitCost, 0)
  const totalSell = estimate.lines.reduce((s, l) => s + l.sellPrice, 0)

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Direct Cost</div>
            <div className="text-lg font-mono font-semibold mt-1">{formatGHS(totalDirect)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Risk</div>
            <div className="text-lg font-mono font-semibold mt-1">{formatGHS(totalRisk)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Overhead + Profit</div>
            <div className="text-lg font-mono font-semibold mt-1">{formatGHS(totalOverhead + totalProfit)}</div>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Sell Price</div>
            <div className="text-lg font-mono font-semibold mt-1">{formatGHS(totalSell)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Avg Margin</div>
            <div className="text-lg font-mono font-semibold mt-1">{formatPct(estimate.averageMarginPct / 100)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Policy banner */}
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Cost policy · overhead{' '}
            <span className="font-mono font-medium text-foreground">{formatPct(estimate.overheadPct)}</span> · profit{' '}
            <span className="font-mono font-medium text-foreground">{formatPct(estimate.profitPct)}</span> · contingency{' '}
            <span className="font-mono font-medium text-foreground">{formatPct(estimate.contingencyPct)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[11px] ${statusStyle(estimate.status)}`}>
              {statusLabel(estimate.status)}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              v{estimate.version} · {estimate.lines.length} lines
            </Badge>
            {estimate.unsourcedLineCount > 0 && (
              <Badge variant="outline" className="text-[11px] bg-amber-50 text-amber-700 border-amber-200">
                {estimate.unsourcedLineCount} unsourced
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Estimate lines table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Estimate Lines</CardTitle>
              <CardDescription>
                Each rate is computed by the deterministic pricing engine — provenance is traceable.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => openAiPanel('general')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              AI review
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[240px]">Description</TableHead>
                  <TableHead>Work Definition</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Direct Cost</TableHead>
                  <TableHead className="text-right">Unit Rate</TableHead>
                  <TableHead className="text-right">Sell Price</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-center">Confidence</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {estimate.lines.map((line) => (
                  <TableRow key={line.id} className="align-top">
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium leading-snug">{line.description}</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge variant="outline" className="text-[10px]">
                            {EXECUTION_STRATEGY_LABELS[line.executionStrategy] ?? line.executionStrategy}
                          </Badge>
                          {line.isUnsourced && (
                            <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                              unsourced
                            </Badge>
                          )}
                          {line.acknowledged && (
                            <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                              <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
                              ack
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {line.workDefinition ? (
                        <div className="flex flex-col">
                          <span className="text-xs font-mono">{line.workDefinition.code}</span>
                          <span className="text-[11px] text-muted-foreground">{line.workDefinition.name}</span>
                          {line.workDefinitionVersion && (
                            <span className="text-[10px] text-muted-foreground mt-0.5">
                              v{line.workDefinitionVersion.version} · {line.workDefinitionVersion.approvalState}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">None linked</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {line.quantity.toLocaleString()} {line.unit}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatGHS(line.directCost)}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-medium">
                      {formatGHS(line.unitRate)}
                      <span className="text-[10px] text-muted-foreground">/{line.unit}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">{formatGHS(line.sellPrice)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatPct(line.marginPct)}</TableCell>
                    <TableCell className="text-center">
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex items-center gap-1">
                          <div className="w-10 h-1.5 bg-muted rounded overflow-hidden">
                            <div
                              className={`h-full ${line.confidence >= 0.7 ? 'bg-emerald-500' : line.confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500'}`}
                              style={{ width: `${line.confidence * 100}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">{formatPct(line.confidence, 0)}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] gap-1"
                          onClick={() => openProvenance(line.id)}
                          title="Why this price?"
                        >
                          <HelpCircle className="h-3 w-3" />
                          Why?
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] gap-1"
                          onClick={() => recompute(line)}
                          disabled={recomputing === line.id}
                          title="Recompute rate via pricing engine"
                        >
                          <RefreshCw className={`h-3 w-3 ${recomputing === line.id ? 'animate-spin' : ''}`} />
                          Recompute
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] gap-1"
                          onClick={() => openAiPanel('explain-rate', line.id)}
                          title="Ask AI to explain this rate"
                        >
                          <Sparkles className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Cost build-up waterfall */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Cost Build-Up
          </CardTitle>
          <CardDescription>From resource cost → sell price (deterministic)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { label: 'Direct cost (material + labour + plant + subcontract)', value: totalDirect, color: 'bg-zinc-400' },
              { label: 'Risk / contingency', value: totalRisk, color: 'bg-amber-400' },
              { label: 'Overhead', value: totalOverhead, color: 'bg-orange-400' },
              { label: 'Profit', value: totalProfit, color: 'bg-emerald-400' },
            ].map((row) => {
              const pct = totalSell > 0 ? (row.value / totalSell) * 100 : 0
              return (
                <div key={row.label} className="flex items-center gap-3">
                  <div className="w-64 text-xs text-muted-foreground shrink-0">{row.label}</div>
                  <div className="flex-1 h-7 bg-muted rounded overflow-hidden relative">
                    <div className={`h-full ${row.color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="w-32 text-right text-xs font-mono">{formatGHS(row.value)}</div>
                  <div className="w-12 text-right text-[11px] text-muted-foreground">{pct.toFixed(0)}%</div>
                </div>
              )
            })}
            <div className="flex items-center gap-3 pt-2 border-t border-border mt-2">
              <div className="w-64 text-sm font-semibold shrink-0">Sell price</div>
              <div className="flex-1 h-7" />
              <div className="w-32 text-right text-sm font-mono font-semibold">{formatGHS(totalSell)}</div>
              <div className="w-12" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Revisions */}
      {estimate.revisions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Immutable Revisions</CardTitle>
            <CardDescription>Submitted bids reference a frozen revision — reproducible</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {estimate.revisions.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/40">
                  <span className="text-sm">Revision {r.revisionNo}</span>
                  <span className="text-xs text-muted-foreground">{new Date(r.finalizedAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {recomputing && <Skeleton className="h-1 w-full" />}
    </div>
  )
}
