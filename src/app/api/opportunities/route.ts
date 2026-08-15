import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { opportunityService } from '@/application/opportunity-service'

// List opportunities with client + latest estimate value.
// INVARIANT 12: scoped by ctx.organizationId (enforced by the service).
export async function GET() {
  try {
    const ctx = await requireAuth()
    const result = await opportunityService.listOpportunities({ ctx })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ opportunities: result.opportunities })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
