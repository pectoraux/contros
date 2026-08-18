'use client'

/**
 * AddDependencyForm — the UI for adding a precedence edge.
 *
 * The second controlled schedule mutation (after duration editing).
 *
 * The user adds workspace INPUTS only:
 *   predecessorActivityId
 *   successorActivityId
 *   type: FS | SS | FF | SF
 *   lag: number
 *
 * The scheduling engine (replaySchedule) derives the OUTPUTS (start, finish,
 * float, critical path). This form never calculates dates.
 *
 * On submit:
 *   POST /api/programmes/:programmeId/dependencies
 *       ↓
 *   updated ScheduleResult
 *       ↓
 *   parent replaces Gantt state
 *
 * In revision mode this form is NOT rendered (a finalized revision is
 * read-only).
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Loader2 } from 'lucide-react'
import type { ScheduledActivity } from '@/lib/engines/schedule-engine'
import type { DependencyType } from '@/lib/programme'

interface AddDependencyFormProps {
  programmeId: string
  activities: ScheduledActivity[]
  onAdd: (input: {
    predecessorActivityId: string
    successorActivityId: string
    type: DependencyType
    lag: number
  }) => Promise<boolean>
  saving: boolean
}

const DEPENDENCY_TYPES: { value: DependencyType; label: string; hint: string }[] = [
  { value: 'FS', label: 'FS', hint: 'Finish-to-Start' },
  { value: 'SS', label: 'SS', hint: 'Start-to-Start' },
  { value: 'FF', label: 'FF', hint: 'Finish-to-Finish' },
  { value: 'SF', label: 'SF', hint: 'Start-to-Finish' },
]

export function AddDependencyForm({
  programmeId: _programmeId,
  activities,
  onAdd,
  saving,
}: AddDependencyFormProps) {
  const [predecessorId, setPredecessorId] = useState<string>('')
  const [successorId, setSuccessorId] = useState<string>('')
  const [type, setType] = useState<DependencyType>('FS')
  const [lagStr, setLagStr] = useState<string>('0')
  const [error, setError] = useState<string | null>(null)

  const canSubmit =
    !saving &&
    predecessorId !== '' &&
    successorId !== '' &&
    predecessorId !== successorId

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!canSubmit) return

    const lag = Number(lagStr)
    if (lagStr.trim() === '' || !Number.isFinite(lag)) {
      setError('Lag must be a finite number.')
      return
    }

    const ok = await onAdd({
      predecessorActivityId: predecessorId,
      successorActivityId: successorId,
      type,
      lag,
    })
    if (ok) {
      // Reset the form on success.
      setPredecessorId('')
      setSuccessorId('')
      setType('FS')
      setLagStr('0')
    }
    // On failure, the parent shows a toast; keep the form values so the
    // user can adjust and retry.
  }

  if (activities.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        Add at least two activities before creating a dependency.
      </p>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* Predecessor */}
        <div className="space-y-1">
          <Label htmlFor="dep-pred" className="text-xs text-muted-foreground">
            Predecessor
          </Label>
          <Select value={predecessorId} onValueChange={setPredecessorId} disabled={saving}>
            <SelectTrigger id="dep-pred" className="w-48 h-8">
              <SelectValue placeholder="Select activity…" />
            </SelectTrigger>
            <SelectContent>
              {activities.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Type */}
        <div className="space-y-1">
          <Label htmlFor="dep-type" className="text-xs text-muted-foreground">
            Type
          </Label>
          <Select value={type} onValueChange={(v) => setType(v as DependencyType)} disabled={saving}>
            <SelectTrigger id="dep-type" className="w-28 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEPENDENCY_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <span className="font-medium">{t.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t.hint}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Lag */}
        <div className="space-y-1">
          <Label htmlFor="dep-lag" className="text-xs text-muted-foreground">
            Lag (days)
          </Label>
          <Input
            id="dep-lag"
            type="number"
            inputMode="numeric"
            value={lagStr}
            onChange={(e) => setLagStr(e.target.value)}
            disabled={saving}
            className="w-24 h-8"
          />
        </div>

        {/* Arrow + Successor */}
        <div className="space-y-1">
          <Label htmlFor="dep-succ" className="text-xs text-muted-foreground">
            Successor
          </Label>
          <Select value={successorId} onValueChange={setSuccessorId} disabled={saving}>
            <SelectTrigger id="dep-succ" className="w-48 h-8">
              <SelectValue placeholder="Select activity…" />
            </SelectTrigger>
            <SelectContent>
              {activities.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Submit */}
        <Button type="submit" size="sm" disabled={!canSubmit} className="h-8">
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Adding…
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              Add
            </>
          )}
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {/* Inline validation hint */}
      {predecessorId !== '' && successorId !== '' && predecessorId === successorId && (
        <p className="text-xs text-destructive">
          An activity cannot depend on itself.
        </p>
      )}
    </form>
  )
}
