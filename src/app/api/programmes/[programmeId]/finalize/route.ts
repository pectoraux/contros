import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { programmeService } from '@/application/programme-service'

/**
 * POST /api/programmes/:programmeId/finalize
 *
 * Finalize the current workspace into an immutable ProgrammeRevision.
 *
 * Flow:
 *   ProgrammeService.finalizeProgramme()
 *       ↓
 *   validate workspace snapshot
 *       ↓
 *   canonical snapshot (sorted by sequence, id)
 *       ↓
 *   content hash (SHA-256 of schedule content)
 *       ↓
 *   immutable ProgrammeRevision (created as 'finalized')
 *       ↓
 *   audit log entry
 *       ↓
 *   { revisionId, revisionNo, snapshotContentHash, scheduleEngineVersion }
 *
 * FINALIZATION IS IRREVERSIBLE:
 *   Once ProgrammeRevision #N exists, it cannot be edited, deleted, or
 *   overwritten. The workspace remains editable and becomes the basis for
 *   ProgrammeRevision #N+1.
 *
 * THIN ROUTE: requireAuth → programmeService.finalizeProgramme() → JSON.
 *
 * Response:
 *   200 → { ok: true, revisionId, revisionNo, snapshotContentHash, scheduleEngineVersion }
 *   404 → programme not found / wrong tenant
 *   422 → workspace has invalid schedule (cycles, invalid values)
 *   401/403 → auth errors
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ programmeId: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { programmeId } = await params

    const result = await programmeService.finalizeProgramme({ ctx, programmeId })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      )
    }

    return NextResponse.json(result)
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
