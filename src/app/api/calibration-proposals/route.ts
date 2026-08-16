import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// GET /api/calibration-proposals
// List all calibration proposals for the organization.
export async function GET() {
  try {
    const ctx = await requireAuth()
    // This is a simple list — use the repository directly via the service
    // pattern (the service doesn't have a listProposals method, but we can
    // add one or use the repository). For consistency, let's not add a new
    // service method just for listing — the repository is tenant-scoped.
    const { calibrationProposalRepository } = await import('@/repositories')
    const proposals = await calibrationProposalRepository.listForOrganization(ctx.organizationId)
    return NextResponse.json({ proposals })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// POST /api/calibration-proposals
// Create a calibration proposal (AI can create, human must review).
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth()
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Request body required' }, { status: 400 })
    }
    const result = await knowledgeService.createCalibrationProposal({
      ctx,
      workDefinitionId: body.workDefinitionId,
      projectActualId: body.projectActualId,
      type: body.type,
      currentValue: body.currentValue,
      proposedValue: body.proposedValue,
      rationale: body.rationale,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ proposalId: result.proposalId }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
