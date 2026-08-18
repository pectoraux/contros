import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'

/**
 * GET /api/plan/measurements/:measurementId
 *
 * Retrieve the complete provenance chain for a PlanMeasurement:
 *   measurement → revision → sheet → artifact → estimateLines
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ measurementId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { measurementId } = await params

    const result = await planService.getProvenanceChain({ ctx, planMeasurementId: measurementId })

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
