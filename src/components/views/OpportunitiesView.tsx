'use client'

import { useEffect, useState } from 'react'
import { apiGet, type OpportunityListItem } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useWorkspace } from '@/store/workspace'
import { formatGHS, formatDate, daysUntil, statusStyle, statusLabel } from '@/lib/format'
import { ChevronRight, MapPin, User, FileText, Ban, AlertTriangle } from 'lucide-react'

export function OpportunitiesView() {
  const [items, setItems] = useState<OpportunityListItem[]>([])
  const [loading, setLoading] = useState(true)
  const openOpportunity = useWorkspace((s) => s.openOpportunity)

  useEffect(() => {
    let mounted = true
    apiGet<{ opportunities: OpportunityListItem[] }>('/api/opportunities')
      .then((r) => mounted && setItems(r.opportunities))
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

  // Sort: blocked first, then by deadline urgency
  const sorted = [...items].sort((a, b) => {
    if (a.blockedLineCount > 0 && b.blockedLineCount === 0) return -1
    if (a.blockedLineCount === 0 && b.blockedLineCount > 0) return 1
    const da = a.submissionDeadline ? new Date(a.submissionDeadline).getTime() : Infinity
    const db = b.submissionDeadline ? new Date(b.submissionDeadline).getTime() : Infinity
    return da - db
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Opportunities</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} opportunities · click a row to open the full workspace
            {items.some(i => i.blockedLineCount > 0) && (
              <span className="text-red-600 font-medium ml-2">
                · {items.filter(i => i.blockedLineCount > 0).length} with blocked pricing
              </span>
            )}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">Title</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Estimate Value</TableHead>
                <TableHead>Pricing</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((o) => {
                const days = daysUntil(o.submissionDeadline)
                return (
                  <TableRow
                    key={o.id}
                    onClick={() => openOpportunity(o.id)}
                    className={`cursor-pointer hover:bg-muted/50 transition-colors ${o.blockedLineCount > 0 ? 'bg-red-50/20' : ''}`}
                  >
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-sm">{o.title}</span>
                        <span className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                          {o.reference && <span>{o.reference}</span>}
                          {o.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {o.location}
                            </span>
                          )}
                          {o.source && <span className="capitalize">· {o.source}</span>}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm">{o.client.name}</span>
                        {o.client.sector && (
                          <span className="text-[11px] text-muted-foreground capitalize">{o.client.sector}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[11px] ${statusStyle(o.status)}`}>
                        {statusLabel(o.status)}
                      </Badge>
                      {o.bidOutcome && (
                        <Badge
                          variant="outline"
                          className={`ml-1 text-[10px] ${o.bidOutcome === 'won' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-red-100 text-red-800 border-red-300'}`}
                        >
                          {o.bidOutcome.toUpperCase()}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {o.hasEstimate ? (
                        <span className="font-mono text-sm">{formatGHS(o.estimateValue)}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No estimate</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {o.blockedLineCount > 0 ? (
                        <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">
                          <Ban className="h-2.5 w-2.5 mr-0.5" />
                          {o.blockedLineCount} blocked
                        </Badge>
                      ) : o.hasEstimate ? (
                        <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                          Ready
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {o.submissionDeadline ? (
                        <div className="flex flex-col">
                          <span className="text-xs">{formatDate(o.submissionDeadline)}</span>
                          {days !== null && (
                            <span
                              className={`text-[11px] ${days < 0 ? 'text-red-600' : days <= 7 ? 'text-amber-600' : 'text-muted-foreground'}`}
                            >
                              {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {o.owner ? (
                        <span className="text-xs flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {o.owner.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
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

      {items.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">No opportunities yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click "New Opportunity" in the header to create one.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
