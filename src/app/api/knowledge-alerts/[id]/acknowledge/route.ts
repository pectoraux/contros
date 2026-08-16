import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/knowledge-alerts/[id]/acknowledge
// Acknowledge a knowledge alert.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const result = await knowledgeService.acknowledgeAlert({ ctx, alertId: id })
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
