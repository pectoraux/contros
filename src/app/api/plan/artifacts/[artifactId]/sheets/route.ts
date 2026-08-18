import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'

/**
 * POST /api/plan/artifacts/:artifactId/sheets
 *
 * Create a PlanSheet (logical sheet) within a PlanArtifact.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { artifactId } = await params
    const body = await req.json().catch(() => ({}))
    const { sheetNumber, drawingNumber, title } = body as {
      sheetNumber?: string
      drawingNumber?: string
      title?: string
    }

    if (!sheetNumber) {
      return NextResponse.json({ error: 'sheetNumber is required' }, { status: 422 })
    }

    const result = await planService.createSheet({
      ctx, planArtifactId: artifactId, sheetNumber, drawingNumber, title,
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
