import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { bidReadinessService } from '@/application/bid-readiness-service'

// GET /api/opportunities/[id]/readiness
// Returns bid readiness gate: scope/pricing/documents/knowledge scores + blockers.
// Thin adapter — no Prisma in the route.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await bidReadinessService.getReadiness({
      ctx,
      opportunityId: id,
    })
    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
