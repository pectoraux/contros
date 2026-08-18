'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { OpportunityDetail } from '@/lib/api'
import { ProgrammeGantt } from '@/components/views/programme/ProgrammeGantt'
import type { ScheduleResult } from '@/lib/engines/schedule-engine'
import { CalendarRange, Download, Info, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface ScheduleResponse {
  ok: true
  mode: 'revision' | 'workspace'
  programmeName: string
  scheduleEngineVersion: number
  revisionId?: string
  revisionNo?: number
  snapshotContentHash?: string
  schedule: ScheduleResult
}

export function ProgrammeTab({ opp }: { opp: OpportunityDetail }) {
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Try to fetch the programme schedule from the API.
    // If no programme exists yet, show the "no programme" state.
    async function fetchSchedule() {
      setLoading(true)
      setError(null)
      try {
        // First, find a programme for this opportunity.
        // For now, we try the schedule endpoint directly — if no programme
        // exists, it returns 404 and we show the empty state.
        const res = await fetch(`/api/programmes/list?opportunityId=${opp.id}`)
        if (res.ok) {
          const programmes = await res.json()
          if (programmes.length > 0) {
            const progId = programmes[0].id
            const schedRes = await fetch(`/api/programmes/${progId}/schedule`)
            if (schedRes.ok) {
              const data = await schedRes.json()
              setSchedule(data)
            } else if (schedRes.status === 422) {
              setError('Programme workspace has invalid schedule data (cycles or invalid values).')
            } else {
              setError('Could not load programme schedule.')
            }
          } else {
            setSchedule(null)
          }
        } else {
          setSchedule(null)
        }
      } catch {
        setError('Failed to load programme.')
      } finally {
        setLoading(false)
      }
    }
    fetchSchedule()
  }, [opp.id])

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading programme schedule…
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!schedule) {
    return (
      <Card>
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            No programme created for this opportunity yet. Programmes are managed
            through the Programme domain — create one, add activities and dependencies,
            then finalize an immutable revision.
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            Schedule computed by the deterministic CPM engine (replaySchedule). The browser renders
            schedule truth; it does not create schedule truth. Critical-path activities are highlighted in red.
          </div>
        </CardContent>
      </Card>

      <ProgrammeGantt
        schedule={schedule.schedule}
        mode={schedule.mode}
        programmeName={schedule.programmeName}
        revisionNo={schedule.revisionNo}
        snapshotContentHash={schedule.snapshotContentHash}
      />
    </div>
  )
}
