'use client'

/**
 * FinalizePanel — the finalization UX surface.
 *
 * Shows the distinction between:
 *   - Current workspace (mutable, unsaved/working plan)
 *   - Latest finalized revision (immutable historical truth)
 *   - Proposed next revision (deterministic snapshot waiting to be finalized)
 *
 * Before finalization, displays a change summary comparing the current
 * workspace against the latest ProgrammeRevision:
 *   - Activities added/removed/renamed/reordered/duration-changed
 *   - Dependencies added/removed/type-changed/lag-changed
 *
 * Changes are labeled as:
 *   - "schedule-affecting" — duration or dependency changes (change CPM outputs)
 *   - "presentation" — name or sequence changes (do NOT change CPM outputs)
 *
 * The Finalize button triggers ProgrammeService.finalizeProgramme() — there
 * is NO client-side "save revision" implementation. The server creates the
 * immutable ProgrammeRevision under the Programme-row lock.
 *
 * Finalization is IRREVERSIBLE: once ProgrammeRevision #N exists, it cannot
 * be edited, deleted, or overwritten. The workspace remains editable and
 * becomes the basis for ProgrammeRevision #N+1.
 */

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Loader2,
  Lock,
  GitCommit,
  Plus,
  Minus,
  Edit3,
  ArrowUpDown,
  Clock,
  Link2,
  Unlink,
  Settings2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ChangeSummary, ActivityChange, DependencyChange } from '@/lib/programme'

interface FinalizePanelProps {
  programmeId: string
  /** Called after a successful finalization to refresh the schedule view. */
  onFinalized: () => void
}

interface ChangeSummaryResponse {
  ok: true
  summary: ChangeSummary
  latestRevisionNo: number | null
}

interface FinalizeResponse {
  ok?: true
  revisionId?: string
  revisionNo?: number
  snapshotContentHash?: string
  scheduleEngineVersion?: number
  error?: string
}

