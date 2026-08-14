import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'

// Knowledge alerts — surfacing stale/unreliable knowledge.
// INVARIANT 12: scoped by ctx.organizationId.
export async function GET() {
  try {
    const ctx = await requireAuth()
    const alerts = await db.knowledgeAlert.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    })
    return NextResponse.json({
      alerts: alerts.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        entityType: a.entityType,
        entityId: a.entityId,
        acknowledged: a.acknowledged,
        createdAt: a.createdAt,
      })),
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
