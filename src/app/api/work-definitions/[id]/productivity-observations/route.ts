import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/work-definitions/[id]/productivity-observations
// Record a productivity observation (human-only, INVARIANT 5).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Request body required' }, { status: 400 })
    }
    const result = await knowledgeService.recordProductivityObservation({
      ctx,
      workDefinitionVersionId: body.workDefinitionVersionId,
      quantityCompleted: body.quantityCompleted,
      daysTaken: body.daysTaken,
      crewSize: body.crewSize,
      plannedProductivity: body.plannedProductivity,
      sourceReference: body.sourceReference,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      observationId: result.observationId,
      variancePct: result.variancePct,
    }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
