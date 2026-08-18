import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * PATCH /api/programmes/:programmeId/activities/:activityId
 *
 * Update an activity's duration, name, and/or sequence — controlled schedule
 * mutations. The user edits workspace INPUTS; the scheduling engine derives
 * schedule OUTPUTS (start, finish, float, critical path). The UI never edits
 * computed CPM dates directly.
 *
 * Body (partial — any subset of these fields):
 *   { duration: number }              → V2: update duration (recompute schedule)
 *   { name: string }                  → R1: rename only (schedule UNCHANGED)
 *   { sequence: number }              → R1: reorder only (swap-on-set; schedule UNCHANGED)
 *   { name: "X", sequence: 2 }        → R1: both rename + reorder
 *   { duration: 5, name: "X" }        → V2 + R1: duration + rename
 *   { duration: 5, sequence: 2 }      → V2 + R1: duration + reorder
 *   { duration: 5, name: "X", sequence: 2 }  → all three
 *   {}                                → 422 (nothing to update)
 *
 * Architectural rule (NON-NEGOTIABLE):
 *   - `sequence` is a mutable PRESENTATION property, NOT a scheduling input.
 *     The CPM engine receives activities by identity + dependency graph.
 *     Ordering is NOT scheduling — `replaySchedule()` still determines dates,
 *     float, and critical path exclusively from duration + dependency inputs.
 *   - `name` is a semantic label on the Activity row. It MUST NOT alter
 *     EstimateLine, WorkDefinitionVersion, ProgrammeRevision, or any
 *     commercial value.
 *
 * Swap-on-set for sequence conflicts: if PATCHing `{ sequence: N }` and
 * another activity in the programme already has sequence N, the service
 * ATOMICALLY SWAPS — the target gets N, the conflicting activity gets the
 * target's old sequence. All under the Programme-row lock.
 *
 * THIN ROUTE: requireAuth → parse params → dispatch to the appropriate
 * service method(s) → JSON response with updated ScheduleResult.
 *
 * When `duration` is present alongside `name`/`sequence`, both services are
 * called (duration first, then name/sequence). Each runs under its own
 * Programme-row lock and returns the complete schedule state; the response
 * reflects the result of the LAST successful call (which reflects all
 * mutations, since each `getProgrammeSchedule` re-reads the workspace).
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName, dependencies }
 *   404 → programme or activity not found / wrong tenant
 *   409 → sequence conflict backstop (should not happen in normal flow)
 *   422 → invalid duration / invalid name / invalid sequence / no fields
 *   401/403 → auth errors
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ programmeId: string; activityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId, activityId } = await params
    const body = await req.json().catch(() => ({}))
    const { duration, name, sequence } = body as {
      duration?: number
      name?: string
      sequence?: number
    }

    // Determine which mutations to run.
    const hasDuration = duration !== undefined
    const hasName = name !== undefined
    const hasSequence = sequence !== undefined

    // At least one field must be provided.
    if (!hasDuration && !hasName && !hasSequence) {
      return NextResponse.json(
        { error: 'At least one of duration, name, or sequence must be provided' },
        { status: 422 },
      )
    }

    // V2: duration mutation (existing) — runs first so the subsequent
    // name/sequence mutation sees the updated duration in its schedule result.
    if (hasDuration) {
      if (typeof duration !== 'number') {
        return NextResponse.json(
          { error: 'duration must be a number' },
          { status: 422 },
        )
      }
      const durationResult = await programmeService.updateActivityDuration({
        ctx,
        programmeId,
        activityId,
        duration,
      })
      if (!durationResult.ok) {
        return NextResponse.json(
          { error: durationResult.error },
          { status: durationResult.status },
        )
      }
      // If this was the only mutation, return its result.
      if (!hasName && !hasSequence) {
        return NextResponse.json(durationResult)
      }
    }

    // R1: name and/or sequence mutation (new). Runs after duration (if any),
    // so the returned schedule reflects all mutations.
    if (hasName || hasSequence) {
      const patch: { name?: string; sequence?: number } = {}
      if (hasName) patch.name = name
      if (hasSequence) patch.sequence = sequence

      const result = await programmeService.updateActivity({
        ctx,
        programmeId,
        activityId,
        ...patch,
      })
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error },
          { status: result.status },
        )
      }
      return NextResponse.json(result)
    }

    // Unreachable: we always either called durationResult, or result, or
    // returned 422 above. This line is a defensive fallback.
    return NextResponse.json(
      { error: 'No update performed' },
      { status: 422 },
    )
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
