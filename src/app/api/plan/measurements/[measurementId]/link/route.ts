import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'

/**
 * POST /api/plan/measurements/:measurementId/link
 *
 * Link a PlanMeasurement to an EstimateLine (mutable current lineage).
 * Sets EstimateLine.currentMeasurementId — NOT ownership. One measurement
 * can support multiple lines. Rebinding doesn't affect the old measurement.
 *
 * Body: { estimateLineId: string }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ measurementId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { measurementId } = await params
    const body = await req.json().catch(() => ({}))
    const { estimateLineId } = body as { estimateLineId?: string }

    if (!estimateLineId) {
      return NextResponse.json({ error: 'estimateLineId is required' }, { status: 422 })
    }

    const result = await planService.linkToEstimateLine({
      ctx,
      estimateLineId,
      planMeasurementId: measurementId,
    })

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
