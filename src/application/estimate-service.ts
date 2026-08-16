/**
 * EstimateService — application service for estimate operations.
 *
 * Owns: tenant validation, ownership resolution, pricing-engine invocation,
 * persistence, commercial exception creation, audit logging, and transaction
 * boundaries.
 *
 * Does NOT own: pricing calculations (those stay in the pure pricing engine).
 *
 * API routes become thin adapters that call this service.
 */

import { db, dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  priceLine,
  computeConfidence,
  finalizeRevision as finalizeRevisionEngine,
  replayRevision,
  validateBidSubmission,
  type PricingInput,
  type ExecutionSegmentInput,
  type LineSnapshot,
  type PolicySnapshot,
} from '@/lib/engines'
import { round2 } from '@/lib/engines/money'
import {
  estimateRepository,
  estimateRevisionRepository,
  subcontractQuoteRepository,
  commercialExceptionRepository,
  auditLogRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecomputeLineInput {
  ctx: RequestContext
  estimateId: string
  estimateLineId: string
  overheadPct?: number
  profitPct?: number
  contingencyPct?: number
  executionStrategy?: 'self-perform' | 'subcontract' | 'hybrid' | 'undecided'
}

export interface RecomputeLineResult {
  ok: true
  line: {
    id: string
    unitRate: number
    sellPrice: number
    marginPct: number
    calculationStatus: string
    estimatedTotalCost: number
    expectedProfit: number
    expectedMarginPct: number
    blockingInputs: unknown[]
    confidence: number
    isUnsourced: boolean
    provenanceSummary: string | null
    breakdown: Record<string, unknown>
    provenance: unknown[]
    unsourcedResources: string[]
  }
}

export interface FinalizeRevisionInput {
  ctx: RequestContext
  estimateId: string
  revisionNo?: number
}

export interface FinalizeRevisionResult {
  ok: true
  revisionId: string
  revisionNo: number
  replay: {
    totalDirectCost: number
    totalSellPrice: number
    totalEstimatedTotalCost: number
    totalExpectedProfit: number
  }
}

// ─── EstimateService ────────────────────────────────────────────────────────

export const estimateService = {
  /**
   * Recompute an estimate line using the deterministic pricing engine.
   *
   * This is the ONLY way a price enters the canonical estimate (INVARIANT 5).
   * The service:
   *   1. Verifies estimate + line ownership (tenant-safe)
   *   2. Resolves the work definition, price observations, subcontract quote
   *   3. Builds the PricingInput
   *   4. Invokes the pure pricing engine
   *   5. Persists the result + creates CommercialException if incomplete
   *   6. Writes an audit log
   *   All within a single Prisma transaction.
   */
  async recomputeLine(input: RecomputeLineInput): Promise<RecomputeLineResult | { ok: false; error: string; status: number }> {
    const { ctx, estimateId, estimateLineId } = input

    // 1. Tenant-safe line lookup.
    const line = await estimateRepository.getLineForOrganization(
      ctx.organizationId,
      estimateId,
      estimateLineId,
    )
    if (!line) {
      return { ok: false, error: 'Line not found in this estimate', status: 404 }
    }

    const wdv = line.workDefinitionVersion

    // P0-3: WorkDefinition ownership is enforced at the repository level.
    // If the line references a cross-tenant WD, the repository returns null.
    // If workDefinitionId is set but WD is null → cross-tenant reference → reject.
    const wd = line.workDefinition
    if (line.workDefinitionId && !wd) {
      return { ok: false, error: 'Work Definition not available for this organization', status: 403 }
    }
    if (line.workDefinitionVersionId && !wdv) {
      return { ok: false, error: 'Work Definition Version not available for this organization', status: 403 }
    }

    // 2. Resolve the line-level subcontract quote (tenant-safe).
    const lineSubcontractQuote = await subcontractQuoteRepository.getSelectedQuoteForLine(
      ctx.organizationId,
      line.id,
    )
    const subcontractQuote = lineSubcontractQuote
      ? { totalAmount: lineSubcontractQuote.totalAmount, coveragePct: lineSubcontractQuote.coveragePct }
      : null

    // 3. Build execution segment inputs (tenant-safe quote resolution).
    const executionSegments: ExecutionSegmentInput[] = []
    for (const seg of line.executionSegments) {
      let segQuote: { totalAmount: number; coveragePct: number } | null | undefined = undefined
      if (seg.strategy === 'subcontract' && seg.subcontractQuoteId) {
        const sq = await subcontractQuoteRepository.getForOrganization(
          ctx.organizationId,
          seg.subcontractQuoteId,
        )
        segQuote = sq ? { totalAmount: sq.totalAmount, coveragePct: sq.coveragePct } : null
      }
      executionSegments.push({
        strategy: seg.strategy as 'self-perform' | 'subcontract',
        quantityPct: seg.quantityPct,
        subcontractQuote: segQuote,
        scopeDefinition: seg.scopeDefinition || undefined,
        quoteCoversSegmentScope: seg.quoteCoversSegmentScope || undefined,
        pricingBasis: (seg.pricingBasis as 'direct-segment-quote' | 'proportional-from-package') || undefined,
      })
    }

    // 4. Build pricing input.
    const pricingInput: PricingInput = {
      workDefinitionVersion: wdv
        ? {
            id: wdv.id,
            name: line.workDefinition?.name ?? '',
            version: wdv.version,
            unit: line.workDefinition?.unit ?? line.unit,
            wastage: wdv.wastage,
            productivityRule: wdv.productivityRule ?? undefined,
            costRecipeJson: wdv.costRecipeJson,
          }
        : null,
      quantity: line.quantity,
      executionStrategy: input.executionStrategy ?? line.executionStrategy,
      executionSegments: executionSegments.length > 0 ? executionSegments : undefined,
      overheadPct: input.overheadPct ?? line.estimate.overheadPct,
      profitPct: input.profitPct ?? line.estimate.profitPct,
      contingencyPct: input.contingencyPct ?? line.estimate.contingencyPct,
      subcontractQuote,
    }

    // 5. Invoke the pure pricing engine.
    const breakdown = priceLine(pricingInput)

    // 6. Compute confidence.
    const confidence = computeConfidence({
      observedAt: wdv?.priceObservations?.[0]?.observedAt ?? null,
      provenance: wdv?.priceObservations?.[0]?.provenance ?? null,
      workDefinitionApproval: wdv?.approvalState ?? null,
      scopeCompleteness: line.scopeItem ? 0.7 : 0.5,
      executionStrategy: pricingInput.executionStrategy,
      hasSubcontractQuote: !!subcontractQuote,
      productivityEvidence: wdv?.productivityRule ?? null,
      quantity: line.quantity,
      unit: line.unit,
    })

    // 7. Build provenance summary.
    const baseProvenance = breakdown.provenance.length
      ? breakdown.provenance
          .map((p) => `${p.resourceName}: ${p.provenance}${p.sourceReference ? ` #${p.sourceReference}` : ''} @ GHS ${p.price.toFixed(2)} (${new Date(p.observedAt).toLocaleDateString()})`)
          .join('; ')
      : 'No price observations — unsourced'
    const provenanceSummary = breakdown.uncoveredSubcontractExposure > 0
      ? `${baseProvenance}; UNCOVERED SUBCONTRACT EXPOSURE: GHS ${breakdown.uncoveredSubcontractExposure.toFixed(2)}`
      : baseProvenance

    // 8. Persist within a transaction (atomic: line update + exception + audit).
    //
    // P0 BOUNDARY: When calculationStatus === 'incomplete', the engine's result
    // is indicative/diagnostic ONLY. We must NOT persist authoritative
    // commercial fields (sellPrice, unitRate, profit, etc.) as canonical
    // estimate state. Downstream code (BidService, gate, BOQ projection)
    // reads these fields as commercial truth — an incomplete calculation
    // must not leave a stale or indicative price in the canonical row.
    //
    // Pattern:
    //   complete → persist all financial fields as authoritative
    //   incomplete → zero out authoritative fields, persist only diagnostic
    //                fields (calculationStatus, blockingInputs, isUnsourced,
    //                provenanceSummary, executionStrategy) + preview breakdown
    //                components (material/labour/plant/etc.) for the estimator
    //                to see what's missing.
    const isIncomplete = breakdown.calculationStatus === 'incomplete'

    const updated = await dbTx.$transaction(async (tx) => {
      const updatedLine = await tx.estimateLine.update({
        where: { id: line.id },
        data: {
          // Preview/diagnostic breakdown components — always persisted so the
          // estimator can see what the engine computed, even when incomplete.
          // These are NOT the authoritative commercial price.
          materialCost: round2(breakdown.material),
          labourCost: round2(breakdown.labour),
          plantCost: round2(breakdown.plant),
          subcontractCost: round2(breakdown.subcontract),
          feeCost: round2(breakdown.fee),
          // Authoritative commercial fields — ZEROED when incomplete.
          // An incomplete calculation must not leave a stale or indicative
          // price in the canonical row. Downstream consumers (BidService,
          // gate, BOQ) read these as commercial truth.
          directCost: isIncomplete ? 0 : round2(breakdown.directCost),
          projectCost: isIncomplete ? 0 : round2(breakdown.projectCost),
          riskCost: isIncomplete ? 0 : round2(breakdown.riskCost),
          overheadCost: isIncomplete ? 0 : round2(breakdown.overhead),
          profitCost: isIncomplete ? 0 : round2(breakdown.profit),
          estimatedTotalCost: isIncomplete ? 0 : round2(breakdown.estimatedTotalCost),
          expectedProfit: isIncomplete ? 0 : round2(breakdown.expectedProfit),
          expectedMarginPct: isIncomplete ? 0 : round2(breakdown.expectedMarginPct),
          sellPrice: isIncomplete ? 0 : round2(breakdown.sellPrice),
          unitRate: isIncomplete ? 0 : round2(breakdown.unitRate),
          marginPct: isIncomplete ? 0 : round2(breakdown.marginPct),
          // Diagnostic fields — always persisted
          calculationStatus: breakdown.calculationStatus,
          blockingInputsJson: JSON.stringify(breakdown.blockingInputs),
          confidence: round2(confidence.score),
          isUnsourced: breakdown.unsourced,
          provenanceSummary,
          executionStrategy: pricingInput.executionStrategy,
        },
      })

      // Create CommercialException if incomplete.
      if (isIncomplete) {
        const reason = breakdown.blockingInputs.length > 0
          ? breakdown.blockingInputs.map((b) => `${b.kind}: ${b.detail}`).join(' | ')
          : 'Calculation incomplete — unknown reason.'
        const existing = await tx.commercialException.findFirst({
          where: {
            estimateLineId: line.id,
            type: 'incomplete-calculation',
            organizationId: ctx.organizationId,
          },
        })
        if (!existing) {
          await tx.commercialException.create({
            data: {
              organizationId: ctx.organizationId,
              estimateLineId: line.id,
              entityType: 'estimate-line',
              entityId: line.id,
              type: 'incomplete-calculation',
              reason,
              // Exposure is 0 — the calculation did not produce an authoritative
              // price. The blocking inputs describe the risk, not a stale number.
              exposure: 0,
              approvalRequired: false,
            },
          })
        }
      }

      // Audit log.
      // When incomplete, the audit summary does NOT present the indicative
      // unitRate as a committed price — it explicitly says "BLOCKED".
      const summaryText = isIncomplete
        ? `Rate recomputed for "${line.description}": BLOCKED (${breakdown.blockingInputs.length} blocker(s))${breakdown.unsourced ? ' [UNSOURCED]' : ''}`
        : `Rate recomputed for "${line.description}": GHS ${round2(breakdown.unitRate).toFixed(2)}/${line.unit} [${breakdown.calculationStatus.toUpperCase()}]${breakdown.unsourced ? ' [UNSOURCED]' : ''}`

      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorId: ctx.userId,
          action: 'estimate.rate-recomputed',
          entityType: 'EstimateLine',
          entityId: line.id,
          summary: summaryText,
          afterJson: JSON.stringify({
            // When incomplete, unitRate/sellPrice are indicative only.
            unitRate: isIncomplete ? 0 : breakdown.unitRate,
            sellPrice: isIncomplete ? 0 : breakdown.sellPrice,
            unsourced: breakdown.unsourced,
            calculationStatus: breakdown.calculationStatus,
            blockingInputs: breakdown.blockingInputs,
            uncoveredSubcontractExposure: breakdown.uncoveredSubcontractExposure,
          }),
        },
      })

      return updatedLine
    })

    return {
      ok: true,
      line: {
        id: updated.id,
        unitRate: updated.unitRate,
        sellPrice: updated.sellPrice,
        marginPct: updated.marginPct,
        calculationStatus: updated.calculationStatus,
        estimatedTotalCost: updated.estimatedTotalCost,
        expectedProfit: updated.expectedProfit,
        expectedMarginPct: updated.expectedMarginPct,
        blockingInputs: breakdown.blockingInputs,
        confidence: updated.confidence,
        isUnsourced: updated.isUnsourced,
        provenanceSummary: updated.provenanceSummary,
        breakdown: {
          material: breakdown.material,
          labour: breakdown.labour,
          plant: breakdown.plant,
          subcontract: breakdown.subcontract,
          uncoveredSubcontractExposure: breakdown.uncoveredSubcontractExposure,
          directCost: breakdown.directCost,
          projectCost: breakdown.projectCost,
          riskCost: breakdown.riskCost,
          overhead: breakdown.overhead,
          profit: breakdown.profit,
          estimatedTotalCost: breakdown.estimatedTotalCost,
          expectedProfit: breakdown.expectedProfit,
          expectedMarginPct: breakdown.expectedMarginPct,
          sellPrice: breakdown.sellPrice,
          unitRate: breakdown.unitRate,
          marginPct: breakdown.marginPct,
          calculationStatus: breakdown.calculationStatus,
          blockingInputs: breakdown.blockingInputs,
        },
        provenance: breakdown.provenance,
        unsourcedResources: breakdown.unsourcedResources,
      },
    }
  },

  /**
   * Finalize an estimate revision — captures an immutable snapshot.
   *
   * P0-1: The entire operation is wrapped in a single Prisma transaction.
   * If replay fails or audit creation fails, the revision is rolled back.
   * A finalized revision and its audit log succeed or fail together.
   *
   * P0-2: Uses tenant-aware repositories — no raw Prisma calls.
   * P0-3: WorkDefinition/WDV/Resource ownership verified via repository scoping.
   */
  async finalizeRevision(input: FinalizeRevisionInput): Promise<FinalizeRevisionResult | { ok: false; error: string; status: number }> {
    const { ctx, estimateId } = input

    // 1. Tenant-safe estimate + lines lookup via repository.
    // P0-3: WD/WDV/priceObservations are org-scoped in the repository.
    const estimate = await estimateRepository.getRevisionContext(
      ctx.organizationId,
      estimateId,
    )
    if (!estimate) {
      return { ok: false, error: 'Estimate not found', status: 404 }
    }

    // 2. Validate no incomplete lines.
    const incompleteLines = estimate.lines.filter((l) => l.calculationStatus === 'incomplete')
    if (incompleteLines.length > 0) {
      return {
        ok: false,
        error: `Cannot finalize: ${incompleteLines.length} line(s) have incomplete calculations`,
        status: 400,
      }
    }

    // 3. Build line snapshots (tenant-safe quote resolution via repositories).
    const lineSnapshots: LineSnapshot[] = []
    for (const l of estimate.lines) {
      // P0-2: Use repository for package line lookup.
      let lineSubcontractQuote: { totalAmount: number; coveragePct: number } | null = null
      const pkgLine = await subcontractQuoteRepository.getPackageLineForOrganization(
        ctx.organizationId,
        l.id,
      )
      if (pkgLine) {
        const selectedQuoteId = pkgLine.subcontractPackage.selectedQuoteId
        if (selectedQuoteId) {
          const sq = pkgLine.subcontractPackage.quotes.find((q) => q.id === selectedQuoteId)
          if (sq) {
            lineSubcontractQuote = { totalAmount: sq.totalAmount, coveragePct: sq.coveragePct }
          }
        }
      }

      // Execution segment snapshots (tenant-safe quote resolution).
      const executionSegments: ExecutionSegmentInput[] = []
      for (const seg of l.executionSegments) {
        let segQuote: { totalAmount: number; coveragePct: number } | null | undefined = undefined
        if (seg.strategy === 'subcontract' && seg.subcontractQuoteId) {
          const sq = await subcontractQuoteRepository.getForOrganization(
            ctx.organizationId,
            seg.subcontractQuoteId,
          )
          segQuote = sq ? { totalAmount: sq.totalAmount, coveragePct: sq.coveragePct } : null
        }
        executionSegments.push({
          strategy: seg.strategy as 'self-perform' | 'subcontract',
          quantityPct: seg.quantityPct,
          subcontractQuote: segQuote,
          scopeDefinition: seg.scopeDefinition || undefined,
          quoteCoversSegmentScope: seg.quoteCoversSegmentScope || undefined,
          pricingBasis: (seg.pricingBasis as 'direct-segment-quote' | 'proportional-from-package') || undefined,
        })
      }

      // P0-3: WD/WDV are only present if they belong to the same org (repository filters).
      // If a line references a cross-tenant WD, the repository returns null for it.
      // We must reject finalization — cross-tenant pricing knowledge must not enter
      // the immutable snapshot.
      const wdv = l.workDefinitionVersion
      const wd = l.workDefinition
      if (l.workDefinitionId && !wd) {
        return {
          ok: false,
          error: `Line ${l.id} references a WorkDefinition that does not belong to this organization — cannot finalize.`,
          status: 403,
        }
      }
      if (l.workDefinitionVersionId && !wdv) {
        return {
          ok: false,
          error: `Line ${l.id} references a WorkDefinitionVersion that does not belong to this organization — cannot finalize.`,
          status: 403,
        }
      }
      lineSnapshots.push({
        lineId: l.id,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        executionStrategy: l.executionStrategy as LineSnapshot['executionStrategy'],
        workDefinitionVersion: wdv
          ? {
              id: wdv.id,
              name: wd?.name ?? '',
              version: wdv.version,
              unit: wd?.unit ?? l.unit,
              wastage: wdv.wastage,
              productivityRule: wdv.productivityRule ?? undefined,
              costRecipeJson: wdv.costRecipeJson,
            }
          : null,
        executionSegments,
        subcontractQuote: lineSubcontractQuote,
      })
    }

    // 4. Build the snapshot JSON.
    const policy: PolicySnapshot = {
      overheadPct: estimate.overheadPct,
      profitPct: estimate.profitPct,
      contingencyPct: estimate.contingencyPct,
    }
    const revisionNo = input.revisionNo ?? ((estimate.revisions[0]?.revisionNo ?? 0) + 1)
    const snapshotJson = finalizeRevisionEngine(estimateId, revisionNo, policy, lineSnapshots)

    // 5. Replay sanity check BEFORE the transaction — if replay fails, don't
    // even start the transaction.
    const replay = replayRevision(snapshotJson)
    if (!replay.ok) {
      return { ok: false, error: 'Replay failed before finalization — snapshot invalid', status: 500 }
    }

    // 6. P0-1: Atomic transaction — revision + audit succeed or fail together.
    const revision = await dbTx.$transaction(async (tx) => {
      // P0-2: Use repository for revision creation.
      const rev = await estimateRevisionRepository.createFinalized(tx, {
        estimateId,
        revisionNo,
        snapshotJson,
        finalizedById: ctx.userId,
      })

      // Audit log within the same transaction.
      await auditLogRepository.createInTransaction(
        tx,
        ctx.organizationId,
        ctx.userId,
        {
          action: 'estimate.revision-finalized',
          entityType: 'EstimateRevision',
          entityId: rev.id,
          summary: `Revision ${revisionNo} finalized for estimate ${estimateId} (${lineSnapshots.length} lines, sell=${replay.totalSellPrice})`,
        },
      )

      return rev
    })

    return {
      ok: true,
      revisionId: revision.id,
      revisionNo,
      replay: {
        totalDirectCost: replay.totalDirectCost,
        totalSellPrice: replay.totalSellPrice,
        totalEstimatedTotalCost: replay.totalEstimatedTotalCost,
        totalExpectedProfit: replay.totalExpectedProfit,
      },
    }
  },
}
