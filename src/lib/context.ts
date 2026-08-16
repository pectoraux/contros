import { getServerSession } from 'next-auth'
import { authOptions, isValidRole, type AllowedRole } from '@/lib/auth'

/**
 * Server-side request context — the single source of truth for the
 * authenticated identity in any API route.
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * Never trust organizationId / userId / role from the request body or query
 * string. Always resolve from the server-side session.
 *
 * INVARIANT 5 (AI safety): The `actorType` field distinguishes human
 * requests from AI/tool requests. Mutations that commit commercial truth
 * (approving a WorkDefinitionVersion, recording a price observation,
 * finalizing a document, submitting a bid) require `actorType='human'`.
 * AI actors can READ everything and PROPOSE changes, but cannot COMMIT
 * them. This is enforced at the service layer, not just documented.
 */

export type ActorType = 'human' | 'ai'

export interface RequestContext {
  userId: string
  organizationId: string
  role: AllowedRole
  isDemo: boolean
  name: string | null
  email: string | null
  /**
   * Whether this request originates from a human user or an AI/tool actor.
   * Defaults to 'human' for normal NextAuth sessions.
   * AI-facing API routes (e.g. /api/ai-assistant) set this to 'ai' when
   * they invoke services on behalf of an AI actor.
   */
  actorType: ActorType
}

/**
 * Require an authenticated session. Returns the server-derived context.
 * Role is validated at runtime — invalid roles are rejected with 403 (fail closed).
 * Throws a 401-shaped error if unauthenticated, 403 if the role is invalid.
 */
export async function requireAuth(): Promise<RequestContext> {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    const err = new Error('Unauthorized') as Error & { status: number }
    err.status = 401
    throw err
  }
  const u = session.user as {
    id: string
    role: string
    organizationId: string
    isDemo: boolean
    name?: string | null
    email?: string | null
  }
  // Fix #3: Fail closed on invalid roles — reject the request entirely.
  // A corrupted or unexpected role must NOT silently become 'estimator'.
  if (!isValidRole(u.role)) {
    const err = new Error(
      `Forbidden: invalid role "${u.role}" — authentication rejected.`,
    ) as Error & { status: number }
    err.status = 403
    throw err
  }
  return {
    userId: u.id,
    organizationId: u.organizationId,
    role: u.role,
    isDemo: u.isDemo ?? false,
    name: u.name ?? null,
    email: u.email ?? null,
    actorType: 'human', // Normal NextAuth sessions are human-initiated
  }
}

/**
 * Require a specific role (or any of a set). Throws a 403-shaped error if the
 * caller's role is not permitted.
 */
export async function requireRole(
  ...allowed: RequestContext['role'][]
): Promise<RequestContext> {
  const ctx = await requireAuth()
  if (!allowed.includes(ctx.role)) {
    const err = new Error(
      `Forbidden: requires role ${allowed.join(' or ')}`,
    ) as Error & { status: number }
    err.status = 403
    throw err
  }
  return ctx
}

/**
 * Require that the request originates from a human actor (not AI).
 *
 * INVARIANT 5: AI cannot silently commit a price or approve commercial truth.
 * Use this guard in service methods that commit immutable commercial state:
 *   - approveVersion (WorkDefinitionVersion)
 *   - recordPriceObservation
 *   - finalizeVersion (Document)
 *   - submitBid
 *   - recordAdjudication
 *
 * AI actors can READ everything and PROPOSE changes (create drafts,
 * calibration proposals), but cannot COMMIT them.
 *
 * Throws a 403-shaped error if the actor is not human.
 */
export function requireHumanActor(ctx: RequestContext): void {
  if (ctx.actorType !== 'human') {
    const err = new Error(
      'Forbidden: this mutation requires a human actor. AI may propose but not commit commercial truth. (INVARIANT 5)',
    ) as Error & { status: number }
    err.status = 403
    throw err
  }
}

/**
 * Convert a thrown auth error into a NextResponse, or return null if it's not
 * an auth error (re-throw).
 */
export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof Error && 'status' in e) {
    const status = (e as Error & { status: number }).status
    if (status === 401) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (status === 403) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
  return null
}
