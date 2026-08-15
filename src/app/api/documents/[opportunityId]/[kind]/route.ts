import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { documentService } from '@/application/document-service'

// GET /api/documents/[opportunityId]/[kind]
// Get a document for an opportunity + kind. Returns { document: null } if none exists.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string; kind: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId, kind } = await params
    const result = await documentService.getDocument({ ctx, opportunityId, kind })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ document: result.document })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// PUT /api/documents/[opportunityId]/[kind]
// Save a draft version of the document. Creates the document if it doesn't exist.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ opportunityId: string; kind: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { opportunityId, kind } = await params
    const body = await req.json().catch(() => null)
    if (!body || typeof body.content !== 'string') {
      return NextResponse.json({ error: 'Request body must include { content: string }' }, { status: 400 })
    }
    const result = await documentService.saveDraft({
      ctx, opportunityId, kind,
      content: body.content,
      sourceProvenance: body.sourceProvenance,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      documentId: result.documentId,
      versionId: result.versionId,
      revisionNo: result.revisionNo,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
