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
import { boqBindingRepository, boqItemRepository } from '@/repositories'
import {
  reconcile,
  summarizeResults,
  type EstimateLineForReconcile,
  type ReconciliationResult,
} from '@/lib/boq'
import { db } from '@/lib/db'

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
   * Loads items + bindings (tenant-scoped), fetches the bound EstimateLines
   * (tenant-scoped, verified via the estimate→organization chain), and runs
   * the pure reconcile() function on each pair.
   *
   * The result is computed on demand — it is NOT persisted as authoritative
   * state. The caller may cache it, but the cache is disposable.
   */
  async reconcileImport(
    input: ReconcileImportInput,
  ): Promise<ReconcileImportResult> {
    const { ctx, importId } = input
    const items = await boqItemRepository.listForImport(
      ctx.organizationId,
      importId,
    )
    const bindings = await boqBindingRepository.listForImport(
      ctx.organizationId,
      importId,
    )

    // Index bindings by boqItemId for O(1) lookup.
    const bindingByItem = new Map(
      bindings.map((b) => [b.boqItemId, b] as const),
    )

    // Collect the EstimateLine IDs we need to load (MATCHED bindings only).
    const lineIds = bindings
      .filter((b) => b.status === 'MATCHED' && b.estimateLineId)
      .map((b) => b.estimateLineId!) as string[]

    // Load canonical lines tenant-scoped (estimate.organizationId verified).
    const lines = lineIds.length
      ? await db.estimateLine.findMany({
          where: {
            id: { in: lineIds },
            estimate: { organizationId: ctx.organizationId },
          },
          select: {
            id: true,
            quantity: true,
            unit: true,
            unitRate: true,
          },
        })
      : []
    const lineById = new Map(lines.map((l) => [l.id, l] as const))

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
            estimateLineId: line.id,
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
    let line: EstimateLineForReconcile | null = null
    if (binding?.status === 'MATCHED' && binding.estimateLineId) {
      const loaded = await db.estimateLine.findFirst({
        where: {
          id: binding.estimateLineId,
          estimate: { organizationId: ctx.organizationId },
        },
        select: { id: true, quantity: true, unit: true, unitRate: true },
      })
      if (loaded) {
        line = {
          estimateLineId: loaded.id,
          quantity: loaded.quantity,
          unit: loaded.unit,
          unitRate: loaded.unitRate,
        }
      }
    }
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
