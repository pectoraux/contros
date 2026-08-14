import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { requireRole, authErrorResponse } from '@/lib/context'

// Admin-only: list all waitlist entries.
// INVARIANT 12: requires 'admin' role via the new context helper.
//
// NOTE: WaitlistEntry is intentionally a SYSTEM-WIDE table (no organizationId
// field) — anyone may request access via /api/auth/signup, and any admin may
// approve them. The User created on approval inherits the approving admin's
// organizationId (so the new user joins their tenant). The list itself is not
// tenant-scoped because waitlist entries predate tenant membership.
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    // We intentionally do NOT filter by ctx.organizationId here — waitlist
    // entries are global. (ctx.organizationId is used when a User is created
    // from an approved entry — see POST below.)
    void ctx

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
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}

// Admin-only: approve a waitlist entry → create a real User account.
// The new User inherits the approving admin's organizationId (tenant).
export async function POST(req: Request) {
  try {
    const ctx = await requireRole('admin')

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
          reviewedById: ctx.userId,
        },
      })
      return NextResponse.json({ ok: true, entry: updated })
    }

    // action === 'approve' → create the user account.
    const password = temporaryPassword?.trim() || 'Welcome123!'
    if (password.length < 8) {
      return NextResponse.json({ error: 'Temporary password must be at least 8 characters' }, { status: 400 })
    }

    const existing = await db.user.findUnique({ where: { email: entry.email } })
    if (existing) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    // The new User joins the approving admin's tenant (ctx.organizationId).
    const user = await db.user.create({
      data: {
        organizationId: ctx.organizationId,
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
        reviewedById: ctx.userId,
        createdUserId: user.id,
      },
    })

    // Audit the approval within the admin's tenant.
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        actorId: ctx.userId,
        action: 'admin.waitlist-approved',
        entityType: 'User',
        entityId: user.id,
        summary: `Approved waitlist entry for ${user.email} (role: ${user.role})`,
        afterJson: JSON.stringify({ email: user.email, role: user.role }),
      },
    })

    return NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      temporaryPassword: password,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
