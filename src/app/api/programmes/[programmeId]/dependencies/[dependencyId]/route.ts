import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * PATCH /api/programmes/:programmeId/dependencies/:dependencyId
 *
 * Partial update of a dependency's type and/or lag — the third controlled
 * schedule mutation.
 *
 * The dependency ROW ID is the stable identity (U1); type and lag are
 * INDEPENDENTLY MUTABLE properties. This method updates the SAME row — it
 * never creates a competing edge. To change the ordered pair
 * (predecessor/successor), delete + create.
 *
 * Body (partial — supply either, both, but not neither):
 *   { "type": "SS" }           → change type, keep existing lag
 *   { "lag": 3 }               → change lag, keep existing type
 *   { "type": "SS", "lag": 3 } → change both
 *   {}                         → 422 (nothing to update)
 *
 * The service loads the existing edge under the Programme-row lock, merges
 * the supplied values, validates the complete resulting edge (finite lag,
 * valid type, no cycle), and persists.
 *
 * THIN ROUTE: requireAuth → parse → programmeService.updateDependency() →
 * JSON response with the updated ScheduleResult + dependencies.
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName, dependencies }
 *   404 → programme or dependency not found / wrong tenant
 *   422 → neither field provided, invalid type, non-finite lag, or cycle
 *   401/403 → auth errors
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ programmeId: string; dependencyId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId, dependencyId } = await params
    const body = await req.json().catch(() => ({}))
    const { type, lag } = body as { type?: string; lag?: number }

    // Partial validation: at least one field must be provided. Each
    // supplied field is shape-checked; the service does the authoritative
    // domain validation (type ∈ {FS,SS,FF,SF}, finite lag, cycle, etc.).
    if (type === undefined && lag === undefined) {
      return NextResponse.json(
        { error: 'At least one of type or lag must be provided' },
        { status: 422 },
      )
    }
    if (type !== undefined && typeof type !== 'string') {
      return NextResponse.json(
        { error: 'type must be a string (FS, SS, FF, or SF)' },
        { status: 422 },
      )
    }
    if (lag !== undefined && typeof lag !== 'number') {
      return NextResponse.json(
        { error: 'lag must be a number' },
        { status: 422 },
      )
    }

    const result = await programmeService.updateDependency({
      ctx,
      programmeId,
      dependencyId,
      type: type as 'FS' | 'SS' | 'FF' | 'SF' | undefined,
      lag,
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

/**
 * DELETE /api/programmes/:programmeId/dependencies/:dependencyId
 *
 * Delete a dependency edge — the fourth controlled schedule mutation.
 *
 * Removes the edge from the workspace graph. The scheduling engine
 * (replaySchedule) then derives the OUTPUTS (start, finish, float, critical
 * path) from the reduced graph.
 *
 * THIN ROUTE: requireAuth → programmeService.deleteDependency() → JSON
 * response with the updated ScheduleResult + dependencies.
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName, dependencies }
 *   404 → programme or dependency not found / wrong tenant
 *   401/403 → auth errors
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ programmeId: string; dependencyId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId, dependencyId } = await params

    const result = await programmeService.deleteDependency({
      ctx,
      programmeId,
      dependencyId,
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
