import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { estimateService } from '@/application/estimate-service'

/**
 * Finalize an EstimateRevision — thin adapter for estimateService.finalizeRevision().
 *
 * The service owns: tenant validation, ownership resolution, snapshot construction,
 * persistence, replay sanity check, and audit logging.
 *
 * INVARIANT 8: Submitted bids are reproducible from immutable revisions.
 * INVARIANT 12: scoped by ctx.organizationId.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const { revisionNo } = body as { revisionNo?: number }

    const result = await estimateService.finalizeRevision({
      ctx,
      estimateId: id,
      revisionNo,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      ok: true,
      revisionId: result.revisionId,
      revisionNo: result.revisionNo,
      replay: result.replay,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
