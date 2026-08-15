import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { documentService } from '@/application/document-service'

// POST /api/documents/[documentId]/ready
// Mark a document as 'ready' (lighter than finalize — still editable).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { documentId } = await params

    const result = await documentService.markReady({ ctx, documentId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ deliverableUpdated: result.deliverableUpdated })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
