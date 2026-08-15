import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { estimateService } from '@/application/estimate-service'

// Recompute an estimate line deterministically using the pricing engine.
// This route is now a thin adapter — all business logic lives in
// estimateService.recomputeLine(), which owns tenant validation, pricing,
// persistence, exceptions, and audit (within a single transaction).
//
// INVARIANT 5: AI cannot silently commit a price.
// INVARIANT 12: tenant-scoped via ctx.organizationId.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const { estimateLineId, overheadPct, profitPct, contingencyPct, executionStrategy } = body as {
      estimateLineId?: string
      overheadPct?: number
      profitPct?: number
      contingencyPct?: number
      executionStrategy?: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided'
    }

    if (!estimateLineId) {
      return NextResponse.json({ error: 'estimateLineId required' }, { status: 400 })
    }

    const result = await estimateService.recomputeLine({
      ctx,
      estimateId: id,
      estimateLineId,
      overheadPct,
      profitPct,
      contingencyPct,
      executionStrategy,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ line: result.line })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
