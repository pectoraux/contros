import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

// Knowledge alerts — surfacing stale/unreliable knowledge
export async function GET() {
  const alerts = await db.knowledgeAlert.findMany({
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
}
