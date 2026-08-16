/**
 * Bid Readiness Service — application service for the bid readiness gate.
 *
 * Architecture:
 *   RequestContext → Service → Repository → Prisma
 *
 * INVARIANT 12: Every query is scoped by ctx.organizationId.
 *
 * CRITICAL: Pricing readiness uses calculationStatus === 'complete',
 * NOT sellPrice > 0. The frozen PricingEngine boundary guarantees
 * that incomplete calculations have zeroed authoritative fields.
 * The readiness service must never infer commercial truth.
 */

import type { RequestContext } from '@/lib/context'
import { bidReadinessRepository } from '@/repositories'

export interface ReadinessBlocker {
  category: 'SCOPE' | 'PRICING' | 'DOCUMENT' | 'KNOWLEDGE'
  code:
    | 'INCOMPLETE_SCOPE'
    | 'OPEN_SCOPE_QUESTION'
    | 'UNACKNOWLEDGED_ASSUMPTION'
    | 'BLOCKED_PRICE'
    | 'UNSOURCED_PRICE'
    | 'MISSING_DOCUMENT'
    | 'UNRESOLVED_ALERT'
  message: string
}

export interface ReadinessScore {
  scope: number
  pricing: number
  documents: number
  knowledge: number
}

export interface BidReadinessResult {
  ready: boolean
  score: ReadinessScore
  blockers: ReadinessBlocker[]
}

export const bidReadinessService = {
  /**
   * Evaluate bid readiness for an opportunity.
   *
   * Uses the frozen application services' authoritative state:
   * - Scope: scopePackage.completeness + open questions + assumptions
   * - Pricing: estimate lines' calculationStatus (NOT sellPrice)
   * - Documents: TenderDeliverable status (NOT file existence)
   * - Knowledge: unacknowledged alerts
   */
  async getReadiness(input: {
    ctx: RequestContext
    opportunityId: string
  }): Promise<BidReadinessResult> {
    const { ctx, opportunityId } = input

    const blockers: ReadinessBlocker[] = []

    // ── Scope readiness ──────────────────────────────────────────────────
    const scopeSummary = await bidReadinessRepository.getScopeSummary(
      ctx.organizationId, opportunityId,
    )

    let scopeScore = 0
    if (scopeSummary) {
      scopeScore = Math.round(scopeSummary.completeness * 100)

      if (scopeSummary.completeness < 1) {
        blockers.push({
          category: 'SCOPE',
          code: 'INCOMPLETE_SCOPE',
          message: `Scope completeness is ${scopeScore}% — target is 100%.`,
        })
      }

      if (scopeSummary._count.questions > 0) {
        blockers.push({
          category: 'SCOPE',
          code: 'OPEN_SCOPE_QUESTION',
          message: `${scopeSummary._count.questions} open scope question(s) must be resolved.`,
        })
      }

      if (scopeSummary._count.assumptions > 0) {
        blockers.push({
          category: 'SCOPE',
          code: 'UNACKNOWLEDGED_ASSUMPTION',
          message: `${scopeSummary._count.assumptions} unacknowledged high-risk assumption(s).`,
        })
      }
    } else {
      blockers.push({
        category: 'SCOPE',
        code: 'INCOMPLETE_SCOPE',
        message: 'No scope package exists for this opportunity.',
      })
    }

    // ── Pricing readiness ────────────────────────────────────────────────
    // CRITICAL: Use calculationStatus, NOT sellPrice > 0.
    // The frozen PricingEngine boundary guarantees that incomplete
    // calculations have zeroed authoritative fields.
    const estimate = await bidReadinessRepository.getEstimateLineStatuses(
      ctx.organizationId, opportunityId,
    )

    let pricingScore = 0
    if (estimate && estimate.lines.length > 0) {
      const totalLines = estimate.lines.length
      const completeLines = estimate.lines.filter(
        (l) => l.calculationStatus === 'complete',
      ).length
      pricingScore = Math.round((completeLines / totalLines) * 100)

      const blockedLines = estimate.lines.filter(
        (l) => l.calculationStatus !== 'complete',
      )
      for (const line of blockedLines) {
        blockers.push({
          category: 'PRICING',
          code: 'BLOCKED_PRICE',
          message: `Estimate line "${line.description}" is blocked (calculationStatus: ${line.calculationStatus}). No authoritative price.`,
        })
      }

      const unsourcedLines = estimate.lines.filter(
        (l) => l.isUnsourced && l.calculationStatus === 'complete',
      )
      for (const line of unsourcedLines) {
        blockers.push({
          category: 'PRICING',
          code: 'UNSOURCED_PRICE',
          message: `Estimate line "${line.description}" is priced but unsourced — provenance is incomplete.`,
        })
      }
    } else if (estimate) {
      blockers.push({
        category: 'PRICING',
        code: 'BLOCKED_PRICE',
        message: 'Estimate has no lines — nothing to price.',
      })
    } else {
      blockers.push({
        category: 'PRICING',
        code: 'BLOCKED_PRICE',
        message: 'No estimate exists for this opportunity.',
      })
    }

    // ── Document readiness ───────────────────────────────────────────────
    // Use TenderDeliverable status, NOT file existence.
    const deliverables = await bidReadinessRepository.getTenderDeliverables(
      ctx.organizationId, opportunityId,
    )

    let documentsScore = 0
    if (deliverables.length > 0) {
      const requiredDeliverables = deliverables.filter((d) => d.required)
      if (requiredDeliverables.length > 0) {
        const readyDocs = requiredDeliverables.filter(
          (d) => d.status === 'ready' || d.status === 'finalized',
        ).length
        documentsScore = Math.round((readyDocs / requiredDeliverables.length) * 100)

        const missingDocs = requiredDeliverables.filter(
          (d) => d.status !== 'ready' && d.status !== 'finalized',
        )
        for (const doc of missingDocs) {
          blockers.push({
            category: 'DOCUMENT',
            code: 'MISSING_DOCUMENT',
            message: `Required deliverable "${doc.kind}" is ${doc.status} — must be ready or finalized.`,
          })
        }
      } else {
        documentsScore = 100 // No required deliverables
      }
    } else {
      // No bid → no deliverables. If there's no bid yet, documents are 0%.
      documentsScore = 0
    }

    // ── Knowledge readiness ──────────────────────────────────────────────
    const alerts = await bidReadinessRepository.getUnacknowledgedAlerts(
      ctx.organizationId,
    )

    let knowledgeScore = 100
    if (alerts.length > 0) {
      const blockerAlerts = alerts.filter((a) => a.severity === 'blocker')
      if (blockerAlerts.length > 0) {
        knowledgeScore = 0
        for (const alert of blockerAlerts) {
          blockers.push({
            category: 'KNOWLEDGE',
            code: 'UNRESOLVED_ALERT',
            message: `Knowledge alert: ${alert.title}${alert.detail ? ` — ${alert.detail}` : ''}`,
          })
        }
      } else {
        // Warnings don't block but reduce the score
        knowledgeScore = Math.max(0, 100 - alerts.length * 20)
      }
    }

    return {
      ready: blockers.length === 0,
      score: {
        scope: scopeScore,
        pricing: pricingScore,
        documents: documentsScore,
        knowledge: knowledgeScore,
      },
      blockers,
    }
  },
}
