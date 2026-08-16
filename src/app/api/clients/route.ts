import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { opportunityService } from '@/application/opportunity-service'

// List all clients for the organization.
// INVARIANT 12: scoped by ctx.organizationId (enforced by the service).
export async function GET() {
  try {
    const ctx = await requireAuth()
    const result = await opportunityService.listClients({ ctx })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ clients: result.clients })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// Create a new client.
// The server resolves tenant context — the client never supplies organizationId.
export async function POST(req: Request) {
  try {
    const ctx = await requireAuth()
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Request body required' }, { status: 400 })
    }
    const result = await opportunityService.createClient({
      ctx,
      name: body.name,
      contactName: body.contactName,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      sector: body.sector,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ clientId: result.clientId }, { status: 201 })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
