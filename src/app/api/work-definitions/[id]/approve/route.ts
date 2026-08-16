import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/work-definitions/[id]/approve
// Approve the latest draft version (or a specific version if ?versionId= is provided).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const url = new URL(req.url)
    const versionId = url.searchParams.get('versionId') ?? undefined

    const result = await knowledgeService.approveVersion({
      ctx,
      workDefinitionId: id,
      versionId,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ versionId: result.versionId, versionNo: result.versionNo })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
