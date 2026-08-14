'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Settings, Building2, Users, DollarSign, ShieldCheck, Database, Cpu } from 'lucide-react'

export function SettingsView() {
  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div>
        <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Settings className="h-5 w-5" /> Settings
        </h2>
        <p className="text-sm text-muted-foreground">Organization, cost policy & system configuration</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Organization
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">Adom Construction Ltd</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Industry pack</span>
            <Badge variant="outline" className="text-xs">construction-ghana</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Base currency</span>
            <span className="font-mono">GHS</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Default Cost Policy
          </CardTitle>
          <CardDescription>Applied to new estimates — overridable per estimate</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Overhead</span>
            <span className="font-mono">10%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Profit</span>
            <span className="font-mono">12%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Contingency (risk)</span>
            <span className="font-mono">5%</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Team
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Kwesi Mensah</div>
              <div className="text-xs text-muted-foreground">kwesi@adomconstruction.gh</div>
            </div>
            <Badge variant="outline" className="text-xs">director</Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Abena Owusu</div>
              <div className="text-xs text-muted-foreground">abena@adomconstruction.gh</div>
            </div>
            <Badge variant="outline" className="text-xs">estimator</Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Kofi Asante</div>
              <div className="text-xs text-muted-foreground">kofi@adomconstruction.gh</div>
            </div>
            <Badge variant="outline" className="text-xs">manager</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Architectural Invariants
          </CardTitle>
          <CardDescription>Non-negotiable rules preserved across all features</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {[
            'The domain model is the source of truth, not Office files',
            'Estimate is the canonical commercial object; BOQ is a projection',
            'Every important price has provenance',
            'Approved WorkDefinitions are versioned and immutable',
            'AI cannot silently commit a price',
            'Financial logic is deterministic and testable',
            'Subcontract scope must be reconciled against required scope',
            'Submitted bids are reproducible from immutable revisions',
            'Documents are projections / working copies, not canonical state',
            'Generic engines are industry-neutral',
          ].map((inv, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-primary font-mono text-[10px] mt-0.5">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-muted-foreground">{inv}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" /> Persistence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Canonical store</span>
            <span className="font-mono text-xs">Prisma + SQLite (working replica)</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Target production</span>
            <span className="font-mono text-xs">Neon PostgreSQL</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Audit</span>
            <span className="font-mono text-xs">Append-only</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4" /> AI Provider
          </CardTitle>
          <CardDescription>AI is an enhancement, not a hard dependency</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Provider</span>
            <span className="font-mono text-xs">z-ai-web-dev-sdk</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Capabilities</span>
            <span className="text-xs">read · extract · suggest · explain · flag · draft</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Cannot</span>
            <span className="text-xs text-amber-700">commit prices · bypass approvals · erase controls</span>
          </div>
          <div className="flex items-start gap-2 pt-2 border-t border-border mt-2">
            <span className="text-[11px] text-muted-foreground">
              The application continues to function without AI — deterministic estimating works regardless of provider availability.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
