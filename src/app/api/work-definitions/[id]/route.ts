import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// GET /api/work-definitions/[id]
// Get a single Work Definition with all versions.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await knowledgeService.getWorkDefinition({ ctx, workDefinitionId: id })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ workDefinition: result.workDefinition })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
