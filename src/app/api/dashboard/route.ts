import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { contractorDashboardService } from '@/application/contractor-dashboard-service'

// Contractor Dashboard — thin adapter to ContractorDashboardService.
// No raw Prisma in the route. All queries are tenant-scoped via ctx.organizationId.
// INVARIANT 12: Every organization is isolated.
export async function GET() {
  try {
    const ctx = await requireAuth()
    const result = await contractorDashboardService.getDashboard({ ctx })
    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
