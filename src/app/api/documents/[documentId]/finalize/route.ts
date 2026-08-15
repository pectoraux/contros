import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { documentService } from '@/application/document-service'

// POST /api/documents/[documentId]/finalize
// Finalize the latest draft version (or a specific version if ?versionId= is provided).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { documentId } = await params
    const url = new URL(req.url)
    const versionId = url.searchParams.get('versionId') ?? undefined

    const result = await documentService.finalizeVersion({ ctx, documentId, versionId })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      documentId: result.documentId,
      versionId: result.versionId,
      revisionNo: result.revisionNo,
      deliverableUpdated: result.deliverableUpdated,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
