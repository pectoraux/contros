import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { opportunityService } from '@/application/opportunity-service'

// Full opportunity detail — scope, estimate+lines, subcontract packages, bid, audit.
// INVARIANT 12: scoped by ctx.organizationId (enforced by the service).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await opportunityService.getOpportunityDetail({ ctx, opportunityId: id })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ opportunity: result.opportunity })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
