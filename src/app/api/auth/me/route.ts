import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

// Returns the current authenticated user (or null) — used by the client to
// decide whether to show the login screen or the workspace.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ user: null })
  }
  return NextResponse.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: (session.user as { role: string }).role,
      organizationId: (session.user as { organizationId: string }).organizationId,
      isDemo: (session.user as { isDemo: boolean }).isDemo,
    },
  })
}
