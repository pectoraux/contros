import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// POST /api/work-definitions/[id]/versions
// Create a new draft version of a Work Definition.
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
    const result = await knowledgeService.createVersion({
      ctx,
      workDefinitionId: id,
      costRecipeJson: body.costRecipeJson,
      productivityRule: body.productivityRule,
      crewComposition: body.crewComposition,
      equipment: body.equipment,
      wastage: body.wastage,
      sequencing: body.sequencing,
      methodStatementFragment: body.methodStatementFragment,
      hazardsJson: body.hazardsJson,
      controlsJson: body.controlsJson,
      qualityChecklistJson: body.qualityChecklistJson,
      requiredPPE: body.requiredPPE,
      requiredPermits: body.requiredPermits,
      subcontractability: body.subcontractability,
      commonAssumptions: body.commonAssumptions,
      commonExclusions: body.commonExclusions,
      measurementRule: body.measurementRule,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ versionId: result.versionId, versionNo: result.versionNo }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
