import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { subcontractService } from '@/application/subcontract-service'

/**
 * Get the subcontract workspace for an opportunity — thin adapter for
 * subcontractService.getPackageWorkspace().
 *
 * The service owns: tenant validation, ownership resolution, reconciliation
 * (via the pure engine), and the structured workspace response.
 *
 * INVARIANT 7: Subcontract scope must be reconciled against required scope.
 * INVARIANT 12: scoped by ctx.organizationId.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId } = await params

    const result = await subcontractService.getPackageWorkspace({
      ctx,
      opportunityId,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ packages: result.packages })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
