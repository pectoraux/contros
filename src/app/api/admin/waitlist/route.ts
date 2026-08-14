import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'

// Admin-only: list all waitlist entries
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user || (session.user as { role: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const entries = await db.waitlistEntry.findMany({
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      company: e.company,
      role: e.role,
      status: e.status,
      notes: e.notes,
      createdAt: e.createdAt,
      reviewedAt: e.reviewedAt,
      createdUserId: e.createdUserId,
    })),
  })
}

// Admin-only: approve a waitlist entry → create a real User account
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user || (session.user as { role: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const { entryId, action, temporaryPassword, role } = body as {
    entryId?: string
    action?: 'approve' | 'reject'
    temporaryPassword?: string
    role?: string
  }

  if (!entryId || !action) {
    return NextResponse.json({ error: 'entryId and action required' }, { status: 400 })
  }

  const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } })
  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }
  if (entry.status !== 'pending') {
    return NextResponse.json({ error: `Entry already ${entry.status}` }, { status: 400 })
  }

  if (action === 'reject') {
    const updated = await db.waitlistEntry.update({
      where: { id: entryId },
      data: {
        status: 'rejected',
        reviewedAt: new Date(),
        reviewedById: (session.user as { id: string }).id,
      },
    })
    return NextResponse.json({ ok: true, entry: updated })
  }

  // action === 'approve' → create the user account
  const password = temporaryPassword?.trim() || 'Welcome123!'
  if (password.length < 8) {
    return NextResponse.json({ error: 'Temporary password must be at least 8 characters' }, { status: 400 })
  }

  const existing = await db.user.findUnique({ where: { email: entry.email } })
  if (existing) {
    return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const user = await db.user.create({
    data: {
      organizationId: (session.user as { organizationId: string }).organizationId,
      name: entry.name,
      email: entry.email,
      role: role || entry.role,
      passwordHash,
      isDemo: false,
    },
  })

  await db.waitlistEntry.update({
    where: { id: entryId },
    data: {
      status: 'approved',
      reviewedAt: new Date(),
      reviewedById: (session.user as { id: string }).id,
      createdUserId: user.id,
    },
  })

  return NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    temporaryPassword: password,
  })
}
