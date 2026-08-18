import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * PATCH /api/programmes/:programmeId/activities/:activityId
 *
 * Update an activity's duration — the first controlled schedule mutation.
 *
 * The user edits workspace INPUTS (duration); the scheduling engine derives
 * schedule OUTPUTS (start, finish, float, critical path). The UI never
 * edits computed CPM dates directly.
 *
 * Body: { duration: number }
 *
 * THIN ROUTE: requireAuth → parse params → programmeService.updateActivityDuration()
 * → JSON response with updated ScheduleResult.
 *
 * Response:
 *   200 → { ok: true, schedule, programmeName }
 *   404 → programme or activity not found / wrong tenant
 *   422 → invalid duration (NaN, Infinity, negative)
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
    const { duration } = body as { duration?: number }

    if (duration === undefined || typeof duration !== 'number') {
      return NextResponse.json(
        { error: 'duration is required and must be a number' },
        { status: 422 },
      )
    }

    const result = await programmeService.updateActivityDuration({
      ctx,
      programmeId,
      activityId,
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
