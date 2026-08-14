'use client'

import { useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { OpportunityDetail } from '@/lib/api'
import { generateProgrammeFromEstimate, computeSchedule, type ScheduleActivity } from '@/lib/engines'
import { toast } from 'sonner'
import { CalendarRange, Download, Info, GitBranch } from 'lucide-react'

export function ProgrammeTab({ opp }: { opp: OpportunityDetail }) {
  const estimate = opp.estimates[0]

  const { activities, schedule, duration, criticalPath } = useMemo(() => {
    if (!estimate) return { activities: [], schedule: null, duration: 0, criticalPath: [] }
    const acts = generateProgrammeFromEstimate({
      estimateLines: estimate.lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        workDefinition: l.workDefinitionVersion
          ? { name: l.workDefinition!.name, productivityRule: l.workDefinitionVersion.productivityRule ?? undefined }
          : null,
      })),
      startDate: new Date().toISOString(),
      crewsPerActivity: 2,
    })
    const sched = computeSchedule(acts)
    return { activities: acts, schedule: sched, duration: sched.projectDuration, criticalPath: sched.criticalPath }
  }, [estimate])

  if (!estimate) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No estimate — the programme is generated from estimate quantities × work definition productivity.
        </CardContent>
      </Card>
    )
  }

  function exportMspXml() {
    // Minimal MS Project XML export — working copy, not canonical
    const startDate = new Date()
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>${escapeXml(opp.title)}</Name>
  <StartDate>${startDate.toISOString().split('T')[0]}T08:00:00</StartDate>
  <Tasks>
${activities
  .map(
    (a, i) => `    <Task>
      <ID>${i + 1}</ID>
      <Name>${escapeXml(a.name)}</Name>
      <Duration>PT${a.duration * 8}H</Duration>
      <Start>${new Date(startDate.getTime() + (schedule!.activities[i]?.earlyStart ?? 0) * 86400000).toISOString()}</Start>
      <Critical>${criticalPath.includes(a.id) ? 1 : 0}</Critical>
    </Task>`,
  )
  .join('\n')}
  </Tasks>
</Project>`
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Programme-${opp.title.replace(/\s+/g, '_')}.xml`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Programme exported as MS Project XML (working copy)')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Programme generated from estimate quantities × work-definition productivity. The CPM engine computes real
            early/late start, float, and critical path — not a fake Gantt. Edit afterward; treat exports as working copies.
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Activities</div>
            <div className="text-lg font-mono font-semibold mt-1">{activities.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Duration</div>
            <div className="text-lg font-mono font-semibold mt-1">{duration}d</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Critical path</div>
            <div className="text-lg font-mono font-semibold mt-1">{criticalPath.length}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarRange className="h-4 w-4" /> Gantt — Draft Programme
              </CardTitle>
              <CardDescription>Generated from estimate · CPM-critical activities highlighted</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportMspXml}>
              <Download className="h-3.5 w-3.5" />
              Export MSP XML
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  <th className="text-left p-2 font-medium text-xs w-8">#</th>
                  <th className="text-left p-2 font-medium text-xs min-w-[200px]">Activity</th>
                  <th className="text-right p-2 font-medium text-xs w-20">Dur (d)</th>
                  <th className="text-right p-2 font-medium text-xs w-20">ES</th>
                  <th className="text-right p-2 font-medium text-xs w-20">EF</th>
                  <th className="text-right p-2 font-medium text-xs w-20">Float</th>
                  <th className="text-left p-2 font-medium text-xs min-w-[300px]">Timeline</th>
                </tr>
              </thead>
              <tbody>
                {schedule?.activities.map((a, i) => {
                  const isCritical = criticalPath.includes(a.id)
                  const leftPct = duration > 0 ? (a.earlyStart / duration) * 100 : 0
                  const widthPct = duration > 0 ? (a.duration / duration) * 100 : 0
                  return (
                    <tr key={a.id} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="p-2 font-mono text-xs text-muted-foreground">{i + 1}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          {isCritical && <GitBranch className="h-3 w-3 text-red-500" />}
                          <span className="text-xs">{a.name}</span>
                        </div>
                      </td>
                      <td className="p-2 text-right font-mono text-xs">{a.duration}</td>
                      <td className="p-2 text-right font-mono text-xs text-muted-foreground">{a.earlyStart}</td>
                      <td className="p-2 text-right font-mono text-xs text-muted-foreground">{a.earlyFinish}</td>
                      <td className="p-2 text-right font-mono text-xs">
                        {a.totalFloat === 0 ? (
                          <span className="text-red-600 font-medium">0</span>
                        ) : (
                          a.totalFloat
                        )}
                      </td>
                      <td className="p-2">
                        <div className="relative h-4 bg-muted/50 rounded">
                          <div
                            className={`absolute h-full rounded ${isCritical ? 'bg-red-500' : 'bg-emerald-400'}`}
                            style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 2)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Legend</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <div className="h-3 w-6 bg-red-500 rounded" />
            <span>Critical path (float = 0)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-6 bg-emerald-400 rounded" />
            <span>Non-critical (has float)</span>
          </div>
          <Badge variant="outline" className="text-[10px]">
            ES = Early Start · EF = Early Finish
          </Badge>
        </CardContent>
      </Card>
    </div>
  )
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case "'": return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

// Type import for the schedule result
import type { ScheduleResult } from '@/lib/engines'