export function FinalizePanel({ programmeId, onFinalized }: FinalizePanelProps) {
  const [summary, setSummary] = useState<ChangeSummary | null>(null)
  const [latestRevisionNo, setLatestRevisionNo] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [finalizing, setFinalizing] = useState(false)

  const fetchSummary = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/programmes/${programmeId}/change-summary`)
      if (res.ok) {
        const data: ChangeSummaryResponse = await res.json()
        setSummary(data.summary)
        setLatestRevisionNo(data.latestRevisionNo)
      }
    } catch {
      // Non-fatal — the panel just won't show the summary
    } finally {
      setLoading(false)
    }
  }, [programmeId])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  const handleFinalize = async () => {
    setFinalizing(true)
    try {
      const res = await fetch(
        `/api/programmes/${programmeId}/finalize`,
        { method: 'POST' },
      )
      const data: FinalizeResponse = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success(
          `Revision ${data.revisionNo} finalized (immutable). Content hash: ${data.snapshotContentHash?.substring(0, 12)}…`,
        )
        // Refresh the change summary (should now show no changes).
        await fetchSummary()
        // Notify the parent to refresh the schedule view.
        onFinalized()
      } else {
        toast.error(data.error ?? 'Could not finalize revision.')
      }
    } catch {
      toast.error('Network error while finalizing.')
    } finally {
      setFinalizing(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading change summary…
        </CardContent>
      </Card>
    )
  }

  const hasChanges = summary?.hasChanges ?? false
  const nextRevisionNo = (latestRevisionNo ?? 0) + 1

  return (
    <Card>
      <CardContent className="py-4 space-y-4">
        {/* State summary */}
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium flex items-center gap-1.5">
              <GitCommit className="h-4 w-4" />
              Finalization
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {latestRevisionNo !== null ? (
                <>Latest finalized: <span className="font-medium">Revision {latestRevisionNo}</span> (immutable)</>
              ) : (
                <>No finalized revisions yet</>
              )}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Proposed next</p>
            <p className="text-sm font-medium">Revision {nextRevisionNo}</p>
          </div>
        </div>

        {/* Change summary */}
        {summary && hasChanges && (
          <ChangeSummaryView summary={summary} />
        )}

        {/* No changes */}
        {summary && !hasChanges && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {latestRevisionNo !== null ? (
              <>The workspace is identical to Revision {latestRevisionNo}. No changes to finalize.</>
            ) : (
              <>The workspace is empty — nothing to finalize.</>
            )}
          </div>
        )}

        {/* Finalize button */}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleFinalize}
            disabled={finalizing || !hasChanges}
            className="shrink-0"
          >
            {finalizing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Finalizing…
              </>
            ) : (
              <>
                <Lock className="h-4 w-4" />
                Finalize Revision {nextRevisionNo}
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            Finalization is <strong>irreversible</strong>. The workspace remains editable
            and becomes the basis for the next revision.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Change summary view ────────────────────────────────────────────────────

function ChangeSummaryView({ summary }: { summary: ChangeSummary }) {
  const { activities, dependencies, counts, hasScheduleChanges, hasPresentationChanges } = summary

  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      {/* Summary header */}
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">What changed since last revision:</span>
        {hasScheduleChanges && (
          <span className="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            schedule-affecting
          </span>
        )}
        {hasPresentationChanges && (
          <span className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
            presentation
          </span>
        )}
      </div>

      {/* Activity changes */}
      {activities.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Activities</p>
          {activities.map((c, i) => (
            <ActivityChangeRow key={`${c.activityId}-${c.kind}-${i}`} change={c} />
          ))}
        </div>
      )}

      {/* Dependency changes */}
      {dependencies.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Dependencies</p>
          {dependencies.map((c, i) => (
            <DependencyChangeRow key={`${c.predecessorActivityId}-${c.successorActivityId}-${c.kind}-${i}`} change={c} />
          ))}
        </div>
      )}

      {/* Counts summary */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground pt-1 border-t border-border/50">
        {counts.activitiesAdded > 0 && <span>+{counts.activitiesAdded} added</span>}
        {counts.activitiesRemoved > 0 && <span>−{counts.activitiesRemoved} removed</span>}
        {counts.activitiesRenamed > 0 && <span>{counts.activitiesRenamed} renamed</span>}
        {counts.activitiesReordered > 0 && <span>{counts.activitiesReordered} reordered</span>}
        {counts.activitiesDurationChanged > 0 && <span>{counts.activitiesDurationChanged} duration</span>}
        {counts.dependenciesAdded > 0 && <span>+{counts.dependenciesAdded} deps</span>}
        {counts.dependenciesRemoved > 0 && <span>−{counts.dependenciesRemoved} deps</span>}
        {counts.dependenciesTypeChanged > 0 && <span>{counts.dependenciesTypeChanged} type</span>}
        {counts.dependenciesLagChanged > 0 && <span>{counts.dependenciesLagChanged} lag</span>}
      </div>
    </div>
  )
}

function ActivityChangeRow({ change }: { change: ActivityChange }) {
  const icon = getActivityIcon(change.kind)
  const label = getActivityLabel(change.kind)
  const isSchedule = change.scheduleAffecting

  // Derive display name and old→new values from the from/to state.
  // For "added": from is null, show the "to" name.
  // For "removed": to is null, show the "from" name.
  // For others: both exist; show the "to" name + the specific old→new value.
  const displayName = change.to?.name ?? change.from?.name ?? change.activityId
  const { oldVal, newVal } = getActivityChangeValues(change)

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={isSchedule ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}>
        {icon}
      </span>
      <span className="font-medium truncate">{displayName}</span>
      <span className="text-muted-foreground">{label}</span>
      {oldVal !== undefined && newVal !== undefined && (
        <span className="text-muted-foreground tabular-nums">
          {String(oldVal)} → {String(newVal)}
        </span>
      )}
      <span className={`ml-auto text-[10px] ${isSchedule ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`}>
        {isSchedule ? 'schedule' : 'presentation'}
      </span>
    </div>
  )
}

/** Extract the specific old→new values for an activity change based on kind. */
function getActivityChangeValues(change: ActivityChange): { oldVal?: string | number; newVal?: string | number } {
  if (!change.from || !change.to) return {}
  switch (change.kind) {
    case 'renamed':
      return { oldVal: change.from.name, newVal: change.to.name }
    case 'reordered':
      return { oldVal: change.from.sequence, newVal: change.to.sequence }
    case 'duration-changed':
      return { oldVal: change.from.duration, newVal: change.to.duration }
    case 'estimate-line-changed':
      return { oldVal: change.from.estimateLineId ?? 'none', newVal: change.to.estimateLineId ?? 'none' }
    case 'wdv-changed':
      return { oldVal: change.from.workDefinitionVersionId ?? 'none', newVal: change.to.workDefinitionVersionId ?? 'none' }
    case 'planned-quantity-changed':
      return { oldVal: change.from.plannedQuantity ?? 'none', newVal: change.to.plannedQuantity ?? 'none' }
    default:
      return {}
  }
}

function DependencyChangeRow({ change }: { change: DependencyChange }) {
  const icon = getDependencyIcon(change.kind)
  const label = getDependencyLabel(change.kind)

  // Derive display names from from/to state.
  // For "added": from is null, use "to" names.
  // For "removed": to is null, use "from" names.
  // For type/lag changes: both exist — show from→to if names differ, else just "to".
  const fromNames = change.from
    ? `${change.from.predecessorName} → ${change.from.successorName}`
    : null
  const toNames = change.to
    ? `${change.to.predecessorName} → ${change.to.successorName}`
    : null

  // Show the "to" names (or "from" if removed) as the primary display.
  const displayNames = toNames ?? fromNames ?? ''

  // For type/lag changes, show the specific old→new value.
  const { oldVal, newVal } = getDependencyChangeValues(change)

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-amber-600 dark:text-amber-400">{icon}</span>
      <span className="font-medium truncate">{displayNames}</span>
      <span className="text-muted-foreground">{label}</span>
      {oldVal !== undefined && newVal !== undefined && (
        <span className="text-muted-foreground tabular-nums">
          {String(oldVal)} → {String(newVal)}
        </span>
      )}
      <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">schedule</span>
    </div>
  )
}

/** Extract the specific old→new values for a dependency change based on kind. */
function getDependencyChangeValues(change: DependencyChange): { oldVal?: string | number; newVal?: string | number } {
  if (!change.from || !change.to) return {}
  switch (change.kind) {
    case 'type-changed':
      return { oldVal: change.from.type, newVal: change.to.type }
    case 'lag-changed':
      return { oldVal: change.from.lag, newVal: change.to.lag }
    default:
      return {}
  }
}

function getActivityIcon(kind: ActivityChange['kind']) {
  switch (kind) {
    case 'added': return <Plus className="h-3.5 w-3.5" />
    case 'removed': return <Minus className="h-3.5 w-3.5" />
    case 'renamed': return <Edit3 className="h-3.5 w-3.5" />
    case 'reordered': return <ArrowUpDown className="h-3.5 w-3.5" />
    case 'duration-changed': return <Clock className="h-3.5 w-3.5" />
  }
}

function getActivityLabel(kind: ActivityChange['kind']) {
  switch (kind) {
    case 'added': return 'added'
    case 'removed': return 'removed'
    case 'renamed': return 'renamed'
    case 'reordered': return 'reordered'
    case 'duration-changed': return 'duration'
  }
}

function getDependencyIcon(kind: DependencyChange['kind']) {
  switch (kind) {
    case 'added': return <Link2 className="h-3.5 w-3.5" />
    case 'removed': return <Unlink className="h-3.5 w-3.5" />
    case 'type-changed': return <Settings2 className="h-3.5 w-3.5" />
    case 'lag-changed': return <Clock className="h-3.5 w-3.5" />
  }
}

function getDependencyLabel(kind: DependencyChange['kind']) {
  switch (kind) {
    case 'added': return 'added'
    case 'removed': return 'removed'
    case 'type-changed': return 'type'
    case 'lag-changed': return 'lag'
  }
}
