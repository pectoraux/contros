import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'

/** P0-8: Allowed roles — validated at runtime, not just TypeScript-cast. */
export const ALLOWED_ROLES = ['estimator', 'manager', 'director', 'admin'] as const
export type AllowedRole = (typeof ALLOWED_ROLES)[number]

export function isValidRole(role: string): role is AllowedRole {
  return (ALLOWED_ROLES as readonly string[]).includes(role)
}

/**
 * P0-8: Resolve the NextAuth secret.
 *
 * In production, NEXTAUTH_SECRET is MANDATORY — no fallback.
 * In development, a dev fallback is permitted for convenience.
 */
function resolveAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (secret && secret.length >= 16) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: NEXTAUTH_SECRET is not set or too short (< 16 chars) in production. ' +
        'Set a strong random secret (>= 32 chars) via the Vercel env dashboard.',
    )
  }
  // Development only — explicit fallback.
  console.warn(
    'WARNING: NEXTAUTH_SECRET not set — using dev fallback. DO NOT use in production.',
  )
  return 'dev-secret-change-me-min-16-chars'
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = await db.user.findUnique({
          where: { email: credentials.email.toLowerCase().trim() },
        })
        if (!user || !user.passwordHash) return null

        const valid = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!valid) return null

        // P0-8: Validate role at runtime — reject unknown roles.
        const role = isValidRole(user.role) ? user.role : 'estimator'

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
          organizationId: user.organizationId,
          isDemo: user.isDemo,
        }
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: '/' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as { role: string; organizationId: string; isDemo: boolean }
        token.id = user.id
        // P0-8: Validate role before putting it in the token.
        token.role = isValidRole(u.role) ? u.role : 'estimator'
        token.organizationId = u.organizationId
        token.isDemo = u.isDemo
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        const role = token.role as string
        ;(session.user as { id?: string }).id = token.id as string
        ;(session.user as { role?: string }).role = isValidRole(role) ? role : 'estimator'
        ;(session.user as { organizationId?: string }).organizationId = token.organizationId as string
        ;(session.user as { isDemo?: boolean }).isDemo = token.isDemo as boolean
      }
      return session
    },
  },
  secret: resolveAuthSecret(),
}
