'use client'

import { useEffect, useState } from 'react'
import { apiGet, type WorkDefinitionItem } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { statusStyle, statusLabel, formatPct } from '@/lib/format'
import { Library, ShieldCheck, AlertTriangle, HardHat, Wrench, FileText, ChevronRight } from 'lucide-react'

export function WorkLibraryView() {
  const [items, setItems] = useState<WorkDefinitionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<WorkDefinitionItem | null>(null)

  useEffect(() => {
    let mounted = true
    apiGet<{ workDefinitions: WorkDefinitionItem[] }>('/api/work-definitions')
      .then((r) => mounted && setItems(r.workDefinitions))
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const approvedCount = items.filter((i) => i.approvalState === 'approved').length

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Library className="h-5 w-5" /> Work Library
          </h2>
          <p className="text-sm text-muted-foreground">
            {items.length} work definitions · {approvedCount} approved · versioned institutional memory
          </p>
        </div>
      </div>

      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-foreground">INVARIANT:</strong> Approved WorkDefinitions are versioned and immutable.
            Changes create a new version. A single approved Work Definition drives BOQ, cost build-up, productivity, method
            statement, hazards, controls, and QA — never duplicated copies.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Productivity</TableHead>
                <TableHead>Subcontractable</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((wd) => {
                const cv = wd.currentVersion
                return (
                  <TableRow key={wd.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelected(wd)}>
                    <TableCell className="font-mono text-xs">{wd.code}</TableCell>
                    <TableCell className="text-sm font-medium">{wd.name}</TableCell>
                    <TableCell className="text-xs capitalize">{wd.category ?? '—'}</TableCell>
                    <TableCell className="text-xs">{wd.unit}</TableCell>
                    <TableCell className="text-right text-xs font-mono">
                      {cv?.productivityRule ? `${cv.productivityRule}/${wd.unit}/crew-day` : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {cv?.subcontractability ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${statusStyle(wd.approvalState)}`}>
                        {statusLabel(wd.approvalState)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs font-mono">{wd.versionCount}</TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono text-sm text-muted-foreground">{selected.code}</span>
                  {selected.name}
                </DialogTitle>
                <DialogDescription>
                  {selected.category} · unit {selected.unit} ·{' '}
                  <Badge variant="outline" className={`text-[10px] ${statusStyle(selected.approvalState)}`}>
                    {statusLabel(selected.approvalState)}
                  </Badge>
                </DialogDescription>
              </DialogHeader>

              {selected.currentVersion && (
                <div className="space-y-4">
                  {/* Cost recipe */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                      <Wrench className="h-4 w-4" /> Cost Recipe (deterministic)
                    </h4>
                    <div className="space-y-1">
                      {(() => {
                        try {
                          const recipe = JSON.parse(selected.currentVersion.costRecipeJson || '[]') as Array<{
                            resourceKind: string
                            resourceName: string
                            resourceCode: string
                            unit: string
                            quantityPerUnit: number
                          }>
                          return recipe.length ? (
                            recipe.map((r, i) => (
                              <div key={i} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/30">
                                <span>
                                  <Badge variant="outline" className="text-[9px] mr-2 capitalize">{r.resourceKind}</Badge>
                                  {r.resourceName}
                                </span>
                                <span className="font-mono">{r.quantityPerUnit} {r.unit}/unit</span>
                              </div>
                            ))
                          ) : (
                            <p className="text-xs text-muted-foreground">No recipe defined.</p>
                          )
                        } catch {
                          return <p className="text-xs text-red-600">Invalid recipe JSON</p>
                        }
                      })()}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Wastage: {formatPct(selected.currentVersion.wastage)} · Productivity: {selected.currentVersion.productivityRule ?? 'n/a'}/crew-day
                    </p>
                  </div>

                  {/* Method fragment */}
                  {selected.currentVersion.methodStatementFragment && (
                    <div>
                      <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
                        <FileText className="h-4 w-4" /> Method Statement Fragment
                      </h4>
                      <p className="text-xs leading-relaxed p-2 rounded bg-muted/30">
                        {selected.currentVersion.methodStatementFragment}
                      </p>
                    </div>
                  )}

                  {/* Hazards & controls */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600" /> Hazards
                      </h4>
                      <ul className="text-xs space-y-0.5">
                        {(JSON.parse(selected.currentVersion.hazardsJson || '[]') as string[]).map((h, i) => (
                          <li key={i} className="text-amber-700">· {h}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-emerald-600" /> Controls
                      </h4>
                      <ul className="text-xs space-y-0.5">
                        {(JSON.parse(selected.currentVersion.controlsJson || '[]') as string[]).map((c, i) => (
                          <li key={i} className="text-emerald-700">· {c}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* PPE & permits */}
                  <div className="grid grid-cols-2 gap-3">
                    {selected.currentVersion.requiredPPE && (
                      <div>
                        <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
                          <HardHat className="h-4 w-4" /> PPE
                        </h4>
                        <p className="text-xs">{selected.currentVersion.requiredPPE}</p>
                      </div>
                    )}
                    {selected.currentVersion.requiredPermits && (
                      <div>
                        <h4 className="text-sm font-semibold mb-1">Permits</h4>
                        <p className="text-xs">{selected.currentVersion.requiredPermits}</p>
                      </div>
                    )}
                  </div>

                  {/* Assumptions & exclusions */}
                  {(selected.currentVersion.commonAssumptions || selected.currentVersion.commonExclusions) && (
                    <div className="grid grid-cols-2 gap-3">
                      {selected.currentVersion.commonAssumptions && (
                        <div>
                          <h4 className="text-sm font-semibold mb-1">Common Assumptions</h4>
                          <p className="text-xs text-muted-foreground">{selected.currentVersion.commonAssumptions}</p>
                        </div>
                      )}
                      {selected.currentVersion.commonExclusions && (
                        <div>
                          <h4 className="text-sm font-semibold mb-1">Common Exclusions</h4>
                          <p className="text-xs text-muted-foreground">{selected.currentVersion.commonExclusions}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Versions */}
                  <div>
                    <h4 className="text-sm font-semibold mb-1">Version History ({selected.versions.length})</h4>
                    <div className="space-y-1">
                      {selected.versions.map((v) => (
                        <div key={v.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/30">
                          <span>Version {v.version}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[9px] ${statusStyle(v.approvalState)}`}>
                              {v.approvalState}
                            </Badge>
                            {v.approvedAt && (
                              <span className="text-muted-foreground">{new Date(v.approvedAt).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
