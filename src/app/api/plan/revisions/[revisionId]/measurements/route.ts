import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'
import type { MeasurementMethod } from '@/lib/plan'

/**
 * POST /api/plan/revisions/:revisionId/measurements
 *
 * Create a manual PlanMeasurement (immutable, append-only observation).
 * The service validates + computes the content hash; the caller never
 * supplies the hash.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ revisionId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { revisionId } = await params
    const body = await req.json().catch(() => ({}))
    const { elementReference, measurementMethod, quantity, unit, measurementBasisJson } = body as {
      elementReference?: string
      measurementMethod?: string
      quantity?: number
      unit?: string
      measurementBasisJson?: string
    }

    if (measurementMethod === undefined || typeof quantity !== 'number' || !unit) {
      return NextResponse.json(
        { error: 'measurementMethod, quantity, and unit are required' },
        { status: 422 },
      )
    }

    const result = await planService.createMeasurement({
      ctx,
      planSheetRevisionId: revisionId,
      elementReference: elementReference ?? null,
      measurementMethod: measurementMethod as MeasurementMethod,
      quantity,
      unit,
      measurementBasisJson: measurementBasisJson || '{}',
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
