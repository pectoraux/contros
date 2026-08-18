import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * GET /api/programmes/list?opportunityId=...
 *
 * Returns the list of programmes for the authenticated organization,
 * optionally filtered by opportunity.
 *
 * THIN ROUTE: requireAuth → programmeService.listProgrammes() → JSON.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth()
    const url = new URL(req.url)
    const opportunityId = url.searchParams.get('opportunityId') || undefined

    const programmes = await programmeService.listProgrammes(ctx, opportunityId)
    return NextResponse.json(programmes)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
