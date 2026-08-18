import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * POST /api/programmes/:programmeId/dependencies
 *
 * Add a dependency edge — the second controlled schedule mutation.
 *
 * The user adds workspace INPUTS (a precedence edge: predecessor, successor,
 * type, lag); the scheduling engine derives schedule OUTPUTS (start, finish,
 * float, critical path). The UI never edits computed CPM dates directly.
 *
 * Body:
 *   {
 *     predecessorActivityId: string,
 *     successorActivityId:   string,
 *     type:                  'FS' | 'SS' | 'FF' | 'SF',
 *     lag:                   number
 *   }
 *
 * THIN ROUTE: requireAuth → parse → programmeService.addDependency() → JSON
 * response with the updated ScheduleResult.
 *
 * The server validates (inside the Programme-row lock):
 *   same tenant · same programme · activities exist · no self-reference
 *   finite lag · valid type · resulting graph has no cycle
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName }
 *   404 → programme or activity not found / wrong tenant
 *   422 → invalid type, non-finite lag, self-reference, or cycle
 *   401/403 → auth errors
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ programmeId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId } = await params
    const body = await req.json().catch(() => ({}))
    const {
      predecessorActivityId,
      successorActivityId,
      type,
      lag,
    } = body as {
      predecessorActivityId?: string
      successorActivityId?: string
      type?: string
      lag?: number
    }

    // Basic presence + shape validation. The service does the authoritative
    // domain validation (type ∈ {FS,SS,FF,SF}, finite lag, cycle, etc.).
    if (!predecessorActivityId || typeof predecessorActivityId !== 'string') {
      return NextResponse.json(
        { error: 'predecessorActivityId is required' },
        { status: 422 },
      )
    }
    if (!successorActivityId || typeof successorActivityId !== 'string') {
      return NextResponse.json(
        { error: 'successorActivityId is required' },
        { status: 422 },
      )
    }
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

    const result = await programmeService.addDependency({
      ctx,
      programmeId,
      predecessorActivityId,
      successorActivityId,
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
