import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { documentService } from '@/application/document-service'

// GET /api/documents/[opportunityId]
// List all documents for an opportunity.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId } = await params

    const result = await documentService.listDocuments({ ctx, opportunityId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ documents: result.documents })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
