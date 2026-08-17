/**
 * BoqReconciliationService — application service for reconciling bound
 * BoqItems against their canonical EstimateLines.
 *
 * Owns: tenant-scoped loading of BoqItems + their bindings + the bound
 * EstimateLines, and invoking the pure reconcile() function.
 *
 * Does NOT own: the comparison algorithm (pure, in src/lib/boq/reconcile.ts),
 * any mutation of EstimateLine, or persistent storage of the reconciliation
 * result as authoritative state.
 *
 * DESIGN RULE (Section 3): reconciliation is a deterministic RESULT, not
 * stored truth. This service computes it on demand. A cache MAY be added
 * later for performance, but it must be disposable and recomputable. The
 * canonical commercial state stays in EstimateLine, computed by the
 * PricingEngine — BOQ never mutates it.
 *
 * INVARIANT 5 (asymmetric rates): RATE_DIVERGENT is a comparison, never a
 * price replacement. There is no "sync imported rate" operation here.
 */

import type { RequestContext } from '@/lib/context'
import { boqBindingRepository, boqItemRepository, canonicalLineRepository } from '@/repositories'
import {
  reconcile,
  summarizeResults,
  type EstimateLineForReconcile,
  type ReconciliationResult,
} from '@/lib/boq'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconcileImportInput {
  ctx: RequestContext
  importId: string
}

export interface ReconcileImportResult {
  ok: true
  importId: string
  results: ReconciliationResult[]
  summary: ReturnType<typeof summarizeResults>
}

// ─── Service ────────────────────────────────────────────────────────────────

export const boqReconciliationService = {
  /**
   * Reconcile every item in an import against its bound EstimateLine.
   *
   * H5 hardening: canonical lines are loaded via canonicalLineRepository
   * (tenant + import-opportunity scoped), NOT via direct db.estimateLine calls.
   * The application service no longer touches Prisma directly — it goes through
   * the repository boundary, consistent with the rest of the architecture.
   *
   * The result is computed on demand — it is NOT persisted as authoritative
   * state. The caller may cache it, but the cache is disposable.
   */
  async reconcileImport(
    input: ReconcileImportInput,
  ): Promise<ReconcileImportResult> {
    const { ctx, importId } = input
    const [items, bindings, canonicalLines] = await Promise.all([
      boqItemRepository.listForImport(ctx.organizationId, importId),
      boqBindingRepository.listForImport(ctx.organizationId, importId),
      canonicalLineRepository.listForImportOpportunity(
        ctx.organizationId,
        importId,
      ),
    ])

    // Index bindings + canonical lines by ID for O(1) lookup.
    const bindingByItem = new Map(
      bindings.map((b) => [b.boqItemId, b] as const),
    )
    const lineById = new Map(
      canonicalLines.map((l) => [l.estimateLineId, l] as const),
    )

    // Build the reconcile inputs and compute results (pure).
    const results: ReconciliationResult[] = items.map((item) => {
      const binding = bindingByItem.get(item.id)
      const bindingStatus = (binding?.status ?? 'UNMATCHED') as
        | 'MATCHED'
        | 'AMBIGUOUS'
        | 'UNMATCHED'
        | 'REJECTED'
      const line = binding?.estimateLineId
        ? lineById.get(binding.estimateLineId)
        : undefined
      const lineForReconcile: EstimateLineForReconcile | null = line
        ? {
            estimateLineId: line.estimateLineId,
            quantity: line.quantity,
            unit: line.unit,
            unitRate: line.unitRate,
          }
        : null
      return reconcile({
        item: {
          boqItemId: item.id,
          normalizedQuantity: item.normalizedQuantity,
          normalizedUnit: item.normalizedUnit,
          normalizedRate: item.normalizedRate,
        },
        line: lineForReconcile,
        bindingStatus,
      })
    })

    return {
      ok: true,
      importId,
      results,
      summary: summarizeResults(results),
    }
  },

  /** Reconcile a single BoqItem against its binding (tenant-scoped). */
  async reconcileItem(
    ctx: RequestContext,
    boqItemId: string,
  ): Promise<ReconciliationResult> {
    const item = await boqItemRepository.getForOrganization(
      ctx.organizationId,
      boqItemId,
    )
    if (!item) {
      const err = new Error('BoqItem not found') as Error & { status: number }
      err.status = 404
      throw err
    }
    const binding = item.binding
    const bindingStatus = (binding?.status ?? 'UNMATCHED') as
      | 'MATCHED'
      | 'AMBIGUOUS'
      | 'UNMATCHED'
      | 'REJECTED'
    // H5: load the canonical line via the repository (opportunity-scoped),
    // not via direct db.estimateLine calls.
    const loaded = await canonicalLineRepository.getForBoqItem(
      ctx.organizationId,
      boqItemId,
    )
    const line: EstimateLineForReconcile | null = loaded
      ? {
          estimateLineId: loaded.estimateLineId,
          quantity: loaded.quantity,
          unit: loaded.unit,
          unitRate: loaded.unitRate,
        }
      : null
    return reconcile({
      item: {
        boqItemId: item.id,
        normalizedQuantity: item.normalizedQuantity,
        normalizedUnit: item.normalizedUnit,
        normalizedRate: item.normalizedRate,
      },
      line,
      bindingStatus,
    })
  },
}
