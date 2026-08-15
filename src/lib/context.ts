import { getServerSession } from 'next-auth'
import { authOptions, isValidRole, type AllowedRole } from '@/lib/auth'

/**
 * Server-side request context — the single source of truth for the
 * authenticated identity in any API route.
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * Never trust organizationId / userId / role from the request body or query
 * string. Always resolve from the server-side session.
 */
export interface RequestContext {
  userId: string
  organizationId: string
  role: AllowedRole
  isDemo: boolean
  name: string | null
  email: string | null
}

/**
 * Require an authenticated session. Returns the server-derived context.
 * P0-8: Role is validated at runtime — unknown roles are normalized to 'estimator'.
 * Throws a 401-shaped error if unauthenticated.
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
  return {
    userId: u.id,
    organizationId: u.organizationId,
    role: isValidRole(u.role) ? u.role : 'estimator',
    isDemo: u.isDemo ?? false,
    name: u.name ?? null,
    email: u.email ?? null,
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
