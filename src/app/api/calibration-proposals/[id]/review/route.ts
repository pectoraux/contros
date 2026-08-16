import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/calibration-proposals/[id]/review
// Approve or reject a calibration proposal. Human-only (INVARIANT 5).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => null)
    if (!body || !body.decision) {
      return NextResponse.json({ error: 'Request body must include { decision: "approved" | "rejected" }' }, { status: 400 })
    }

    const result = await knowledgeService.reviewCalibrationProposal({
      ctx,
      proposalId: id,
      decision: body.decision,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ status: result.status })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
