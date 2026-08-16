import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { scopeWorkspaceService } from '@/application/scope-workspace-service'

// GET /api/opportunities/[id]/scope-workspace
// Returns scope completeness, blockers, and items with estimate-line links.
// Thin adapter — no Prisma in the route.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await scopeWorkspaceService.getScopeWorkspace({
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
