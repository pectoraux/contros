import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * PATCH /api/programmes/:programmeId/dependencies/:dependencyId
 *
 * Update a dependency's type and/or lag — the third controlled schedule
 * mutation.
 *
 * The dependency ROW ID is the stable identity (U1); type and lag are
 * MUTABLE PROPERTIES. This method updates the SAME row — it never creates
 * a competing edge. To change the ordered pair (predecessor/successor),
 * delete + create.
 *
 * Body:
 *   {
 *     type: 'FS' | 'SS' | 'FF' | 'SF',
 *     lag: number
 *   }
 *
 * Both fields are required: this endpoint replaces the type/lag of the
 * relationship wholesale. A partial update (type only, or lag only) would
 * require the caller to know the current value of the other field, which
 * they do — they read it from the schedule. Keeping the contract explicit
 * avoids ambiguity.
 *
 * THIN ROUTE: requireAuth → parse → programmeService.updateDependency() →
 * JSON response with the updated ScheduleResult.
 *
 * The server validates (inside the Programme-row lock):
 *   same tenant · same programme · dependency exists · finite lag
 *   valid type · updated graph has no cycle
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName }
 *   404 → programme or dependency not found / wrong tenant
 *   422 → invalid type, non-finite lag, or cycle
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

    // Basic presence + shape validation. The service does the authoritative
    // domain validation (type ∈ {FS,SS,FF,SF}, finite lag, cycle, etc.).
    if (!type || typeof type !== 'string') {
      return NextResponse.json(
        { error: 'type is required (FS, SS, FF, or SF)' },
        { status: 422 },
      )
    }
    if (typeof lag !== 'number') {
      return NextResponse.json(
        { error: 'lag is required and must be a number' },
        { status: 422 },
      )
    }

    const result = await programmeService.updateDependency({
      ctx,
      programmeId,
      dependencyId,
      type: type as 'FS' | 'SS' | 'FF' | 'SF',
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
