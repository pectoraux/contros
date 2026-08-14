'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { OpportunityDetail } from '@/lib/api'
import { formatPct, severityStyle } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { Sparkles, FileQuestion, AlertTriangle, FileText, Paperclip } from 'lucide-react'

export function ScopeTab({ opp, onReload }: { opp: OpportunityDetail; onReload: () => void }) {
  const openAiPanel = useWorkspace((s) => s.openAiPanel)
  void onReload
  const scope = opp.scopePackage

  if (!scope) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No scope package yet for this opportunity.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Completeness banner */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Scope Package</CardTitle>
              <CardDescription>
                Origin: <span className="capitalize">{scope.origin}</span> · completeness derived deterministically
              </CardDescription>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold">{formatPct(scope.completeness)}</div>
              <div className="text-[11px] text-muted-foreground">complete</div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={scope.completeness * 100} className="h-2" />
          <div className="grid grid-cols-3 gap-3 mt-4 text-center">
            <div>
              <div className="text-lg font-mono text-emerald-700">{scope.items.filter((i) => i.status === 'known').length}</div>
              <div className="text-[11px] text-muted-foreground">Known</div>
            </div>
            <div>
              <div className="text-lg font-mono text-red-700">{scope.items.filter((i) => i.status === 'missing').length}</div>
              <div className="text-[11px] text-muted-foreground">Missing</div>
            </div>
            <div>
              <div className="text-lg font-mono text-amber-700">{scope.items.filter((i) => i.status === 'ambiguous').length}</div>
              <div className="text-[11px] text-muted-foreground">Ambiguous</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Scope items */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" /> Scope Items
            </CardTitle>
            <CardDescription>What is explicitly specified, inferred, or missing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-y-auto">
            {scope.items.map((item) => (
              <div key={item.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/40">
                <Badge
                  variant="outline"
                  className={`text-[10px] uppercase shrink-0 ${
                    item.status === 'known'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : item.status === 'missing'
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                  }`}
                >
                  {item.status}
                </Badge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-snug">{item.description}</p>
                  <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2">
                    <span className="capitalize">origin: {item.origin}</span>
                    {item.category && <span>· {item.category}</span>}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Scope questions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileQuestion className="h-4 w-4" /> Scope Questions
                </CardTitle>
                <CardDescription>First-class ambiguity records with cost/programme impact</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => openAiPanel('draft-clarification')}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Draft clarification
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 max-h-96 overflow-y-auto">
            {scope.questions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No open questions.</p>
            ) : (
              scope.questions.map((q) => (
                <div key={q.id} className="p-3 rounded-md border border-border space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug">{q.question}</p>
                    <Badge variant="outline" className={`text-[10px] shrink-0 ${severityStyle(q.status === 'open' ? 'warning' : 'pass')}`}>
                      {q.status}
                    </Badge>
                  </div>
                  {(q.interpretationA || q.interpretationB) && (
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      {q.interpretationA && (
                        <div className="p-1.5 rounded bg-muted/50">
                          <span className="text-muted-foreground">A:</span> {q.interpretationA}
                        </div>
                      )}
                      {q.interpretationB && (
                        <div className="p-1.5 rounded bg-muted/50">
                          <span className="text-muted-foreground">B:</span> {q.interpretationB}
                        </div>
                      )}
                    </div>
                  )}
                  {q.selectedInterpretation && (
                    <div className="text-[11px] text-emerald-700">
                      Selected: {q.selectedInterpretation}
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    {q.costImpact > 0 && <span>Cost: +GHS {q.costImpact.toLocaleString()}</span>}
                    {q.programmeImpact > 0 && <span>Programme: +{q.programmeImpact}d</span>}
                    {q.category && <span className="capitalize">· {q.category}</span>}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Assumptions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Assumptions
            </CardTitle>
            <CardDescription>Commercial protections — must be acknowledged</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-80 overflow-y-auto">
            {scope.assumptions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No assumptions recorded.</p>
            ) : (
              scope.assumptions.map((a) => (
                <div key={a.id} className="p-2 rounded-md border border-border">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm leading-snug">{a.text}</p>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="outline" className={`text-[10px] ${severityStyle(a.riskLevel === 'high' ? 'blocker' : a.riskLevel === 'medium' ? 'warning' : 'info')}`}>
                        {a.riskLevel}
                      </Badge>
                      <Badge variant="outline" className={`text-[10px] ${a.acknowledged ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {a.acknowledged ? 'ack' : 'unack'}
                      </Badge>
                    </div>
                  </div>
                  {a.rationale && (
                    <p className="text-[11px] text-muted-foreground mt-1">{a.rationale}</p>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Evidence */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Paperclip className="h-4 w-4" /> Evidence
            </CardTitle>
            <CardDescription>Source documents supporting the scope</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-80 overflow-y-auto">
            {scope.evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No evidence attached.</p>
            ) : (
              scope.evidence.map((e) => (
                <div key={e.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/40">
                  <Badge variant="outline" className="text-[10px] uppercase shrink-0">
                    {e.type}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug">{e.summary}</p>
                    {e.reference && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Ref: {e.reference}</p>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
