import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import {
  finalizeRevision,
  replayRevision,
  type LineSnapshot,
} from '@/lib/engines'
import { requireAuth, authErrorResponse } from '@/lib/context'

/**
 * Finalize an EstimateRevision — capture an immutable snapshot of EVERY pricing
 * input so the bid is reproducible from this revision (INVARIANT 8).
 *
 * The snapshot captures:
 *   - WorkDefinitionVersion (id, version, costRecipeJson, wastage, productivityRule)
 *   - ExecutionSegments (strategy, quantityPct, subcontract quote snapshot)
 *   - SubcontractQuote (line-level — totalAmount + coveragePct)
 *   - Estimate policy (overheadPct, profitPct, contingencyPct)
 *   - Line descriptions, quantities, units, execution strategy
 *
 * Only finalized revisions can be referenced by a Bid (validateBidSubmission()).
 *
 * INVARIANT 5: AI cannot silently commit a price — this endpoint is the only way
 *              to finalize a revision, and it requires an authenticated session.
 * INVARIANT 12: scoped by ctx.organizationId — verifies estimate ownership.
 * P0-6: finalized revisions are immutable; the snapshot is the source of truth
 *       for replay (not current mutable WorkDefinitions / prices / quotes).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAuth()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const { revisionNo: revisionNoRaw } = body as { revisionNo?: number }

    // P0-12: verify the estimate belongs to ctx.organizationId.
    const estimate = await db.estimate.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        lines: {
          include: {
            workDefinition: { select: { name: true, unit: true } },
            workDefinitionVersion: true,
            executionSegments: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    if (estimate.lines.length === 0) {
      return NextResponse.json(
        { error: 'Cannot finalize an estimate with no lines.' },
        { status: 400 },
      )
    }

    // P0-4: refuse to finalize if any line is incomplete — that would lock in
    // a provisional price as if it were final.
    const incompleteLines = estimate.lines.filter(
      (l) => l.calculationStatus === 'incomplete',
    )
    if (incompleteLines.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot finalize: one or more lines have incomplete calculations.',
          incompleteLineIds: incompleteLines.map((l) => l.id),
          incompleteLineCount: incompleteLines.length,
        },
        { status: 400 },
      )
    }

    // Compute the next revision number if not provided.
    const latestRevision = await db.estimateRevision.findFirst({
      where: { estimateId: id },
      orderBy: { revisionNo: 'desc' },
      select: { revisionNo: true },
    })
    const revisionNo =
      typeof revisionNoRaw === 'number' && revisionNoRaw > 0
        ? revisionNoRaw
        : (latestRevision?.revisionNo ?? 0) + 1

    // Build the line snapshots. For each line we capture the full pricing input
    // graph so replay is hermetic.
    const lineSnapshots: LineSnapshot[] = []

    for (const l of estimate.lines) {
      // Look up the line-level subcontract quote (if any) via the package link.
      let lineSubcontractQuote:
        | { totalAmount: number; coveragePct: number }
        | null = null
      const pkgLine = await db.subcontractPackageLine.findFirst({
        where: { estimateLineId: l.id },
        include: {
          subcontractPackage: {
            include: {
              quotes: { select: { id: true, totalAmount: true, coveragePct: true } },
            },
          },
        },
      })
      if (pkgLine) {
        const selectedQuoteId = pkgLine.subcontractPackage.selectedQuoteId
        if (selectedQuoteId) {
          const sq = pkgLine.subcontractPackage.quotes.find(
            (q) => q.id === selectedQuoteId,
          )
          if (sq) {
            lineSubcontractQuote = {
              totalAmount: sq.totalAmount,
              coveragePct: sq.coveragePct,
            }
          }
        }
      }

      // Build the execution segment snapshots — for subcontract segments,
      // capture the referenced quote.
      const executionSegments = []
      for (const seg of l.executionSegments) {
        let segQuote:
          | { totalAmount: number; coveragePct: number }
          | null
          | undefined = undefined
        if (seg.strategy === 'subcontract' && seg.subcontractQuoteId) {
          const sq = await db.subcontractQuote.findUnique({
            where: { id: seg.subcontractQuoteId },
            select: { totalAmount: true, coveragePct: true },
          })
          segQuote = sq
            ? { totalAmount: sq.totalAmount, coveragePct: sq.coveragePct }
            : null
        }
        executionSegments.push({
          strategy: seg.strategy as 'self-perform' | 'subcontract',
          quantityPct: seg.quantityPct,
          subcontractQuote: segQuote,
        })
      }

      lineSnapshots.push({
        lineId: l.id,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        executionStrategy: l.executionStrategy as
          | 'self-perform'
          | 'subcontract'
          | 'hybrid'
          | 'undecided',
        workDefinitionVersion: l.workDefinitionVersion
          ? {
              id: l.workDefinitionVersion.id,
              name: l.workDefinition?.name ?? '',
              version: l.workDefinitionVersion.version,
              unit: l.workDefinition?.unit ?? l.unit,
              wastage: l.workDefinitionVersion.wastage,
              productivityRule: l.workDefinitionVersion.productivityRule ?? undefined,
              costRecipeJson: l.workDefinitionVersion.costRecipeJson,
            }
          : null,
        executionSegments,
        subcontractQuote: lineSubcontractQuote,
      })
    }

    const snapshotJson = finalizeRevision(
      id,
      revisionNo,
      {
        overheadPct: estimate.overheadPct,
        profitPct: estimate.profitPct,
        contingencyPct: estimate.contingencyPct,
      },
      lineSnapshots,
    )

    // Persist the finalized revision.
    const revision = await db.estimateRevision.create({
      data: {
        estimateId: id,
        revisionNo,
        snapshotJson,
        // P0-6: finalized = immutable — only finalized revisions can back a Bid.
        status: 'finalized',
        finalizedById: ctx.userId,
      },
    })

    // Sanity check: replay the snapshot and confirm it parses + prices correctly.
    const replay = replayRevision(snapshotJson)
    const replaySummary = replay.ok
      ? {
          ok: true as const,
          lineCount: replay.lines.length,
          totalDirectCost: replay.totalDirectCost,
          totalSellPrice: replay.totalSellPrice,
          totalEstimatedTotalCost: replay.totalEstimatedTotalCost,
          totalExpectedProfit: replay.totalExpectedProfit,
        }
      : { ok: false as const, error: replay.error }

    // Audit log entry — append-only.
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        actorId: ctx.userId,
        action: 'estimate.revision-finalized',
        entityType: 'EstimateRevision',
        entityId: revision.id,
        summary: `Finalized revision ${revision.revisionNo} for estimate ${id} (${lineSnapshots.length} lines, totalSell=${replay.ok ? replay.totalSellPrice.toFixed(2) : 'unknown'}).`,
        afterJson: JSON.stringify({
          revisionId: revision.id,
          revisionNo: revision.revisionNo,
          status: revision.status,
          lineCount: lineSnapshots.length,
          replay: replaySummary,
        }),
      },
    })

    return NextResponse.json({
      revision: {
        id: revision.id,
        estimateId: id,
        revisionNo: revision.revisionNo,
        status: revision.status,
        finalizedAt: revision.finalizedAt,
        finalizedById: revision.finalizedById,
        lineCount: lineSnapshots.length,
      },
      replay: replaySummary,
    })
  } catch (e) {
    const authErr = authErrorResponse(e)
    if (authErr) return authErr
    throw e
  }
}
