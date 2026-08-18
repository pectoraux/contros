'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import type { OpportunityDetail } from '@/lib/api'
import { ProgrammeGantt } from '@/components/views/programme/ProgrammeGantt'
import type { ScheduleResult } from '@/lib/engines/schedule-engine'
import type { DependencyType } from '@/lib/programme'
import type { DependencyItem } from '@/components/views/programme/DependencyList'
import { Info, Loader2 } from 'lucide-react'
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
  dependencies: DependencyItem[]
}

interface PatchResponse {
  ok?: true
  schedule?: ScheduleResult
  programmeName?: string
  dependencies?: DependencyItem[]
  error?: string
}

interface DependencyResponse {
  ok?: true
  schedule?: ScheduleResult
  programmeName?: string
  dependencies?: DependencyItem[]
  error?: string
}

export function ProgrammeTab({ opp }: { opp: OpportunityDetail }) {
  const [programmeId, setProgrammeId] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingActivityId, setSavingActivityId] = useState<string | null>(null)
  const [savingDependency, setSavingDependency] = useState(false)
  const [savingDependencyId, setSavingDependencyId] = useState<string | null>(null)

  useEffect(() => {
    // Try to fetch the programme schedule from the API.
    // If no programme exists yet, show the "no programme" state.
    async function fetchSchedule() {
      setLoading(true)
      setError(null)
      try {
        // First, find a programme for this opportunity.
        const res = await fetch(`/api/programmes/list?opportunityId=${opp.id}`)
        if (res.ok) {
          const programmes = await res.json()
          if (programmes.length > 0) {
            const prog = programmes[0]
            setProgrammeId(prog.id)
            const schedRes = await fetch(`/api/programmes/${prog.id}/schedule`)
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
            setProgrammeId(null)
          }
        } else {
          setSchedule(null)
          setProgrammeId(null)
        }
      } catch {
        setError('Failed to load programme.')
      } finally {
        setLoading(false)
      }
    }
    fetchSchedule()
  }, [opp.id])

  /**
   * Commit a duration edit. The flow is:
   *
   *   duration input
   *       ↓
   *   PATCH /api/programmes/:programmeId/activities/:activityId
   *       ↓
   *   updated ScheduleResult
   *       ↓
   *   replace Gantt state
   *
   * NO optimistic client-side CPM. The UI does not touch start, finish,
   * float, or critical-path values — those are replaced wholesale when
   * the server returns the recomputed ScheduleResult.
   *
   * Returns true on success (the Gantt cell keeps its value), false on
   * failure (the Gantt cell reverts to the committed value).
   */
  const handleCommitDuration = useCallback(
    async (activityId: string, duration: number): Promise<boolean> => {
      if (!programmeId) return false
      setSavingActivityId(activityId)
      try {
        const res = await fetch(
          `/api/programmes/${programmeId}/activities/${activityId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration }),
          },
        )
        const data: PatchResponse = await res.json().catch(() => ({}))
        if (res.ok && data.ok && data.schedule) {
          // Replace the entire schedule state with the engine's recomputed
          // result. Derived cells (start/finish/float/critical) update from
          // the server, never from local calculation.
          setSchedule((prev) =>
            prev
              ? {
                  ...prev,
                  schedule: data.schedule!,
                  programmeName: data.programmeName ?? prev.programmeName,
                  dependencies: data.dependencies ?? prev.dependencies,
                }
              : prev,
          )
          return true
        }
        // Failure: show the server's error, revert the cell.
        toast.error(data.error ?? 'Could not update duration.')
        return false
      } catch {
        toast.error('Network error while updating duration.')
        return false
      } finally {
        setSavingActivityId(null)
      }
    },
    [programmeId],
  )

  /**
   * Commit a new dependency edge. The flow is:
   *
   *   predecessor + successor + type + lag
   *       ↓
   *   POST /api/programmes/:programmeId/dependencies
   *       ↓
   *   updated ScheduleResult
   *       ↓
   *   replace Gantt state
   *
   * NO optimistic client-side CPM. The UI sends only the edge inputs; the
   * server validates (same-tenant, same-programme, activities exist, no
   * self-reference, finite lag, no cycle) inside the Programme-row lock and
   * returns the engine's recomputed ScheduleResult.
   *
   * Returns true on success (the form resets), false on failure (the form
   * keeps its values so the user can adjust and retry).
   */
  const handleAddDependency = useCallback(
    async (input: {
      predecessorActivityId: string
      successorActivityId: string
      type: DependencyType
      lag: number
    }): Promise<boolean> => {
      if (!programmeId) return false
      setSavingDependency(true)
      try {
        const res = await fetch(
          `/api/programmes/${programmeId}/dependencies`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          },
        )
        const data: DependencyResponse = await res.json().catch(() => ({}))
        if (res.ok && data.ok && data.schedule) {
          // Replace the entire schedule state with the engine's recomputed
          // result. The new edge may shift start/finish/float/critical-path
          // values across the whole graph — all derived from the server.
          setSchedule((prev) =>
            prev
              ? {
                  ...prev,
                  schedule: data.schedule!,
                  programmeName: data.programmeName ?? prev.programmeName,
                  dependencies: data.dependencies ?? prev.dependencies,
                }
              : prev,
          )
          return true
        }
        // Failure: show the server's error (e.g. cycle, self-reference).
        toast.error(data.error ?? 'Could not add dependency.')
        return false
      } catch {
        toast.error('Network error while adding dependency.')
        return false
      } finally {
        setSavingDependency(false)
      }
    },
    [programmeId],
  )

  /**
   * Commit a dependency type/lag update. The flow is:
   *
   *   type + lag
   *       ↓
   *   PATCH /api/programmes/:programmeId/dependencies/:dependencyId
   *       ↓
   *   updated ScheduleResult (with updated dependencies list)
   *       ↓
   *   replace Gantt state
   *
   * The dependency ROW ID is the stable identity (U1); type and lag are
   * MUTABLE PROPERTIES. This updates the SAME row — it never creates a
   * competing edge. The UI sends only the property inputs; the server
   * validates (same-tenant, same-programme, dependency exists, finite lag,
   * valid type, no cycle) inside the Programme-row lock and returns the
   * engine's recomputed ScheduleResult + updated dependencies list.
   *
   * Returns true on success (the row keeps its values), false on failure
   * (the row reverts to the committed values).
   */
  const handleUpdateDependency = useCallback(
    async (dependencyId: string, type: DependencyType, lag: number): Promise<boolean> => {
      if (!programmeId) return false
      setSavingDependencyId(dependencyId)
      try {
        const res = await fetch(
          `/api/programmes/${programmeId}/dependencies/${dependencyId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, lag }),
          },
        )
        const data: DependencyResponse = await res.json().catch(() => ({}))
        if (res.ok && data.ok && data.schedule) {
          // Replace the entire schedule state with the engine's recomputed
          // result. The updated type/lag may shift start/finish/float/
          // critical-path values across the whole graph — all derived from
          // the server.
          setSchedule((prev) =>
            prev
              ? {
                  ...prev,
                  schedule: data.schedule!,
                  programmeName: data.programmeName ?? prev.programmeName,
                  dependencies: data.dependencies ?? prev.dependencies,
                }
              : prev,
          )
          return true
        }
        // Failure: show the server's error (e.g. cycle, invalid type).
        toast.error(data.error ?? 'Could not update dependency.')
        return false
      } catch {
        toast.error('Network error while updating dependency.')
        return false
      } finally {
        setSavingDependencyId(null)
      }
    },
    [programmeId],
  )

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

  const isWorkspace = schedule.mode === 'workspace'

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            {isWorkspace ? (
              <>
                Schedule computed by the deterministic CPM engine (replaySchedule). Edit a
                duration to recompute start, finish, float and the critical path — the engine
                derives those outputs, the browser never edits them directly.
              </>
            ) : (
              <>
                This is a finalized ProgrammeRevision — a historical snapshot. It is read-only:
                durations, dependencies and all derived values are frozen. Edit the current
                workspace to produce a new revision.
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <ProgrammeGantt
        schedule={schedule.schedule}
        mode={schedule.mode}
        programmeName={schedule.programmeName}
        revisionNo={schedule.revisionNo}
        snapshotContentHash={schedule.snapshotContentHash}
        editable={isWorkspace}
        programmeId={programmeId ?? undefined}
        onCommitDuration={isWorkspace ? handleCommitDuration : undefined}
        savingActivityId={savingActivityId}
        onAddDependency={isWorkspace ? handleAddDependency : undefined}
        savingDependency={savingDependency}
        dependencies={schedule.dependencies}
        onUpdateDependency={isWorkspace ? handleUpdateDependency : undefined}
        savingDependencyId={savingDependencyId}
      />
    </div>
  )
}
