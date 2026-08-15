import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { bidService } from '@/application/bid-service'

/**
 * Pre-submission control gate — thin adapter for bidService.runSubmissionGate().
 *
 * The service owns: tenant validation, ownership resolution, gate engine invocation,
 * and the structured gate result.
 *
 * INVARIANT 8: Submitted bids are reproducible from immutable revisions.
 * INVARIANT 12: scoped by ctx.organizationId.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId } = await params
    const result = await bidService.runSubmissionGate({ ctx, opportunityId })

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
