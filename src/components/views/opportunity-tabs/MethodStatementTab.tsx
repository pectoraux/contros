'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { OpportunityDetail } from '@/lib/api'
import { toast } from 'sonner'
import { FileText, Download, Info, HardHat, Wrench, ClipboardList } from 'lucide-react'

export function MethodStatementTab({ opp }: { opp: OpportunityDetail }) {
  const estimate = opp.estimates[0]

  if (!estimate) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No estimate — the method statement is assembled from work definition fragments.
        </CardContent>
      </Card>
    )
  }

  const fragments = estimate.lines
    .filter((l) => l.workDefinitionVersion?.methodStatementFragment)
    .map((l) => ({
      lineId: l.id,
      description: l.description,
      wdCode: l.workDefinition?.code,
      wdName: l.workDefinition?.name,
      fragment: l.workDefinitionVersion!.methodStatementFragment!,
      sequencing: l.workDefinitionVersion!.sequencing,
      equipment: l.workDefinitionVersion!.equipment,
      crew: l.workDefinitionVersion?.crewComposition,
    }))

  function exportDoc() {
    const md = `# METHOD STATEMENT

**Project:** ${opp.title}
**Client:** ${opp.client.name}
**Prepared:** ${new Date().toLocaleDateString()}

---

## 1. Scope of Works

This method statement covers the execution of works as defined in the project estimate. Each work package follows the approved Work Definition method below.

## 2. Work Packages

${fragments
  .map(
    (f, i) => `
### ${i + 1}. ${f.wdName} (${f.wdCode})
**Linked scope:** ${f.description}
${f.crew ? `**Crew:** ${f.crew}` : ''}
${f.equipment ? `**Equipment:** ${f.equipment}` : ''}
${f.sequencing ? `**Sequencing:** ${f.sequencing}` : ''}

**Method:**
${f.fragment}
`,
  )
  .join('\n')}

## 3. Quality Assurance

All works to be inspected per the work definition QA checklists prior to cover-up.

## 4. Health & Safety

Refer to the project Job Hazard Analysis (JHA) for hazards and controls per work package.

---
*Generated from Contractor OS — approved Work Definitions. This is a working copy; the canonical record is the domain model.*
`
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `MethodStatement-${opp.title.replace(/\s+/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Method Statement exported (assembled from approved Work Definitions)')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Assembled from <strong className="text-foreground">approved Work Definition method fragments</strong> + project conditions —
            not generated from scratch by an LLM. AI may improve wording and detect omissions, but cannot erase approved controls.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Method Statement — Draft
              </CardTitle>
              <CardDescription>{fragments.length} work packages from linked Work Definitions</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportDoc}>
              <Download className="h-3.5 w-3.5" />
              Export Markdown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {fragments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No work definition method fragments linked. Link Work Definitions to estimate lines first.
            </p>
          ) : (
            fragments.map((f, i) => (
              <div key={f.lineId} className="p-3 rounded-md border border-border space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-mono">{i + 1}</Badge>
                    <span className="font-medium text-sm">{f.wdName}</span>
                    <Badge variant="outline" className="text-[10px]">{f.wdCode}</Badge>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">Scope: {f.description}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                  {f.crew && (
                    <div className="flex items-center gap-1.5">
                      <HardHat className="h-3 w-3 text-muted-foreground" />
                      <span>{f.crew}</span>
                    </div>
                  )}
                  {f.equipment && (
                    <div className="flex items-center gap-1.5">
                      <Wrench className="h-3 w-3 text-muted-foreground" />
                      <span>{f.equipment}</span>
                    </div>
                  )}
                  {f.sequencing && (
                    <div className="flex items-center gap-1.5">
                      <ClipboardList className="h-3 w-3 text-muted-foreground" />
                      <span>{f.sequencing}</span>
                    </div>
                  )}
                </div>
                <p className="text-sm leading-relaxed mt-2 p-2 rounded bg-muted/30">{f.fragment}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
