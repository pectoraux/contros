import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { planService } from '@/application/plan-service'
import { planArtifactRepository } from '@/repositories'

/**
 * GET /api/plan/artifacts?opportunityId=...
 *
 * List PlanArtifacts for an opportunity (tenant-scoped).
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth()
    const { searchParams } = new URL(req.url)
    const opportunityId = searchParams.get('opportunityId')

    if (!opportunityId) {
      return NextResponse.json(
        { error: 'opportunityId query parameter is required' },
        { status: 422 },
      )
    }

    const artifacts = await planArtifactRepository.listForOpportunity(
      ctx.organizationId,
      opportunityId,
    )

    return NextResponse.json({ ok: true, artifacts })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

/**
 * POST /api/plan/artifacts
 *
 * Register an uploaded drawing file as a PlanArtifact.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth()
    const body = await req.json().catch(() => ({}))
    const { opportunityId, fileReference, fileName, fileHash, source, documentId } = body as {
      opportunityId?: string
      fileReference?: string
      fileName?: string
      fileHash?: string
      source?: string
      documentId?: string
    }

    if (!opportunityId || !fileReference || !fileName || !fileHash || !source) {
      return NextResponse.json(
        { error: 'opportunityId, fileReference, fileName, fileHash, and source are required' },
        { status: 422 },
      )
    }

    const result = await planService.createArtifact({
      ctx, opportunityId, fileReference, fileName, fileHash, source, documentId: documentId ?? null,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
