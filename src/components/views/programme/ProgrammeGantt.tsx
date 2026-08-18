'use client'

/**
 * ProgrammeGantt — a read-only Gantt renderer for ScheduleResult.
 *
 * PURE RENDERER: this component renders the schedule result from the CPM
 * engine. It calculates PIXEL positions (startOffset, width) from the
 * engine's day-based values, but does NOT calculate scheduling semantics
 * (start date, finish date, float, critical path, dependency resolution).
 * Those belong to the CPM engine (replaySchedule).
 *
 * The browser renders schedule truth; it does not create schedule truth.
 *
 * Props:
 *   schedule: ScheduleResult (from the CPM engine)
 *   mode: 'revision' | 'workspace'
 *   programmeName: string
 *   revisionNo?: number (for revision mode)
 *   snapshotContentHash?: string (for revision mode provenance)
 */

import type { ScheduleResult, ScheduledActivity } from '@/lib/engines/schedule-engine'

interface ProgrammeGanttProps {
  schedule: ScheduleResult
  mode: 'revision' | 'workspace'
  programmeName: string
  revisionNo?: number
  snapshotContentHash?: string
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
              <p className="text-sm text-muted-foreground">
                Revision {revisionNo} — finalized (historical truth)
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
            <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right">Dur</div>
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
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ActivityRow({
  activity,
  isCritical,
  totalDuration,
}: {
  activity: ScheduledActivity
  isCritical: boolean
  totalDuration: number
}) {
  const barLeft = activity.earlyStart * DAY_WIDTH
  const barWidth = Math.max(activity.duration * DAY_WIDTH, 2)
  const floatBarWidth = Math.max(activity.totalFloat * DAY_WIDTH, 0)

  return (
    <div className="flex border-b border-border text-sm hover:bg-muted/30" style={{ height: ROW_HEIGHT }}>
      <div className="w-48 shrink-0 border-r border-border px-3 py-1 truncate" title={activity.name}>
        {activity.name}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums">
        {activity.duration}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums">
        {activity.earlyStart}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums">
        {activity.earlyFinish}
      </div>
      <div className="w-16 shrink-0 border-r border-border px-3 py-1 text-right tabular-nums">
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
          className={`absolute rounded-sm ${isCritical ? 'bg-red-500 dark:bg-red-600' : 'bg-blue-500 dark:bg-blue-600'}`}
          style={{ left: barLeft, top: 6, width: barWidth, height: ROW_HEIGHT - 14 }}
          title={`${activity.name}: ES=${activity.earlyStart} EF=${activity.earlyFinish} TF=${activity.totalFloat.toFixed(1)}`}
        />
      </div>
    </div>
  )
}
