import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { documentService } from '@/application/document-service'

// GET /api/documents/[documentId]/versions
// Get the version history for a document.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { documentId } = await params

    const result = await documentService.getVersionHistory({ ctx, documentId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ versions: result.versions })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
