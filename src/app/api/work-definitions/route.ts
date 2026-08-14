import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

// Work Library — list all work definitions with their current version
export async function GET() {
  const wds = await db.workDefinition.findMany({
    include: {
      versions: { orderBy: { version: 'desc' } },
    },
    orderBy: { code: 'asc' },
  })

  const result = wds.map((wd) => {
    const current = wd.versions[0]
    return {
      id: wd.id,
      code: wd.code,
      name: wd.name,
      industry: wd.industry,
      category: wd.category,
      unit: wd.unit,
      approvalState: wd.approvalState,
      currentVersionId: wd.currentVersionId,
      versionCount: wd.versions.length,
      currentVersion: current
        ? {
            id: current.id,
            version: current.version,
            approvalState: current.approvalState,
            productivityRule: current.productivityRule,
            wastage: current.wastage,
            subcontractability: current.subcontractability,
            crewComposition: current.crewComposition,
            equipment: current.equipment,
            methodStatementFragment: current.methodStatementFragment,
            hazardsJson: current.hazardsJson,
            controlsJson: current.controlsJson,
            qualityChecklistJson: current.qualityChecklistJson,
            requiredPPE: current.requiredPPE,
            requiredPermits: current.requiredPermits,
            commonAssumptions: current.commonAssumptions,
            commonExclusions: current.commonExclusions,
            costRecipeJson: current.costRecipeJson,
            measurementRule: current.measurementRule,
            sequencing: current.sequencing,
            approvedAt: current.approvedAt,
          }
        : null,
      versions: wd.versions.map((v) => ({
        id: v.id,
        version: v.version,
        approvalState: v.approvalState,
        approvedAt: v.approvedAt,
      })),
    }
  })

  return NextResponse.json({ workDefinitions: result })
}
