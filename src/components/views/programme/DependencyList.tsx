'use client'

/**
 * DependencyList — editable list of existing dependency edges.
 *
 * The third and fourth controlled schedule mutations:
 *   - PATCH type and/or lag (partial update — independently mutable)
 *   - DELETE the edge
 *
 * The dependency ROW ID is the stable identity (U1); type and lag are
 * INDEPENDENTLY MUTABLE PROPERTIES. The UI edits each property
 * independently; the scheduling engine (replaySchedule) derives the
 * OUTPUTS (start, finish, float, critical path). This list never
 * calculates dates.
 *
 * Partial commit model:
 *   type Select onChange  → PATCH { type }   (keeps existing lag)
 *   lag Input blur/Enter  → PATCH { lag }    (keeps existing type)
 *   delete button click   → DELETE the edge
 *
 * In revision mode this list renders read-only (no controls).
 */

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, Trash2 } from 'lucide-react'
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

/** Partial update patch — either, both, but not neither (service validates). */
export interface DependencyPatch {
  type?: DependencyType
  lag?: number
}

interface DependencyListProps {
  dependencies: DependencyItem[]
  editable: boolean
  savingDependencyId: string | null
  deletingDependencyId: string | null
  onCommitUpdate: (
    dependencyId: string,
    patch: DependencyPatch,
  ) => Promise<boolean>
  onDelete: (dependencyId: string) => Promise<boolean>
}

const DEPENDENCY_TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF']

export function DependencyList({
  dependencies,
  editable,
  savingDependencyId,
  deletingDependencyId,
  onCommitUpdate,
  onDelete,
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
          deleting={deletingDependencyId === dep.id}
          onCommitUpdate={onCommitUpdate}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

function DependencyRow({
  dep,
  editable,
  saving,
  deleting,
  onCommitUpdate,
  onDelete,
}: {
  dep: DependencyItem
  editable: boolean
  saving: boolean
  deleting: boolean
  onCommitUpdate: (dependencyId: string, patch: DependencyPatch) => Promise<boolean>
  onDelete: (dependencyId: string) => Promise<boolean>
}) {
  const [lagStr, setLagStr] = useState<string>(String(dep.lag))

  // NOTE: local lag state is initialized from props once. When the parent
  // replaces the ScheduleResult after a successful PATCH, this row
  // REMOUNTS (keyed by `${dep.id}:${dep.type}:${dep.lag}`), so the new
  // committed values initialize fresh state. This avoids the
  // setState-in-effect anti-pattern.

  const busy = saving || deleting

  /**
   * Commit TYPE only (partial update). Called immediately when the Select
   * changes. Sends { type } — the service merges with the existing lag.
   */
  const commitType = async (newType: DependencyType) => {
    if (!editable || newType === dep.type) return
    await onCommitUpdate(dep.id, { type: newType })
  }

  /**
   * Commit LAG only (partial update). Called on blur/Enter. Sends { lag }
   * — the service merges with the existing type.
   */
  const commitLag = async () => {
    if (!editable) return
    const trimmed = lagStr.trim()
    const parsed = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(parsed)) {
      setLagStr(String(dep.lag))
      return
    }
    if (parsed === dep.lag) {
      setLagStr(String(dep.lag))
      return
    }
    await onCommitUpdate(dep.id, { lag: parsed })
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

      {/* Type (editable in workspace mode — commits on change) */}
      {editable ? (
        <Select
          value={dep.type}
          onValueChange={(v) => commitType(v as DependencyType)}
          disabled={busy}
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

      {/* Lag (editable in workspace mode — commits on blur/Enter) */}
      {editable ? (
        <Input
          type="number"
          inputMode="numeric"
          value={lagStr}
          onChange={(e) => setLagStr(e.target.value)}
          onBlur={commitLag}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setLagStr(String(dep.lag))
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="h-7 w-20 tabular-nums"
          title="Lag in days (press Enter to commit)"
        />
      ) : (
        <span className="inline-flex w-20 justify-end tabular-nums text-muted-foreground">
          {dep.lag}d
        </span>
      )}

      {/* Delete button (workspace mode only) */}
      {editable && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          disabled={busy}
          onClick={() => onDelete(dep.id)}
          title="Delete dependency"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      )}

      {/* Saving spinner (for type/lag PATCH in flight) */}
      {editable && saving && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}
