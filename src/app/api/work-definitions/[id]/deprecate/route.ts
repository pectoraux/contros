import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/work-definitions/[id]/deprecate
// Deprecate a Work Definition (no longer current, but immutable for history).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params

    const result = await knowledgeService.deprecateWorkDefinition({
      ctx,
      workDefinitionId: id,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
