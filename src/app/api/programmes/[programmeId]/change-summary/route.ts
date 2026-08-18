import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * GET /api/programmes/:programmeId/change-summary
 *
 * Get a structured change summary comparing the current workspace against
 * the latest finalized ProgrammeRevision. This is the "what changed since
 * last revision?" surface for the finalization UX.
 *
 * The summary categorizes changes as:
 *   - "schedule-affecting" — duration or dependency changes (change CPM outputs)
 *   - "presentation" — name or sequence changes (do NOT change CPM outputs)
 *
 * If no finalized revision exists, returns a summary with all activities/
 * dependencies as "added" (the workspace is entirely new).
 *
 * THIN ROUTE: requireAuth → programmeService.getChangeSummary() → JSON.
 *
 * Response:
 *   200 → { ok: true, summary, latestRevisionNo }
 *   404 → programme not found / wrong tenant
 *   401/403 → auth errors
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ programmeId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId } = await params

    const result = await programmeService.getChangeSummary({ ctx, programmeId })

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
