'use client'

/**
 * ProgrammeGantt — a Gantt renderer for ScheduleResult with controlled
 * duration editing.
 *
 * RENDERING CONTRACT:
 *   - This component renders the schedule result from the CPM engine.
 *   - It calculates PIXEL positions (barLeft, barWidth) from the engine's
 *     day-based values, but does NOT calculate scheduling semantics
 *     (start date, finish date, float, critical path, dependency resolution).
 *     Those belong to the CPM engine (replaySchedule).
 *   - The browser renders schedule truth; it does not create schedule truth.
 *
 * EDITING CONTRACT (the first controlled schedule mutation):
 *   - Only `duration` is editable, and ONLY in workspace mode.
 *   - In revision mode (a finalized ProgrammeRevision), every control is
 *     disabled — a historical revision is visibly read-only.
 *   - Start / finish / float / critical-path cells are ALWAYS read-only.
 *     They are CPM-derived outputs, never directly editable.
 *   - On commit, the parent PATCHes the server and replaces the entire
 *     ScheduleResult. There is NO optimistic client-side CPM: the UI waits
 *     for the engine's recomputed result before updating derived cells.
 *
 * Props:
 *   schedule: ScheduleResult (from the CPM engine)
 *   mode: 'revision' | 'workspace'
 *   programmeName: string
 *   revisionNo?: number (for revision mode)
 *   snapshotContentHash?: string (for revision mode provenance)
 *   editable?: boolean (defaults to mode === 'workspace')
 *   programmeId?: string (required when editable)
 *   onCommitDuration?: (activityId, duration) => Promise<boolean>
 *     Returns true on success (schedule was replaced upstream),
 *     false on failure (the row reverts its local input).
 *   savingActivityId?: string | null (activity currently being PATCHed)
 */

import { useState, useEffect, useRef } from 'react'
import { Loader2, Lock } from 'lucide-react'
import type { ScheduleResult, ScheduledActivity } from '@/lib/engines/schedule-engine'
import type { DependencyType } from '@/lib/programme'
import { AddDependencyForm } from './AddDependencyForm'

interface ProgrammeGanttProps {
  schedule: ScheduleResult
  mode: 'revision' | 'workspace'
  programmeName: string
  revisionNo?: number
  snapshotContentHash?: string
  editable?: boolean
  programmeId?: string
  onCommitDuration?: (activityId: string, duration: number) => Promise<boolean>
  savingActivityId?: string | null
  onAddDependency?: (input: {
    predecessorActivityId: string
    successorActivityId: string
    type: DependencyType
    lag: number
  }) => Promise<boolean>
  savingDependency?: boolean
}

// Pixel width per day.
const DAY_WIDTH = 40
const ROW_HEIGHT = 32
const HEADER_HEIGHT = 28

export function ProgrammeGantt({
  schedule,
  mode,
  programmeName,
  revisionNo,
  snapshotContentHash,
  editable = false,
  programmeId,
  onCommitDuration,
  savingActivityId = null,
  onAddDependency,
  savingDependency = false,
}: ProgrammeGanttProps) {
  const { activities, projectDuration, criticalPath } = schedule
  const totalWidth = Math.max(projectDuration * DAY_WIDTH, 200)

  return (
    <div className="space-y-4">
      {/* Provenance header — distinguishes "Current plan" from "Revision N" */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">{programmeName}</h3>
            {mode === 'revision' ? (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" />
                Revision {revisionNo} — finalized (historical truth, read-only)
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Current workspace preview (mutable — not finalized)
              </p>
            )}
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Duration: {projectDuration} days</div>
            <div>Activities: {activities.length}</div>
            {criticalPath.length > 0 && (
              <div>Critical path: {criticalPath.length} activity(ies)</div>
            )}
          </div>
        </div>
        {snapshotContentHash && (
          <p className="mt-2 text-xs text-muted-foreground/60">
            Content hash: {snapshotContentHash.substring(0, 16)}…
          </p>
        )}
      </div>

      {/* Activity table + timeline */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-fit">
          {/* Header row */}
          <div
            className="flex border-b border-border bg-muted/50 font-medium text-sm"
            style={{ height: HEADER_HEIGHT }}
          >
            <div className="w-48 shrink-0 border-r border-border px-3 py-1">Activity</div>
            <div className="w-20 shrink-0 border-r border-border px-3 py-1 text-right">
              Dur
            </div>
            <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right">Start</div>
            <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right">Finish</div>
            <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right">Float</div>
            <div className="w-20 shrink-0 border-r border-border px-3 py-1">Critical</div>
            <div className="grow px-2 py-1 text-xs text-muted-foreground" style={{ minWidth: totalWidth }}>
              Timeline (days)
            </div>
          </div>

          {/* Activity rows */}
          {activities.length === 0 ? (
            <div className="px-3 py-8 text-center text-muted-foreground">
              No activities in this programme.
            </div>
          ) : (
            activities.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                isCritical={criticalPath.includes(activity.id)}
                totalDuration={projectDuration}
                editable={editable}
                saving={savingActivityId === activity.id}
                onCommitDuration={onCommitDuration}
              />
            ))
          )}
        </div>
      </div>

      {/* Edit-mode hint */}
      {editable && (
        <p className="text-xs text-muted-foreground">
          Edit a duration and press Enter (or blur) to recompute the schedule. Start, finish, float
          and critical path are derived by the CPM engine — they are never edited directly.
        </p>
      )}

      {/* Add dependency form — workspace mode only.
          The UI adds workspace INPUTS (predecessor, successor, type, lag);
          the engine derives the schedule OUTPUTS. */}
      {editable && onAddDependency && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h4 className="mb-1 text-sm font-medium">Add dependency</h4>
          <p className="mb-3 text-xs text-muted-foreground">
            Add a precedence edge. The server validates same-programme, no
            self-reference, finite lag, and no resulting cycle before persisting.
          </p>
          <AddDependencyForm
            programmeId={programmeId ?? ''}
            activities={activities}
            onAdd={onAddDependency}
            saving={savingDependency}
          />
        </div>
      )}
    </div>
  )
}

