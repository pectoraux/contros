'use client'

import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { ShieldCheck, Users, CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react'
import { formatDate, statusStyle } from '@/lib/format'
import { toast } from 'sonner'

interface WaitlistEntry {
  id: string
  name: string
  email: string
  company: string | null
  role: string
  status: string
  notes: string | null
  createdAt: string
  reviewedAt: string | null
  createdUserId: string | null
}

export function AdminView() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [approveTarget, setApproveTarget] = useState<WaitlistEntry | null>(null)
  const [tempPassword, setTempPassword] = useState('Welcome123!')
  const [role, setRole] = useState('estimator')
  const [acting, setActing] = useState(false)

  function load() {
    setLoading(true)
    apiGet<{ entries: WaitlistEntry[] }>('/api/admin/waitlist')
      .then((r) => setEntries(r.entries))
      .catch(() => toast.error('Failed to load waitlist'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function approve(entry: WaitlistEntry) {
    setActing(true)
    try {
      const res = await apiPost<{ ok: boolean; user: { email: string }; temporaryPassword: string; error?: string }>(
        '/api/admin/waitlist',
        { entryId: entry.id, action: 'approve', temporaryPassword, role },
      )
      if (res.ok) {
        toast.success(`Account created for ${res.user.email}. Temporary password: ${res.temporaryPassword}`)
        setApproveTarget(null)
        load()
      } else {
        toast.error(res.error || 'Approval failed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Approval failed')
    } finally {
      setActing(false)
    }
  }

  async function reject(entry: WaitlistEntry) {
    setActing(true)
    try {
      const res = await apiPost<{ ok: boolean; error?: string }>('/api/admin/waitlist', {
        entryId: entry.id,
        action: 'reject',
      })
      if (res.ok) {
        toast.success(`Request from ${entry.email} rejected`)
        load()
      } else {
        toast.error(res.error || 'Rejection failed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rejection failed')
    } finally {
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const pending = entries.filter((e) => e.status === 'pending')
  const approved = entries.filter((e) => e.status === 'approved')
  const rejected = entries.filter((e) => e.status === 'rejected')

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Admin
        </h2>
        <p className="text-sm text-muted-foreground">
          Waitlist management · review access requests and create accounts
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-3 flex items-center gap-3">
            <Clock className="h-5 w-5 text-amber-600" />
            <div>
              <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Pending</div>
              <div className="text-lg font-mono font-semibold">{pending.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <div>
              <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Approved</div>
              <div className="text-lg font-mono font-semibold">{approved.length}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-500" />
            <div>
              <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Rejected</div>
              <div className="text-lg font-mono font-semibold">{rejected.length}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Pending Requests
          </CardTitle>
          <CardDescription>Review and approve to create user accounts</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No pending requests.</p>
          ) : (
            pending.map((entry) => (
              <div key={entry.id} className="p-3 rounded-md border border-border space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{entry.name}</span>
                      <Badge variant="outline" className="text-[10px] capitalize">{entry.role}</Badge>
                      {entry.company && (
                        <span className="text-[11px] text-muted-foreground">{entry.company}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{entry.email}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Requested {formatDate(entry.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 gap-1"
                      onClick={() => {
                        setApproveTarget(entry)
                        setRole(entry.role)
                        setTempPassword('Welcome123!')
                      }}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-red-600 hover:text-red-600"
                      onClick={() => reject(entry)}
                      disabled={acting}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* History */}
      {(approved.length > 0 || rejected.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {[...approved, ...rejected].map((entry) => (
              <div key={entry.id} className="flex items-center justify-between p-2 rounded hover:bg-muted/30 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{entry.name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{entry.email}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-muted-foreground">
                    {entry.reviewedAt ? formatDate(entry.reviewedAt) : ''}
                  </span>
                  <Badge variant="outline" className={`text-[10px] capitalize ${statusStyle(entry.status)}`}>
                    {entry.status}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Approve dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create account for {approveTarget?.name}</DialogTitle>
            <DialogDescription>
              This will create a real user account. The user can sign in with the temporary password and should change it later.
            </DialogDescription>
          </DialogHeader>
          {approveTarget && (
            <div className="space-y-3 py-2">
              <div className="text-sm">
                <span className="text-muted-foreground">Email: </span>
                <span className="font-mono">{approveTarget.email}</span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="approve-role">Role</Label>
                <select
                  id="approve-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="estimator">Estimator</option>
                  <option value="manager">Manager</option>
                  <option value="director">Director</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="approve-password">Temporary password</Label>
                <Input
                  id="approve-password"
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <p className="text-[11px] text-muted-foreground">
                  The user will be prompted to sign in with this password. Communicate it securely.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => approveTarget && approve(approveTarget)} disabled={acting || tempPassword.length < 8}>
              {acting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
