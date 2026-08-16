import { NextResponse } from 'next/server'
import { requireAuth, authErrorResponse } from '@/lib/context'
import { knowledgeService } from '@/application/knowledge-service'

// GET /api/knowledge-health?persist=true|false
// Run the deterministic knowledge-health analysis. If persist=true, creates
// KnowledgeAlert records for each finding.
export async function GET(req: Request) {
  try {
    const ctx = await requireAuth()
    const url = new URL(req.url)
    const persist = url.searchParams.get('persist') === 'true'

    const result = await knowledgeService.generateHealthAlerts({ ctx, persist })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      alerts: result.alerts,
      persisted: result.persisted,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
