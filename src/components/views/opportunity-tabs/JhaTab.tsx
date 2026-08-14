'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { OpportunityDetail } from '@/lib/api'
import { toast } from 'sonner'
import { ShieldAlert, Download, Info, AlertOctagon, HardHat, ShieldCheck } from 'lucide-react'

export function JhaTab({ opp }: { opp: OpportunityDetail }) {
  const estimate = opp.estimates[0]

  if (!estimate) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No estimate — the JHA is assembled from work definition hazards & controls.
        </CardContent>
      </Card>
    )
  }

  const packages = estimate.lines
    .filter((l) => l.workDefinitionVersion)
    .map((l) => {
      const wdv = l.workDefinitionVersion!
      const hazards = JSON.parse(wdv.hazardsJson || '[]') as string[]
      const controls = JSON.parse(wdv.controlsJson || '[]') as string[]
      return {
        lineId: l.id,
        description: l.description,
        wdCode: l.workDefinition?.code,
        wdName: l.workDefinition?.name,
        hazards,
        controls,
        ppe: wdv.requiredPPE,
        permits: wdv.requiredPermits,
      }
    })

  const totalHazards = packages.reduce((s, p) => s + p.hazards.length, 0)
  const totalControls = packages.reduce((s, p) => s + p.controls.length, 0)

  function exportJha() {
    const md = `# JOB HAZARD ANALYSIS (JHA)

**Project:** ${opp.title}
**Client:** ${opp.client.name}
**Prepared:** ${new Date().toLocaleDateString()}

---

${packages
  .map(
    (p, i) => `## ${i + 1}. ${p.wdName} (${p.wdCode})
**Scope:** ${p.description}

| Hazard | Control |
|--------|---------|
${p.hazards.map((h, j) => `| ${h} | ${p.controls[j] ?? '—'} |`).join('\n')}

**Required PPE:** ${p.ppe ?? 'As per site standard'}
**Required Permits:** ${p.permits ?? 'None'}

`,
  )
  .join('\n')}

---
*Generated from Contractor OS — approved Work Definition hazard & control library. AI may suggest additions but cannot erase approved controls without explicit human action.*
`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `JHA-${opp.title.replace(/\s+/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('JHA exported (assembled from approved hazard & control library)')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Assembled from <strong className="text-foreground">approved Work Definition hazards + controls</strong> — not generated from scratch.
            AI may detect omissions and suggest additions, but must not erase approved controls without explicit human action.
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Work packages</div>
            <div className="text-lg font-mono font-semibold mt-1">{packages.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Hazards identified</div>
            <div className="text-lg font-mono font-semibold mt-1 text-amber-700">{totalHazards}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Controls</div>
            <div className="text-lg font-mono font-semibold mt-1 text-emerald-700">{totalControls}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> JHA — Draft
              </CardTitle>
              <CardDescription>Hazard/control matrix per work package</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportJha}>
              <Download className="h-3.5 w-3.5" />
              Export Markdown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {packages.map((p, i) => (
            <div key={p.lineId} className="p-3 rounded-md border border-border">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="text-[10px] font-mono">{i + 1}</Badge>
                <span className="font-medium text-sm">{p.wdName}</span>
                <Badge variant="outline" className="text-[10px]">{p.wdCode}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mb-2">Scope: {p.description}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2 rounded bg-amber-50 border border-amber-200">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-amber-700 uppercase mb-1">
                    <AlertOctagon className="h-3 w-3" /> Hazards
                  </div>
                  <ul className="text-[11px] text-amber-800 space-y-0.5">
                    {p.hazards.length ? p.hazards.map((h, j) => <li key={j}>· {h}</li>) : <li className="italic">None recorded</li>}
                  </ul>
                </div>
                <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-700 uppercase mb-1">
                    <ShieldAlert className="h-3 w-3" /> Controls
                  </div>
                  <ul className="text-[11px] text-emerald-800 space-y-0.5">
                    {p.controls.length ? p.controls.map((c, j) => <li key={j}>· {c}</li>) : <li className="italic">None recorded</li>}
                  </ul>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 text-[11px]">
                {p.ppe && (
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="h-3 w-3 text-muted-foreground" />
                    <span><strong>PPE:</strong> {p.ppe}</span>
                  </div>
                )}
                {p.permits && (
                  <div className="flex items-center gap-1.5">
                    <HardHat className="h-3 w-3 text-muted-foreground" />
                    <span><strong>Permits:</strong> {p.permits}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
