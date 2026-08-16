import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// GET /api/resources/[id]/price-observations
// List price observations for a resource.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await knowledgeService.listPriceObservations({ ctx, resourceId: id })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ observations: result.observations })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// POST /api/resources/[id]/price-observations
// Record a new price observation (append-only, with provenance).
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
    const result = await knowledgeService.recordPriceObservation({
      ctx,
      resourceId: id,
      workDefinitionVersionId: body.workDefinitionVersionId,
      price: body.price,
      currency: body.currency,
      provenance: body.provenance,
      sourceReference: body.sourceReference,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ observationId: result.observationId }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
