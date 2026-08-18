import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * GET /api/programmes/:programmeId/revisions/compare?from=revA&to=revB
 *
 * Compare two ProgrammeRevisions revision-to-revision. Gives a genuinely
 * historical answer to:
 *   "What changed from Programme Revision 3 to Revision 4?"
 *
 * Query params:
 *   from — the "before" revision ID
 *   to   — the "after" revision ID
 *
 * Both revisions must belong to the same programme (and the same tenant).
 *
 * The comparison categorizes changes as:
 *   - "schedule" — duration / dependency changes (change CPM outputs)
 *   - "presentation" — name / sequence changes (do NOT change CPM outputs)
 *   - "construction" — EstimateLine / WDV / plannedQuantity / added / removed
 *
 * THIN ROUTE: requireAuth → programmeService.compareRevisions() → JSON.
 *
 * Response:
 *   200 → { ok: true, summary, from, to }
 *   404 → programme or revision not found / wrong tenant / mismatched programme
 *   401/403 → auth errors
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ programmeId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId } = await params
    const url = new URL(_req.url)
    const fromRevisionId = url.searchParams.get('from')
    const toRevisionId = url.searchParams.get('to')

    if (!fromRevisionId || !toRevisionId) {
      return NextResponse.json(
        { error: 'Both "from" and "to" revision IDs are required as query parameters' },
        { status: 422 },
      )
    }

    const result = await programmeService.compareRevisions({
      ctx,
      programmeId,
      fromRevisionId,
      toRevisionId,
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
