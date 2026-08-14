// Formatting helpers for the Contractor OS UI

export function formatGHS(n: number): string {
  return `GHS ${n.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatGHSCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `GHS ${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `GHS ${(n / 1_000).toFixed(1)}K`
  return `GHS ${n.toFixed(0)}`
}

export function formatPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const diff = new Date(iso).getTime() - Date.now()
  return Math.ceil(diff / 86400000)
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(iso)
}

// Status colors using Tailwind classes (no indigo/blue per design rules)
export const STATUS_STYLES: Record<string, string> = {
  // opportunity
  received: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  qualifying: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  'no-bid': 'bg-red-50 text-red-700 border-red-200',
  'scope-development': 'bg-amber-50 text-amber-700 border-amber-200',
  estimating: 'bg-amber-50 text-amber-700 border-amber-200',
  'internal-review': 'bg-orange-50 text-orange-700 border-orange-200',
  adjudication: 'bg-orange-50 text-orange-700 border-orange-200',
  submitted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  clarification: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  won: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  lost: 'bg-red-100 text-red-800 border-red-300',
  withdrawn: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  lapsed: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  // estimate
  draft: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  'internal-review': 'bg-orange-50 text-orange-700 border-orange-200',
  adjudicated: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  submitted: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  superseded: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  // approval
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'in-review': 'bg-amber-50 text-amber-700 border-amber-200',
  deprecated: 'bg-red-50 text-red-700 border-red-200',
}

export function statusStyle(status: string): string {
  return STATUS_STYLES[status] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
}

export function statusLabel(status: string): string {
  return status
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

export const SEVERITY_STYLES: Record<string, string> = {
  blocker: 'bg-red-100 text-red-800 border-red-300',
  warning: 'bg-amber-100 text-amber-800 border-amber-300',
  info: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  pass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
}

export function severityStyle(s: string): string {
  return SEVERITY_STYLES[s] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
}

export const EXECUTION_STRATEGY_LABELS: Record<string, string> = {
  'self-perform': 'Self-perform',
  subcontract: 'Subcontract',
  hybrid: 'Hybrid',
  undecided: 'Undecided',
}
