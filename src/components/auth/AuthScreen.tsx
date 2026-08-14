'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { HardHat, Loader2, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { toast } from 'sonner'

const DEMO_ACCOUNTS = [
  { label: 'Director', email: 'kwesi@adomconstruction.gh', name: 'Kwesi Mensah' },
  { label: 'Estimator', email: 'abena@adomconstruction.gh', name: 'Abena Owusu' },
  { label: 'Manager', email: 'kofi@adomconstruction.gh', name: 'Kofi Asante' },
]
const DEMO_PASSWORD = 'demo1234'

export function AuthScreen() {
  const [loading, setLoading] = useState(false)
  const [waitlistSubmitted, setWaitlistSubmitted] = useState(false)

  async function handleLogin(email: string, password: string) {
    setLoading(true)
    const res = await signIn('credentials', { email, password, redirect: false })
    setLoading(false)
    if (res?.error) {
      toast.error('Invalid email or password')
    } else if (res?.ok) {
      toast.success('Signed in')
      window.location.reload()
    }
  }

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const name = String(formData.get('name') || '')
    const email = String(formData.get('email') || '')
    const company = String(formData.get('company') || '')
    const role = String(formData.get('role') || 'estimator')
    setLoading(true)
    try {
      const res = await apiPost<{ ok: boolean; message?: string; error?: string }>('/api/auth/signup', {
        name,
        email,
        company,
        role,
      })
      if (res.ok) {
        setWaitlistSubmitted(true)
        toast.success('Added to waitlist')
      } else {
        toast.error(res.error || 'Sign-up failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-up failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted/30">
      <header className="border-b border-border bg-background/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <HardHat className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Contractor OS</div>
              <div className="text-[11px] text-muted-foreground">Estimating & Operating Memory</div>
            </div>
          </div>
          <Badge variant="outline" className="text-[11px]">
            Construction Industry Pack · Ghana
          </Badge>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to Contractor OS</h1>
            <p className="text-sm text-muted-foreground mt-1">
              The estimating and operating memory of a contractor.
            </p>
          </div>

          <Tabs defaultValue="login">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Sign In</TabsTrigger>
              <TabsTrigger value="signup">Request Access</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Sign in</CardTitle>
                  <CardDescription>Use your account credentials</CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      const fd = new FormData(e.currentTarget)
                      handleLogin(String(fd.get('email') || ''), String(fd.get('password') || ''))
                    }}
                    className="space-y-3"
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email</Label>
                      <Input id="email" name="email" type="email" required autoComplete="email" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="password">Password</Label>
                      <Input id="password" name="password" type="password" required autoComplete="current-password" />
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">
                    Demo quick-login
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {DEMO_ACCOUNTS.map((acc) => (
                    <button
                      key={acc.email}
                      onClick={() => handleLogin(acc.email, DEMO_PASSWORD)}
                      disabled={loading}
                      className="flex flex-col items-center gap-1 p-3 rounded-md border border-border bg-background hover:bg-muted/50 transition-colors text-center"
                    >
                      <span className="text-xs font-medium">{acc.label}</span>
                      <span className="text-[10px] text-muted-foreground">{acc.name.split(' ')[0]}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2 text-center">
                  Demo password: <code className="font-mono bg-muted px-1 py-0.5 rounded">{DEMO_PASSWORD}</code>
                </p>
              </div>
            </TabsContent>

            <TabsContent value="signup">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Request Access</CardTitle>
                  <CardDescription>
                    Sign-up puts you on a waitlist. An admin will create your account.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {waitlistSubmitted ? (
                    <div className="flex flex-col items-center text-center py-4 space-y-2">
                      <CheckCircle2 className="h-10 w-10 text-emerald-600" />
                      <p className="text-sm font-medium">You are on the waitlist</p>
                      <p className="text-xs text-muted-foreground max-w-xs">
                        An administrator will review your request and create your account. You will be contacted at the email you provided.
                      </p>
                    </div>
                  ) : (
                    <form onSubmit={handleSignup} className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="su-name">Full name</Label>
                        <Input id="su-name" name="name" required />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="su-email">Email</Label>
                        <Input id="su-email" name="email" type="email" required />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="su-company">Company (optional)</Label>
                        <Input id="su-company" name="company" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="su-role">Requested role</Label>
                        <select
                          id="su-role"
                          name="role"
                          defaultValue="estimator"
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="estimator">Estimator</option>
                          <option value="manager">Manager</option>
                          <option value="director">Director</option>
                        </select>
                      </div>
                      <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Join waitlist'}
                      </Button>
                      <div className="flex items-start gap-2 p-2 rounded bg-amber-50 border border-amber-200">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                        <p className="text-[11px] text-amber-800">
                          Accounts are not created automatically. An admin reviews each request before access is granted.
                        </p>
                      </div>
                    </form>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <footer className="border-t border-border bg-background py-3 text-center">
        <p className="text-[11px] text-muted-foreground">
          Domain model is canonical · Estimate ≠ BOQ · AI advisory only
        </p>
      </footer>
    </div>
  )
}
