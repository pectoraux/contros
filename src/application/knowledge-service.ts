/**
 * KnowledgeService — application service for the Work Library.
 *
 * Manages the institutional memory of the contractor organization:
 *   WorkDefinitions, WorkDefinitionVersions, Resources, Price Observations,
 *   and KnowledgeAlerts.
 *
 * Architecture:
 *   RequestContext → Service → Repository → Engine → Transaction → Audit
 *
 * Key invariants:
 * - INVARIANT 4: Approved WorkDefinitions are versioned and immutable.
 *   Once a WorkDefinitionVersion is approved (approvalState='approved'),
 *   it CANNOT be modified. New changes require a new version.
 * - INVARIANT 3: Every important price has provenance.
 *   ResourcePriceObservations are append-only with a provenance field
 *   (supplier-quote | invoice | market-survey | manual | historical-bid |
 *   subcontract-quote).
 * - INVARIANT 5: AI cannot silently commit a price. AI suggestions come
 *   through a separate path; only a human can approve a version or record
 *   a price observation.
 * - All mutations are transactional (dbTx.$transaction) with audit log entries.
 * - No raw Prisma in the service — all access through tenant-scoped repositories.
 *
 * Lifecycle:
 *   draft → in-review → approved → deprecated
 *
 * The critical architecture is:
 *   WorkDefinition
 *         ↓
 *   approved version
 *         ↓
 *   cost recipe
 *   productivity
 *   method
 *   hazards
 *   controls
 *   QA
 *   subcontract treatment
 *
 * A WorkDefinition can have multiple versions. Only one version is
 * "current" (pointed to by WorkDefinition.currentVersionId). The current
 * version is updated when a new version is approved.
 */

import { dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  workDefinitionRepository,
  workDefinitionVersionRepository,
  resourceRepository,
  resourcePriceObservationRepository,
  knowledgeAlertRepository,
  auditLogRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface ListWorkDefinitionsInput { ctx: RequestContext }
export interface GetWorkDefinitionInput { ctx: RequestContext; workDefinitionId: string }

export interface CreateWorkDefinitionInput {
  ctx: RequestContext
  code: string
  name: string
  category?: string | null
  unit: string
  industry?: string
}

export interface CreateVersionInput {
  ctx: RequestContext
  workDefinitionId: string
  costRecipeJson: string
  productivityRule?: number | null
  crewComposition?: string | null
  equipment?: string | null
  wastage?: number
  sequencing?: string | null
  methodStatementFragment?: string | null
  hazardsJson?: string
  controlsJson?: string
  qualityChecklistJson?: string
  requiredPPE?: string | null
  requiredPermits?: string | null
  subcontractability?: string
  commonAssumptions?: string | null
  commonExclusions?: string | null
  measurementRule?: string | null
}

export interface ApproveVersionInput {
  ctx: RequestContext
  workDefinitionId: string
  /** The version ID to approve. If omitted, approves the latest draft. */
  versionId?: string
}

export interface DeprecateWorkDefinitionInput {
  ctx: RequestContext
  workDefinitionId: string
}

export interface TransitionApprovalStateInput {
  ctx: RequestContext
  workDefinitionId: string
  newApprovalState: string // draft | in-review | approved | deprecated
}

export interface ListResourcesInput { ctx: RequestContext }

export interface CreateResourceInput {
  ctx: RequestContext
  code: string
  name: string
  unit: string
  kind: string // labour | material | plant | subcontract | fee
  currency?: string
  region?: string | null
}

export interface RecordPriceObservationInput {
  ctx: RequestContext
  resourceId: string
  workDefinitionVersionId?: string | null
  price: number
  currency?: string
  provenance: string
  sourceReference?: string | null
}

export interface ListPriceObservationsInput {
  ctx: RequestContext
  resourceId: string
}

export interface ListKnowledgeAlertsInput { ctx: RequestContext }

export interface AcknowledgeAlertInput {
  ctx: RequestContext
  alertId: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_WD_APPROVAL_STATES = ['draft', 'in-review', 'approved', 'deprecated']
const VALID_WDV_APPROVAL_STATES = ['draft', 'approved']
const VALID_RESOURCE_KINDS = ['labour', 'material', 'plant', 'subcontract', 'fee']
const VALID_PROVENANCE_TYPES = [
  'supplier-quote', 'invoice', 'market-survey', 'manual',
  'historical-bid', 'subcontract-quote',
]
const VALID_ALERT_TYPES = [
  'stale-price', 'productivity-variance', 'unapproved-rate',
  'scope-gap', 'subcontract-exclusion',
]
const VALID_ALERT_SEVERITIES = ['info', 'warning', 'blocker']

// ─── KnowledgeService ───────────────────────────────────────────────────────

export const knowledgeService = {
  // ─── Work Definitions ───────────────────────────────────────────────────

  /**
   * List all WorkDefinitions for the organization, with versions ordered
   * by version DESC (latest first). Returns the serialized shape the
   * frontend expects (WorkDefinitionItem[]).
   */
  async listWorkDefinitions(input: ListWorkDefinitionsInput): Promise<{ ok: true; workDefinitions: unknown[] } | Err> {
    const { ctx } = input
    const wds = await workDefinitionRepository.listForOrganization(ctx.organizationId)

    const workDefinitions = wds.map((wd) => {
      const current = wd.versions[0] // latest version (versions ordered desc)
      return {
        id: wd.id,
        code: wd.code,
        name: wd.name,
        industry: wd.industry,
        category: wd.category,
        unit: wd.unit,
        approvalState: wd.approvalState,
        currentVersionId: wd.currentVersionId,
        versionCount: wd.versions.length,
        currentVersion: current
          ? {
              id: current.id,
              version: current.version,
              costRecipeJson: current.costRecipeJson,
              productivityRule: current.productivityRule,
              crewComposition: current.crewComposition,
              equipment: current.equipment,
              wastage: current.wastage,
              sequencing: current.sequencing,
              methodStatementFragment: current.methodStatementFragment,
              hazardsJson: current.hazardsJson,
              controlsJson: current.controlsJson,
              qualityChecklistJson: current.qualityChecklistJson,
              requiredPPE: current.requiredPPE,
              requiredPermits: current.requiredPermits,
              subcontractability: current.subcontractability,
              commonAssumptions: current.commonAssumptions,
              commonExclusions: current.commonExclusions,
              measurementRule: current.measurementRule,
              approvalState: current.approvalState,
              approvedAt: current.approvedAt,
            }
          : null,
        versions: wd.versions.map((v) => ({
          id: v.id,
          version: v.version,
          approvalState: v.approvalState,
          approvedAt: v.approvedAt,
        })),
      }
    })

    return { ok: true, workDefinitions }
  },

  /**
   * Get a single WorkDefinition by ID, with all versions.
   * Tenant-scoped.
   */
  async getWorkDefinition(input: GetWorkDefinitionInput): Promise<{ ok: true; workDefinition: unknown } | Err> {
    const { ctx, workDefinitionId } = input
    const wd = await workDefinitionRepository.getForOrganization(ctx.organizationId, workDefinitionId)
    if (!wd) {
      return { ok: false, error: 'Work Definition not found', status: 404 }
    }
    return { ok: true, workDefinition: wd }
  },

  /**
   * Create a new WorkDefinition (starts in 'draft' state).
   * Transactional with audit.
   */
  async createWorkDefinition(input: CreateWorkDefinitionInput): Promise<{ ok: true; workDefinitionId: string } | Err> {
    const { ctx, code, name, category, unit, industry } = input

    if (!code || !code.trim()) {
      return { ok: false, error: 'Work Definition code is required', status: 400 }
    }
    if (!name || !name.trim()) {
      return { ok: false, error: 'Work Definition name is required', status: 400 }
    }
    if (!unit || !unit.trim()) {
      return { ok: false, error: 'Work Definition unit is required', status: 400 }
    }

    const wd = await dbTx.$transaction(async (tx) => {
      const created = await workDefinitionRepository.createInTransaction(tx, ctx.organizationId, {
        code: code.trim(),
        name: name.trim(),
        category: category ?? null,
        unit: unit.trim(),
        industry: industry ?? 'construction',
      })

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'work-definition.created',
        entityType: 'WorkDefinition',
        entityId: created.id,
        summary: `Work Definition "${created.name}" (${created.code}) created`,
        afterJson: JSON.stringify({ code: created.code, name: created.name, unit: created.unit }),
      })

      return created
    })

    return { ok: true, workDefinitionId: wd.id }
  },

  /**
   * Create a new draft version of a WorkDefinition.
   * The version number is auto-incremented (monotonic per WorkDefinition).
   * Transactional with audit.
   */
  async createVersion(input: CreateVersionInput): Promise<{ ok: true; versionId: string; versionNo: number } | Err> {
    const { ctx, workDefinitionId, ...versionData } = input

    if (!versionData.costRecipeJson || !versionData.costRecipeJson.trim()) {
      return { ok: false, error: 'costRecipeJson is required', status: 400 }
    }

    // Verify the WorkDefinition belongs to this org
    const wd = await workDefinitionRepository.getForOrganization(ctx.organizationId, workDefinitionId)
    if (!wd) {
      return { ok: false, error: 'Work Definition not found', status: 404 }
    }

    const result = await dbTx.$transaction(async (tx) => {
      const latestVersionNo = await workDefinitionRepository.getLatestVersionNumberInTransaction(
        tx, ctx.organizationId, workDefinitionId,
      )
      const versionNo = latestVersionNo + 1

      const version = await workDefinitionVersionRepository.createDraftInTransaction(
        tx, ctx.organizationId, workDefinitionId,
        { version: versionNo, ...versionData },
      )
      if (!version) {
        throw new Error('VERSION_CREATE_FAILED')
      }

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'work-definition.version-created',
        entityType: 'WorkDefinitionVersion',
        entityId: version.id,
        summary: `Version ${versionNo} created for WD "${wd.name}" (${wd.code})`,
        afterJson: JSON.stringify({
          workDefinitionId, versionNo,
          hasProductivityRule: !!versionData.productivityRule,
          hasMethodStatement: !!versionData.methodStatementFragment,
        }),
      })

      return { versionId: version.id, versionNo }
    }).catch((e) => {
      if (e instanceof Error && e.message === 'VERSION_CREATE_FAILED') {
        return { ok: false as const, error: 'Failed to create version — WorkDefinition not found in this organization', status: 404 }
      }
      throw e
    })

    if ('ok' in result && result.ok === false) {
      return result
    }

    return { ok: true, ...(result as { versionId: string; versionNo: number }) }
  },

  /**
   * Approve a draft version — freeze it as immutable.
   *
   * INVARIANT 4: Once approved, the version CANNOT be modified.
   * Sets:
   *   - WorkDefinitionVersion.approvalState = 'approved'
   *   - WorkDefinitionVersion.approvedAt, approvedById
   *   - WorkDefinition.approvalState = 'approved'
   *   - WorkDefinition.currentVersionId = versionId
   *
   * Idempotent: if already approved, returns success without duplicate audit.
   * Transactional with audit.
   */
  async approveVersion(input: ApproveVersionInput): Promise<{ ok: true; versionId: string; versionNo: number } | Err> {
    const { ctx, workDefinitionId, versionId } = input

    try {
      const result = await dbTx.$transaction(async (tx) => {
        // Load the WorkDefinition (tenant-scoped)
        const wd = await workDefinitionRepository.getForOrganization(
          ctx.organizationId, workDefinitionId,
        )
        if (!wd) {
          throw new Error('WD_NOT_FOUND')
        }

        // Determine which version to approve
        let targetVersionId: string

        if (versionId) {
          const version = wd.versions.find((v) => v.id === versionId)
          if (!version) {
            throw new Error('VERSION_NOT_FOUND')
          }
          targetVersionId = version.id
        } else {
          // Find the latest draft
          const latestDraft = wd.versions.find((v) => v.approvalState === 'draft')
          if (!latestDraft) {
            throw new Error('NO_DRAFT_TO_APPROVE')
          }
          targetVersionId = latestDraft.id
        }

        // Approve the version (idempotent — returns null if already approved)
        const approved = await workDefinitionVersionRepository.approveInTransaction(
          tx, ctx.organizationId, workDefinitionId, targetVersionId, ctx.userId,
        )

        if (!approved) {
          // Already approved — idempotent success
          const version = wd.versions.find((v) => v.id === targetVersionId)
          return {
            versionId: targetVersionId,
            versionNo: version?.version ?? 0,
          }
        }

        // Update WorkDefinition: approvalState + currentVersionId
        await workDefinitionRepository.updateInTransaction(tx, ctx.organizationId, workDefinitionId, {
          approvalState: 'approved',
          currentVersionId: targetVersionId,
        })

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'work-definition.version-approved',
          entityType: 'WorkDefinitionVersion',
          entityId: targetVersionId,
          summary: `Version ${approved.version} approved for WD "${wd.name}" (${wd.code})`,
          afterJson: JSON.stringify({
            workDefinitionId,
            versionNo: approved.version,
            versionId: targetVersionId,
          }),
        })

        return {
          versionId: targetVersionId,
          versionNo: approved.version,
        }
      })

      return { ok: true, ...result }
    } catch (e) {
      if (e instanceof Error) {
        if (e.message === 'WD_NOT_FOUND') {
          return { ok: false, error: 'Work Definition not found', status: 404 }
        }
        if (e.message === 'VERSION_NOT_FOUND') {
          return { ok: false, error: 'Version not found for this Work Definition', status: 404 }
        }
        if (e.message === 'NO_DRAFT_TO_APPROVE') {
          return { ok: false, error: 'No draft version to approve — create a version first', status: 400 }
        }
      }
      throw e
    }
  },

  /**
   * Deprecate a WorkDefinition — marks it as no longer current.
   * The WorkDefinition and its approved versions remain immutable (for
   * historical reference), but it can no longer be selected for new estimates.
   * Transactional with audit.
   */
  async deprecateWorkDefinition(input: DeprecateWorkDefinitionInput): Promise<{ ok: true } | Err> {
    const { ctx, workDefinitionId } = input

    try {
      await dbTx.$transaction(async (tx) => {
        const wd = await workDefinitionRepository.getForOrganization(
          ctx.organizationId, workDefinitionId,
        )
        if (!wd) {
          throw new Error('WD_NOT_FOUND')
        }

        const oldState = wd.approvalState
        await workDefinitionRepository.updateInTransaction(tx, ctx.organizationId, workDefinitionId, {
          approvalState: 'deprecated',
        })

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'work-definition.deprecated',
          entityType: 'WorkDefinition',
          entityId: workDefinitionId,
          summary: `Work Definition "${wd.name}" (${wd.code}) deprecated (was ${oldState})`,
          afterJson: JSON.stringify({ from: oldState, to: 'deprecated' }),
        })
      })

      return { ok: true }
    } catch (e) {
      if (e instanceof Error && e.message === 'WD_NOT_FOUND') {
        return { ok: false, error: 'Work Definition not found', status: 404 }
      }
      throw e
    }
  },

  // ─── Resources ──────────────────────────────────────────────────────────

  /**
   * List all Resources for the organization.
   */
  async listResources(input: ListResourcesInput): Promise<{ ok: true; resources: unknown[] } | Err> {
    const { ctx } = input
    const resources = await resourceRepository.listForOrganization(ctx.organizationId)
    return { ok: true, resources }
  },

  /**
   * Create a Resource. Transactional with audit.
   */
  async createResource(input: CreateResourceInput): Promise<{ ok: true; resourceId: string } | Err> {
    const { ctx, code, name, unit, kind, currency, region } = input

    if (!code || !code.trim()) {
      return { ok: false, error: 'Resource code is required', status: 400 }
    }
    if (!name || !name.trim()) {
      return { ok: false, error: 'Resource name is required', status: 400 }
    }
    if (!unit || !unit.trim()) {
      return { ok: false, error: 'Resource unit is required', status: 400 }
    }
    if (!VALID_RESOURCE_KINDS.includes(kind)) {
      return { ok: false, error: `Invalid resource kind: ${kind}. Must be one of: ${VALID_RESOURCE_KINDS.join(', ')}`, status: 400 }
    }

    const resource = await dbTx.$transaction(async (tx) => {
      const created = await resourceRepository.createInTransaction(tx, ctx.organizationId, {
        code: code.trim(),
        name: name.trim(),
        unit: unit.trim(),
        kind,
        currency: currency ?? 'GHS',
        region: region ?? null,
      })

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'resource.created',
        entityType: 'Resource',
        entityId: created.id,
        summary: `Resource "${created.name}" (${created.code}) created — kind=${created.kind}`,
        afterJson: JSON.stringify({ code: created.code, name: created.name, kind: created.kind, unit: created.unit }),
      })

      return created
    })

    return { ok: true, resourceId: resource.id }
  },

  // ─── Price Observations ─────────────────────────────────────────────────

  /**
   * Record a price observation for a Resource.
   *
   * INVARIANT 3: Every important price has provenance.
   * Price observations are APPEND-ONLY — no update or delete.
   * Transactional with audit.
   */
  async recordPriceObservation(input: RecordPriceObservationInput): Promise<{ ok: true; observationId: string } | Err> {
    const { ctx, resourceId, workDefinitionVersionId, price, currency, provenance, sourceReference } = input

    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: 'Price must be a non-negative finite number', status: 400 }
    }
    if (!VALID_PROVENANCE_TYPES.includes(provenance)) {
      return { ok: false, error: `Invalid provenance: ${provenance}. Must be one of: ${VALID_PROVENANCE_TYPES.join(', ')}`, status: 400 }
    }

    const observation = await dbTx.$transaction(async (tx) => {
      const created = await resourcePriceObservationRepository.createInTransaction(tx, ctx.organizationId, {
        resourceId,
        workDefinitionVersionId: workDefinitionVersionId ?? null,
        price,
        currency: currency ?? 'GHS',
        provenance,
        sourceReference: sourceReference ?? null,
        recordedById: ctx.userId,
      })
      if (!created) {
        throw new Error('RESOURCE_OR_WDV_NOT_FOUND')
      }

      await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
        action: 'resource.price-observed',
        entityType: 'ResourcePriceObservation',
        entityId: created.id,
        summary: `Price observed: ${price} ${currency ?? 'GHS'} (${provenance})`,
        afterJson: JSON.stringify({
          resourceId, price, currency: currency ?? 'GHS', provenance,
          sourceReference: sourceReference ?? null,
          workDefinitionVersionId: workDefinitionVersionId ?? null,
        }),
      })

      return created
    }).catch((e) => {
      if (e instanceof Error && e.message === 'RESOURCE_OR_WDV_NOT_FOUND') {
        return { ok: false as const, error: 'Resource or WorkDefinitionVersion not found in this organization', status: 404 }
      }
      throw e
    })

    if ('ok' in observation && observation.ok === false) {
      return observation
    }

    return { ok: true, observationId: (observation as { id: string }).id }
  },

  /**
   * List price observations for a Resource. Tenant-scoped.
   */
  async listPriceObservations(input: ListPriceObservationsInput): Promise<{ ok: true; observations: unknown[] } | Err> {
    const { ctx, resourceId } = input

    // Verify the resource belongs to this org
    const resource = await resourceRepository.getForOrganization(ctx.organizationId, resourceId)
    if (!resource) {
      return { ok: false, error: 'Resource not found', status: 404 }
    }

    const observations = await resourcePriceObservationRepository.listForResource(ctx.organizationId, resourceId)
    return { ok: true, observations }
  },

  // ─── Knowledge Alerts ───────────────────────────────────────────────────

  /**
   * List all KnowledgeAlerts for the organization.
   */
  async listKnowledgeAlerts(input: ListKnowledgeAlertsInput): Promise<{ ok: true; alerts: unknown[] } | Err> {
    const { ctx } = input
    const alerts = await knowledgeAlertRepository.listForOrganization(ctx.organizationId)
    return { ok: true, alerts }
  },

  /**
   * Acknowledge a KnowledgeAlert. Transactional with audit.
   */
  async acknowledgeAlert(input: AcknowledgeAlertInput): Promise<{ ok: true } | Err> {
    const { ctx, alertId } = input

    try {
      await dbTx.$transaction(async (tx) => {
        const acknowledged = await knowledgeAlertRepository.acknowledgeInTransaction(
          tx, ctx.organizationId, alertId,
        )
        if (!acknowledged) {
          throw new Error('ALERT_NOT_FOUND')
        }

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'knowledge-alert.acknowledged',
          entityType: 'KnowledgeAlert',
          entityId: alertId,
          summary: `Knowledge alert acknowledged`,
        })
      })

      return { ok: true }
    } catch (e) {
      if (e instanceof Error && e.message === 'ALERT_NOT_FOUND') {
        return { ok: false, error: 'Knowledge alert not found', status: 404 }
      }
      throw e
    }
  },
}
