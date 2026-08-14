'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import type { OpportunityDetail } from '@/lib/api'
import { formatGHS, formatPct, formatDate, daysUntil, statusStyle, statusLabel } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { CalendarClock, MapPin, User, Building2, FileSearch, AlertTriangle, Sparkles } from 'lucide-react'

export function OverviewTab({ opp }: { opp: OpportunityDetail }) {
  const setTab = useWorkspace((s) => s.setOpportunityTab)
  const openAiPanel = useWorkspace((s) => s.openAiPanel)

  const estimate = opp.estimates[0]
  const scope = opp.scopePackage
  const days = daysUntil(opp.submissionDeadline)
  const unsourced = estimate?.lines.filter((l) => l.isUnsourced).length ?? 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Status summary */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Status Summary</CardTitle>
          <CardDescription>Current commercial position</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Opportunity</div>
            <Badge variant="outline" className={`text-[11px] ${statusStyle(opp.status)}`}>
              {statusLabel(opp.status)}
            </Badge>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Estimate</div>
            {estimate ? (
              <Badge variant="outline" className={`text-[11px] ${statusStyle(estimate.status)}`}>
                {statusLabel(estimate.status)}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Bid</div>
            {opp.bid ? (
              <Badge variant="outline" className="text-[11px]">
                {opp.bid.tenderPackStatus}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">Not created</span>
            )}
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Pipeline Value</div>
            <span className="text-sm font-mono font-medium">
              {estimate ? formatGHS(estimate.totalSellPrice) : '—'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Deadline & metadata */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Key Dates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1">
              <div className="text-[11px] text-muted-foreground">Submission deadline</div>
              <div className="font-medium">{formatDate(opp.submissionDeadline)}</div>
            </div>
            {days !== null && (
              <Badge
                variant="outline"
                className={`text-[10px] ${days < 0 ? 'bg-red-100 text-red-800 border-red-300' : days <= 7 ? 'bg-amber-100 text-amber-800 border-amber-300' : ''}`}
              >
                {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1">
              <div className="text-[11px] text-muted-foreground">Client</div>
              <div className="font-medium">{opp.client.name}</div>
            </div>
          </div>
          {opp.location && (
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <div className="text-[11px] text-muted-foreground">Location</div>
                <div className="font-medium">{opp.location}</div>
              </div>
            </div>
          )}
          {opp.owner && (
            <div className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <div className="text-[11px] text-muted-foreground">Owner</div>
                <div className="font-medium">{opp.owner.name}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scope completeness */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileSearch className="h-4 w-4" /> Scope Completeness
              </CardTitle>
              <CardDescription>Deterministic — derived from scope items & questions</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setTab('scope')}>
              Open scope
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {scope ? (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    {formatPct(scope.completeness)} complete
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {scope.items.filter((i) => i.status === 'known').length} known ·{' '}
                    {scope.items.filter((i) => i.status === 'missing').length} missing ·{' '}
                    {scope.items.filter((i) => i.status === 'ambiguous').length} ambiguous
                  </span>
                </div>
                <Progress value={scope.completeness * 100} className="h-2" />
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-2 rounded-md bg-emerald-50 border border-emerald-200">
                  <div className="text-emerald-700 font-medium">Known</div>
                  <div className="text-emerald-600 text-[11px] mt-1">
                    {scope.items.filter((i) => i.status === 'known').slice(0, 3).map((i) => i.description).join(', ') || '—'}
                  </div>
                </div>
                <div className="p-2 rounded-md bg-red-50 border border-red-200">
                  <div className="text-red-700 font-medium">Missing</div>
                  <div className="text-red-600 text-[11px] mt-1">
                    {scope.items.filter((i) => i.status === 'missing').slice(0, 3).map((i) => i.description).join(', ') || '—'}
                  </div>
                </div>
                <div className="p-2 rounded-md bg-amber-50 border border-amber-200">
                  <div className="text-amber-700 font-medium">Ambiguous</div>
                  <div className="text-amber-600 text-[11px] mt-1">
                    {scope.items.filter((i) => i.status === 'ambiguous').slice(0, 3).map((i) => i.description).join(', ') || '—'}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => openAiPanel('identify-gaps')}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Ask AI: identify scope gaps
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No scope package yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Estimate health */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Estimate Health</CardTitle>
              <CardDescription>Latest revision</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setTab('estimate')}>
              Open
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {estimate ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] text-muted-foreground">Direct cost</div>
                  <div className="text-sm font-mono">{formatGHS(estimate.totalDirectCost)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Sell price</div>
                  <div className="text-sm font-mono font-medium">{formatGHS(estimate.totalSellPrice)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Avg margin</div>
                  <div className="text-sm font-mono">{formatPct(estimate.averageMarginPct / 100)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Avg confidence</div>
                  <div className="text-sm font-mono">{formatPct(estimate.averageConfidence)}</div>
                </div>
              </div>
              {unsourced > 0 && (
                <div className="flex items-start gap-2 p-2 rounded-md bg-amber-50 border border-amber-200">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-amber-800">
                    {unsourced} unsourced line{unsourced > 1 ? 's' : ''} — requires acknowledgement before submission.
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No estimate yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
