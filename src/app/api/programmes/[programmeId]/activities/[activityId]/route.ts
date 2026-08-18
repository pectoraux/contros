import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * PATCH /api/programmes/:programmeId/activities/:activityId
 *
 * Update an activity's name, sequence, and/or duration — a single atomic
 * controlled schedule mutation. The user edits workspace INPUTS; the
 * scheduling engine derives schedule OUTPUTS (start, finish, float, critical
 * path). The UI never edits computed CPM dates directly.
 *
 * Body (partial — any subset of these fields):
 *   { duration: number }              → V2: update duration (recompute schedule)
 *   { name: string }                  → R1: rename only (schedule UNCHANGED)
 *   { sequence: number }              → R1: reorder only (swap-on-set; schedule UNCHANGED)
 *   { name: "X", sequence: 2 }        → R1: both rename + reorder (schedule UNCHANGED)
 *   { duration: 5, name: "X" }        → V2 + R1: duration + rename (schedule RECOMPUTED)
 *   { duration: 5, sequence: 2 }      → V2 + R1: duration + reorder (schedule RECOMPUTED)
 *   { duration: 5, name: "X", sequence: 2 }  → all three (schedule RECOMPUTED)
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
 *   - `duration` IS a scheduling input — changing it DOES recompute the
 *     schedule outputs.
 *
 * ATOMIC: all supplied fields are updated in ONE transaction under the
 * Programme-row lock. If any validation fails, the whole thing rolls back —
 * no partial state. This is the "one HTTP PATCH = one Programme transaction
 * = atomic workspace mutation" invariant.
 *
 * Swap-on-set for sequence conflicts: if PATCHing `{ sequence: N }` and
 * another activity in the programme already has sequence N, the service
 * ATOMICALLY SWAPS — the target gets N, the conflicting activity gets the
 * target's old sequence. All under the Programme-row lock.
 *
 * THIN ROUTE: requireAuth → parse → programmeService.updateActivity() →
 * JSON response with updated ScheduleResult.
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName, dependencies }
 *   404 → programme or activity not found / wrong tenant
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

    // At least one field must be provided.
    if (duration === undefined && name === undefined && sequence === undefined) {
      return NextResponse.json(
        { error: 'At least one of duration, name, or sequence must be provided' },
        { status: 422 },
      )
    }

    // Basic shape validation. The service does the authoritative domain
    // validation (finite duration, non-empty name, non-negative integer
    // sequence, etc.).
    if (duration !== undefined && typeof duration !== 'number') {
      return NextResponse.json(
        { error: 'duration must be a number' },
        { status: 422 },
      )
    }
    if (name !== undefined && typeof name !== 'string') {
      return NextResponse.json(
        { error: 'name must be a string' },
        { status: 422 },
      )
    }
    if (sequence !== undefined && typeof sequence !== 'number') {
      return NextResponse.json(
        { error: 'sequence must be a number' },
        { status: 422 },
      )
    }

    // Single atomic service call — all fields in one transaction.
    const result = await programmeService.updateActivity({
      ctx,
      programmeId,
      activityId,
      name,
      sequence,
      duration,
    })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      )
    }

    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