function ActivityRow({
  activity,
  isCritical,
  totalDuration,
  editable,
  saving,
  onCommitDuration,
}: {
  activity: ScheduledActivity
  isCritical: boolean
  totalDuration: number
  editable: boolean
  saving: boolean
  onCommitDuration?: (activityId: string, duration: number) => Promise<boolean>
}) {
  const barLeft = activity.earlyStart * DAY_WIDTH
  const barWidth = Math.max(activity.duration * DAY_WIDTH, 2)
  const floatBarWidth = Math.max(activity.totalFloat * DAY_WIDTH, 0)

  return (
    <div className="flex border-b border-border text-sm hover:bg-muted/30" style={{ height: ROW_HEIGHT }}>
      <div className="w-48 shrink-0 border-r border-border px-3 py-1 truncate" title={activity.name}>
        {activity.name}
      </div>
      <div className="w-20 shrink-0 border-r border-border px-1 py-0.5 flex items-center justify-end">
        <DurationCell
          activityId={activity.id}
          committedDuration={activity.duration}
          editable={editable}
          saving={saving}
          onCommitDuration={onCommitDuration}
        />
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums text-muted-foreground">
        {activity.earlyStart}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums text-muted-foreground">
        {activity.earlyFinish}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums text-muted-foreground">
        {activity.totalFloat > 0 ? activity.totalFloat.toFixed(1) : '—'}
      </div>
      <div className="w-20 shrink-0 border-r border-border px-3 py-1">
        {isCritical ? (
          <span className="inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
            Critical
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
      <div className="grow relative px-2 py-1" style={{ minWidth: totalDuration * DAY_WIDTH }}>
        <div className="absolute inset-0 flex">
          {Array.from({ length: totalDuration + 1 }, (_, i) => (
            <div key={i} className="border-l border-border/30" style={{ width: DAY_WIDTH, height: '100%' }} />
          ))}
        </div>
        {floatBarWidth > 0 && (
          <div
            className="absolute rounded-sm bg-muted-foreground/20"
            style={{ left: barLeft + barWidth, top: 6, width: floatBarWidth, height: ROW_HEIGHT - 14 }}
          />
        )}
        <div
          className={`absolute rounded-sm ${isCritical ? 'bg-red-500 dark:bg-red-600' : 'bg-emerald-500 dark:bg-emerald-600'}`}
          style={{ left: barLeft, top: 6, width: barWidth, height: ROW_HEIGHT - 14 }}
          title={`${activity.name}: ES=${activity.earlyStart} EF=${activity.earlyFinish} TF=${activity.totalFloat.toFixed(1)}`}
        />
      </div>
    </div>
  )
}

/**
 * DurationCell — the ONLY editable cell.
 *
 * Local input state keeps typing responsive. On blur/Enter, the value is
 * committed to the server via `onCommitDuration`. The CPM-derived cells
 * (start/finish/float/critical) are NOT touched here — they update only
 * when the parent replaces the whole ScheduleResult after the PATCH
 * succeeds.
 *
 * If the commit fails, the local input reverts to the committed value.
 * If the commit succeeds, the parent replaces the schedule; the
 * `committedDuration` prop changes and the local state resyncs.
 */
function DurationCell({
  activityId,
  committedDuration,
  editable,
  saving,
  onCommitDuration,
}: {
  activityId: string
  committedDuration: number
  editable: boolean
  saving: boolean
  onCommitDuration?: (activityId: string, duration: number) => Promise<boolean>
}) {
  const [val, setVal] = useState<string>(String(committedDuration))
  const inputRef = useRef<HTMLInputElement>(null)

  // Resync local state when the committed (engine) duration changes — this
  // happens after a successful PATCH replaces the ScheduleResult.
  useEffect(() => {
    setVal(String(committedDuration))
  }, [committedDuration])

  if (!editable) {
    // Read-only: revision mode, or no commit handler. Plain text.
    return <span className="tabular-nums text-muted-foreground px-2">{committedDuration}</span>
  }

  const commit = async () => {
    const trimmed = val.trim()
    const parsed = Number(trimmed)
    // Basic local guard: must be a finite number string. The server does the
    // authoritative validation (NaN / Infinity / negative → 422).
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setVal(String(committedDuration))
      return
    }
    if (parsed === committedDuration) {
      // No change — resync to canonical formatting.
      setVal(String(committedDuration))
      return
    }
    if (!onCommitDuration) return
    const ok = await onCommitDuration(activityId, parsed)
    if (!ok) {
      // Server rejected — revert to the committed value.
      setVal(String(committedDuration))
    }
    // On success, the parent replaces the schedule; the useEffect resyncs.
  }

  return (
    <div className="relative flex items-center">
      <input
        ref={inputRef}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={val}
        disabled={saving}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setVal(String(committedDuration))
            inputRef.current?.blur()
          }
        }}
        className="h-7 w-14 rounded border border-transparent bg-transparent px-2 py-0 text-right tabular-nums outline-none transition-colors hover:border-border focus:border-ring focus:bg-background focus:ring-[2px] focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        title={saving ? 'Saving…' : 'Duration in days (press Enter to commit)'}
      />
      {saving && (
        <Loader2 className="absolute -right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}
