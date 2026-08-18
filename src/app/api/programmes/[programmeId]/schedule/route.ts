import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * GET /api/programmes/:programmeId/schedule
 * GET /api/programmes/:programmeId/schedule?revisionId=...
 *
 * Returns the CPM ScheduleResult for a programme — either from an immutable
 * ProgrammeRevision (historical truth) or from the current mutable workspace
 * (live preview).
 *
 * THIN ROUTE: requireAuth → parse params → programmeService.getProgrammeSchedule()
 * → JSON response. No Prisma, no CPM logic in the route.
 *
 * Response shape:
 *   { mode, programmeName, scheduleEngineVersion, revisionId?, revisionNo?,
 *     snapshotContentHash?, schedule }
 *
 * The UI uses `mode` to distinguish "Current workspace preview" from
 * "Revision N — finalized <date>". These must not look equivalent.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ programmeId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId } = await params
    const url = new URL(req.url)
    const revisionId = url.searchParams.get('revisionId') || undefined

    const result = await programmeService.getProgrammeSchedule({
      ctx,
      programmeId,
      revisionId,
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
