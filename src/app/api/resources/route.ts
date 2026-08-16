import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// GET /api/resources
// List all resources for the organization.
export async function GET() {
  try {
    const ctx = await requireAuth()
    const result = await knowledgeService.listResources({ ctx })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ resources: result.resources })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// POST /api/resources
// Create a new resource.
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth()
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Request body required' }, { status: 400 })
    }
    const result = await knowledgeService.createResource({
      ctx,
      code: body.code,
      name: body.name,
      unit: body.unit,
      kind: body.kind,
      currency: body.currency,
      region: body.region,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ resourceId: result.resourceId }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
