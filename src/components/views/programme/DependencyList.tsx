'use client'

/**
 * DependencyList — editable list of existing dependency edges.
 *
 * The third controlled schedule mutation (after duration editing and
 * dependency creation): updating a dependency's type and lag.
 *
 * The dependency ROW ID is the stable identity (U1); type and lag are
 * MUTABLE PROPERTIES. The UI edits only those properties; the scheduling
 * engine (replaySchedule) derives the OUTPUTS (start, finish, float,
 * critical path). This list never calculates dates.
 *
 * On commit:
 *   PATCH /api/programmes/:programmeId/dependencies/:dependencyId
 *       ↓
 *   updated ScheduleResult (with updated dependencies list)
 *       ↓
 *   parent replaces Gantt state
 *
 * In revision mode this list is NOT rendered (a finalized revision is
 * read-only).
 */

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import type { DependencyType } from '@/lib/programme'

export interface DependencyItem {
  id: string
  predecessorActivityId: string
  predecessorName: string
  successorActivityId: string
  successorName: string
  type: DependencyType
  lag: number
}

interface DependencyListProps {
  dependencies: DependencyItem[]
  editable: boolean
  savingDependencyId: string | null
  onCommitUpdate: (
    dependencyId: string,
    type: DependencyType,
    lag: number,
  ) => Promise<boolean>
}

const DEPENDENCY_TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF']

export function DependencyList({
  dependencies,
  editable,
  savingDependencyId,
  onCommitUpdate,
}: DependencyListProps) {
  if (dependencies.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No dependencies yet. Add one above.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {dependencies.map((dep) => (
        <DependencyRow
          // Key includes the committed type+lag so the row remounts with
          // fresh local state after a successful PATCH replaces the
          // ScheduleResult. This avoids the setState-in-effect anti-pattern.
          key={`${dep.id}:${dep.type}:${dep.lag}`}
          dep={dep}
          editable={editable}
          saving={savingDependencyId === dep.id}
          onCommitUpdate={onCommitUpdate}
        />
      ))}
    </div>
  )
}

function DependencyRow({
  dep,
  editable,
  saving,
  onCommitUpdate,
}: {
  dep: DependencyItem
  editable: boolean
  saving: boolean
  onCommitUpdate: (dependencyId: string, type: DependencyType, lag: number) => Promise<boolean>
}) {
  const [type, setType] = useState<DependencyType>(dep.type)
  const [lagStr, setLagStr] = useState<string>(String(dep.lag))

  // NOTE: local state is initialized from props once. When the parent
  // replaces the ScheduleResult after a successful PATCH, this row
  // REMOUNTS (keyed by `${dep.id}:${dep.type}:${dep.lag}`), so the new
  // committed values initialize fresh state. This avoids the
  // setState-in-effect anti-pattern.

  const commit = async () => {
    if (!editable) return
    const trimmed = lagStr.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setLagStr(String(dep.lag))
      return
    }
    // Only commit if something changed.
    if (type === dep.type && parsed === dep.lag) {
      setLagStr(String(dep.lag))
      return
    }
    await onCommitUpdate(dep.id, type, parsed)
    // On success, the parent replaces the schedule; the useEffect resyncs.
    // On failure, the parent shows a toast; keep local values so the user
    // can adjust and retry.
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5 text-sm">
      {/* Predecessor → Successor (read-only identity, U1) */}
      <span className="truncate font-medium" title={dep.predecessorName}>
        {dep.predecessorName}
      </span>
      <span className="text-muted-foreground">→</span>
      <span className="truncate font-medium" title={dep.successorName}>
        {dep.successorName}
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Type (editable in workspace mode) */}
      {editable ? (
        <Select
          value={type}
          onValueChange={(v) => setType(v as DependencyType)}
          disabled={saving}
        >
          <SelectTrigger className="w-20 h-7">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEPENDENCY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="inline-flex w-20 justify-center rounded bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">
          {dep.type}
        </span>
      )}

      {/* Lag (editable in workspace mode) */}
      {editable ? (
        <div className="relative flex items-center">
          <Input
            type="number"
            inputMode="numeric"
            value={lagStr}
            onChange={(e) => setLagStr(e.target.value)}
            onBlur={commit}
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setType(dep.type)
                setLagStr(String(dep.lag))
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className="h-7 w-20 tabular-nums"
            title="Lag in days (press Enter to commit)"
          />
          {saving && (
            <Loader2 className="absolute -right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : (
        <span className="inline-flex w-20 justify-end tabular-nums text-muted-foreground">
          {dep.lag}d
        </span>
      )}
    </div>
  )
}
