'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { OpportunityDetail } from '@/lib/api'
import { formatGHS } from '@/lib/format'
import { Sheet, Download, Info } from 'lucide-react'
import { toast } from 'sonner'

export function BoqTab({ opp }: { opp: OpportunityDetail }) {
  const estimate = opp.estimates[0]

  if (!estimate) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No estimate — the BOQ is a projection of the estimate.
        </CardContent>
      </Card>
    )
  }

  const total = estimate.lines.reduce((s, l) => s + l.sellPrice, 0)

  function exportBoq() {
    // Projection to a CSV-format BOQ — the Office file is a working copy, not canonical.
    const rows = [
      ['Item', 'Description', 'Unit', 'Quantity', 'Unit Rate (GHS)', 'Amount (GHS)'],
      ...estimate!.lines.map((l, i) => [
        `${i + 1}`,
        l.description,
        l.unit,
        l.quantity.toString(),
        l.unitRate.toFixed(2),
        l.sellPrice.toFixed(2),
      ]),
      ['', 'TOTAL', '', '', '', total.toFixed(2)],
    ]
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `BOQ-${opp.title.replace(/\s+/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('BOQ exported as CSV (working copy — canonical truth remains the Estimate)')
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardContent className="py-3 flex items-start gap-3">
          <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground">
            <strong className="text-foreground">INVARIANT:</strong> The BOQ is a projection of the Estimate — it is not the source of truth.
            Exported files are working copies. Financially meaningful edits must be reconciled back into the canonical domain model.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Sheet className="h-4 w-4" /> Bill of Quantities
              </CardTitle>
              <CardDescription>Projection from Estimate v{estimate.version}</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportBoq}>
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Rate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {estimate.lines.map((l, i) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs">{i + 1}</TableCell>
                  <TableCell className="text-sm">
                    {l.description}
                    {l.isUnsourced && (
                      <Badge variant="outline" className="ml-2 text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                        unsourced
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{l.unit}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{l.quantity.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{l.unitRate.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono text-sm font-medium">{l.sellPrice.toFixed(2)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 border-border">
                <TableCell colSpan={5} className="text-right font-semibold text-sm">
                  TOTAL
                </TableCell>
                <TableCell className="text-right font-mono font-bold text-base">{formatGHS(total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
