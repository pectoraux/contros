import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { boqProjectionService } from '@/application/boq-projection-service'

/**
 * GET /api/estimates/revisions/:revisionId/boq.xlsx
 *
 * Download an immutable EstimateRevision as an XLSX workbook.
 *
 * THIN ROUTE: this adapter does only transport concerns — authentication,
 * parsing the revisionId from the URL, and mapping the service result to an
 * HTTP response. It knows NOTHING about revisions, snapshots, replay, pricing,
 * workbook structure, or Excel. All of that lives in BoqProjectionService and
 * the pure office pipeline behind it.
 *
 * Response mapping:
 *   200 — XLSX bytes (Content-Type + Content-Disposition + optional warning header)
 *   404 — revision not found / wrong tenant
 *   422 — revision exists but is not finalized (not exportable)
 *   401/403 — auth errors (via authErrorResponse)
 *
 * auditWarning (if non-null) is returned as an X-GenOffice-Audit-Warning header.
 * It is informational only — a successful export remains HTTP 200 regardless.
 * The raw exception message never crosses the boundary (the service sanitizes it).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ revisionId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { revisionId } = await params

    const result = await boqProjectionService.exportXlsx({
      ctx,
      estimateRevisionId: revisionId,
    })

    if (!result.ok) {
      // Known service errors → controlled HTTP responses with safe messages.
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      )
    }

    // Success: return the XLSX bytes as a binary download.
    const headers: Record<string, string> = {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
    }

    // Optional: surface the audit warning as an informational header.
    // This does NOT change the HTTP status — the export succeeded.
    if (result.auditWarning) {
      headers['X-GenOffice-Audit-Warning'] = result.auditWarning
    }

    return new Response(result.bytes, { status: 200, headers })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    // Unexpected errors propagate to the framework's server-side error handler.
    // The route does NOT catch and sanitize them — the service already handles
    // known failures; unknown failures are framework-level.
    throw e
  }
}
