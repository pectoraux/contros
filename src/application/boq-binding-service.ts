/**
 * BoqBindingService — application service for binding BoqItems to EstimateLines.
 *
 * Owns: tenant validation, candidate generation (via the pure matcher),
 * explicit binding confirmation/rejection, audit logging.
 *
 * Does NOT own: reconciliation (BoqReconciliationService), pricing
 * (PricingEngine), or any mutation of EstimateLine. Binding establishes
 * IDENTITY ("which canonical line does this row refer to?"), not commercial
 * truth ("do the values match?").
 *
 * INVARIANT: AI may generate candidates but NEVER bind. All bindings are
 * human-confirmed (or a deterministic Tier 1-3 match a human confirms).
 * There is no auto-bind path.
 */

import type { RequestContext } from '@/lib/context'
import { auditLogRepository, boqBindingRepository, boqItemRepository, canonicalLineRepository } from '@/repositories'
import {
  generateCandidates,
  suggestBindingStatus,
  type BindingCandidate,
  type BoqItemForMatch,
  type MatchMethod,
} from '@/lib/boq'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SuggestBindingsInput {
  ctx: RequestContext
  importId: string
  // H1 hardening: canonical lines are loaded AUTHORITATIVELY by the service
  // (tenant + opportunity scoped), NOT supplied by the caller. A caller can no
  // longer inject arbitrary "canonical" projections into the matcher.
}

export interface SuggestBindingsResult {
  ok: true
  importId: string
  suggestions: Array<{
    boqItemId: string
    rawDescription: string
    suggestedStatus: 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED'
    suggestedMethod: MatchMethod | null
    candidates: BindingCandidate[]
  }>
}

export interface ConfirmBindingInput {
  ctx: RequestContext
  boqItemId: string
  estimateLineId: string
  matchMethod: MatchMethod
  candidateIds?: string[]
}

export interface RejectBindingInput {
  ctx: RequestContext
  boqItemId: string
  reason?: string
}

// ─── Service ────────────────────────────────────────────────────────────────

export const boqBindingService = {
  /**
   * Generate binding suggestions for every item in an import, against the
   * canonical EstimateLines for the import's opportunity. Does NOT persist
   * bindings — only suggests. The caller (UI/human) reviews and confirms.
   *
   * H1 hardening: the canonical lines are loaded AUTHORITATIVELY here (tenant +
   * opportunity scoped via canonicalLineRepository), not supplied by the caller.
   * A caller cannot inject arbitrary "canonical" projections into the matcher.
   */
  async suggestBindings(
    input: SuggestBindingsInput,
  ): Promise<SuggestBindingsResult> {
    const { ctx, importId } = input
    const [items, canonicalLines] = await Promise.all([
      boqItemRepository.listForImport(ctx.organizationId, importId),
      canonicalLineRepository.listForImportOpportunity(
        ctx.organizationId,
        importId,
      ),
    ])
    const suggestions = items.map((item) => {
      const forMatch: BoqItemForMatch = {
        boqItemId: item.id,
        normalizedDescription: item.normalizedDescription,
        normalizedCode: item.normalizedCode,
        normalizedUnit: item.normalizedUnit,
      }
      const candidates = generateCandidates(forMatch, canonicalLines)
      const { status, method } = suggestBindingStatus(candidates)
      return {
        boqItemId: item.id,
        rawDescription: item.rawDescription,
        suggestedStatus: status,
        suggestedMethod: method,
        candidates,
      }
    })
    return { ok: true, importId, suggestions }
  },

  /**
   * Confirm a binding — a human explicitly links a BoqItem to an EstimateLine.
   * Requires a human actor (INVARIANT 5 — AI cannot bind).
   *
   * The estimateLineId is verified tenant-scoped inside the repository.
   */
  async confirmBinding(input: ConfirmBindingInput) {
    const { ctx, boqItemId, estimateLineId, matchMethod, candidateIds } = input
    // Human-only mutation. AI may suggest but never bind.
    if (ctx.actorType !== 'human') {
      const err = new Error(
        'Forbidden: binding confirmation requires a human actor. AI may suggest but not bind. (INVARIANT 5)',
      ) as Error & { status: number }
      err.status = 403
      throw err
    }
    const binding = await boqBindingRepository.upsert(ctx.organizationId, {
      boqItemId,
      estimateLineId,
      status: 'MATCHED',
      matchMethod,
      candidateIdsJson: JSON.stringify(candidateIds ?? []),
      confirmedById: ctx.userId,
      confirmedAt: new Date(),
    })
    await auditLogRepository.create(ctx.organizationId, ctx.userId, {
      action: 'boq.binding.confirmed',
      entityType: 'BoqBinding',
      entityId: binding.id,
      summary: `BOQ item ${boqItemId} bound to estimate line ${estimateLineId} via ${matchMethod}`,
      afterJson: JSON.stringify({ boqItemId, estimateLineId, matchMethod }),
    })
    return { ok: true, binding }
  },

  /**
   * Reject a binding — a human explicitly declines to bind a BoqItem.
   * Records the rejection for audit (the row stays UNMATCHED/rejected).
   */
  async rejectBinding(input: RejectBindingInput) {
    const { ctx, boqItemId, reason } = input
    if (ctx.actorType !== 'human') {
      const err = new Error(
        'Forbidden: binding rejection requires a human actor. (INVARIANT 5)',
      ) as Error & { status: number }
      err.status = 403
      throw err
    }
    const binding = await boqBindingRepository.upsert(ctx.organizationId, {
      boqItemId,
      estimateLineId: null,
      status: 'REJECTED',
      matchMethod: null,
      candidateIdsJson: '[]',
      confirmedById: ctx.userId,
      confirmedAt: new Date(),
    })
    await auditLogRepository.create(ctx.organizationId, ctx.userId, {
      action: 'boq.binding.rejected',
      entityType: 'BoqBinding',
      entityId: binding.id,
      summary: `BOQ item ${boqItemId} rejected${reason ? `: ${reason}` : ''}`,
      afterJson: JSON.stringify({ boqItemId, reason: reason ?? null }),
    })
    return { ok: true, binding }
  },

  /** Get the binding for a BoqItem (tenant-scoped). */
  async getBindingForItem(ctx: RequestContext, boqItemId: string) {
    return boqBindingRepository.getForItem(ctx.organizationId, boqItemId)
  },

  /** List all bindings for an import (tenant-scoped). */
  async listBindingsForImport(ctx: RequestContext, importId: string) {
    return boqBindingRepository.listForImport(ctx.organizationId, importId)
  },
}
