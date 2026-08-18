import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'

/**
 * POST /api/plan/sheets/:sheetId/revisions
 *
 * Create an immutable PlanSheetRevision.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sheetId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { sheetId } = await params
    const body = await req.json().catch(() => ({}))
    const { revision, fileReference, fileHash } = body as {
      revision?: string
      fileReference?: string
      fileHash?: string
    }

    if (!revision) {
      return NextResponse.json({ error: 'revision is required' }, { status: 422 })
    }

    const result = await planService.createRevision({
      ctx, planSheetId: sheetId, revision, fileReference, fileHash,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
