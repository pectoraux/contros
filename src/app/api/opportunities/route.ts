import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

// List opportunities with client + latest estimate value
export async function GET() {
  const opportunities = await db.opportunity.findMany({
    include: {
      client: true,
      owner: true,
      estimates: {
        include: { lines: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
      bid: true,
    },
    orderBy: { updatedAt: 'desc' },
  })

  const result = opportunities.map((o) => {
    const latestEstimate = o.estimates[0]
    const estimateValue = latestEstimate
      ? latestEstimate.lines.reduce((s, l) => s + l.sellPrice, 0)
      : 0
    return {
      id: o.id,
      title: o.title,
      reference: o.reference,
      status: o.status,
      source: o.source,
      location: o.location,
      submissionDeadline: o.submissionDeadline,
      receivedAt: o.receivedAt,
      client: { id: o.client.id, name: o.client.name, sector: o.client.sector },
      owner: o.owner ? { id: o.owner.id, name: o.owner.name } : null,
      hasEstimate: !!latestEstimate,
      estimateId: latestEstimate?.id ?? null,
      estimateValue,
      estimateStatus: latestEstimate?.status ?? null,
      bidOutcome: o.bid?.outcome ?? null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }
  })

  return NextResponse.json({ opportunities: result })
}
