'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { OpportunityDetail } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { History } from 'lucide-react'

const ACTION_LABELS: Record<string, string> = {
  'estimate.created': 'Estimate created',
  'estimate.rate-recomputed': 'Rate recomputed',
  'estimate.line-flagged': 'Line flagged',
  'rate.changed': 'Rate changed',
  'assumption.added': 'Assumption added',
  'assumption.resolved': 'Assumption resolved',
  'subcontract.quote-received': 'Quote received',
  'subcontract.quote-selected': 'Quote selected',
  'bid.submitted': 'Bid submitted',
  'bid.approved': 'Bid approved',
  'document.generated': 'Document generated',
  'ai.assistant-queried': 'AI assistant queried',
}

export function ActivityTab({ opp }: { opp: OpportunityDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" /> Activity History
        </CardTitle>
        <CardDescription>Append-only audit trail — every commercially significant action</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[600px] overflow-y-auto">
        {opp.auditLogs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No activity recorded.</p>
        ) : (
          <div className="relative pl-4">
            <div className="absolute left-0 top-2 bottom-2 w-px bg-border" />
            {opp.auditLogs.map((log) => (
              <div key={log.id} className="relative pb-4">
                <div className="absolute -left-[13px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary border-2 border-background" />
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">
                        {ACTION_LABELS[log.action] ?? log.action}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">{log.actor}</span>
                    </div>
                    <p className="text-sm mt-1 leading-snug">{log.summary}</p>
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {relativeTime(log.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
