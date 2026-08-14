import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Sign-up does NOT create a User — it creates a WaitlistEntry.
// The admin reviews and creates the actual account later.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { name, email, company, role } = body as {
    name?: string
    email?: string
    company?: string
    role?: string
  }

  if (!name || !email) {
    return NextResponse.json({ error: 'Name and email are required' }, { status: 400 })
  }

  const cleanEmail = email.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
  }

  // Check if already on waitlist or already a user
  const existingWaitlist = await db.waitlistEntry.findUnique({ where: { email: cleanEmail } })
  if (existingWaitlist) {
    return NextResponse.json({
      ok: true,
      status: existingWaitlist.status,
      message:
        existingWaitlist.status === 'pending'
          ? 'You are already on the waitlist. An admin will review your request.'
          : `Your request was already ${existingWaitlist.status}.`,
    })
  }

  const existingUser = await db.user.findUnique({ where: { email: cleanEmail } })
  if (existingUser) {
    return NextResponse.json({ error: 'An account with this email already exists. Please log in.' }, { status: 409 })
  }

  const entry = await db.waitlistEntry.create({
    data: {
      name: name.trim(),
      email: cleanEmail,
      company: company?.trim() || null,
      role: role || 'estimator',
    },
  })

  return NextResponse.json({
    ok: true,
    id: entry.id,
    status: 'pending',
    message: 'You have been added to the waitlist. An admin will review your request and create your account.',
  })
}
