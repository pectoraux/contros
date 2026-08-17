/**
 * BOQ repositories — tenant-aware persistence for the BOQ domain.
 *
 * Every method that reads or mutates organization-owned data requires the
 * authenticated organization context (INVARIANT 12). BoqImport is the
 * organization-owned root; BoqItem and BoqBinding are reached via BoqImport,
 * so cross-tenant access is impossible.
 *
 * These repositories make NO business decisions. They persist and retrieve.
 * Business logic (normalization, matching, reconciliation) lives in the pure
 * functions under src/lib/boq. Application orchestration lives in the
 * services under src/application.
 */

import { db, dbTx } from '@/lib/db'

type Tx = Parameters<Parameters<typeof dbTx.$transaction>[0]>[0]

// ─── BoqImport Repository ───────────────────────────────────────────────────

export const boqImportRepository = {
  /** Create an import record (pending parse). Tenant-scoped by construction. */
  async create(
    orgId: string,
    data: {
      opportunityId?: string | null
      documentId?: string | null
      fileReference: string
      fileName: string
      fileHash: string
      source?: string
      createdById?: string | null
    },
  ) {
    return db.boqImport.create({
      data: {
        organizationId: orgId,
        opportunityId: data.opportunityId ?? null,
        documentId: data.documentId ?? null,
        fileReference: data.fileReference,
        fileName: data.fileName,
        fileHash: data.fileHash,
        source: data.source ?? 'client',
        createdById: data.createdById ?? null,
        status: 'pending',
      },
    })
  },

  /** Get a single import, tenant-scoped. Returns null if cross-tenant. */
  async getForOrganization(orgId: string, importId: string) {
    return db.boqImport.findFirst({
      where: { id: importId, organizationId: orgId },
      include: { items: { orderBy: { rowNumber: 'asc' } } },
    })
  },

  /** List imports for an organization (optionally filtered by opportunity). */
  async listForOrganization(orgId: string, opportunityId?: string) {
    return db.boqImport.findMany({
      where: {
        organizationId: orgId,
        ...(opportunityId ? { opportunityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  /** Detect a prior import of the same file hash (re-upload detection). */
  async findByHash(orgId: string, fileHash: string) {
    return db.boqImport.findFirst({
      where: { organizationId: orgId, fileHash },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * List ALL prior imports of the same file hash (H3: re-imports are permitted,
   * but the operator must be able to SEE them). Returns all matching imports,
   * newest first. The service uses this to surface prior imports at create time.
   */
  async findPriorByHash(orgId: string, fileHash: string) {
    return db.boqImport.findMany({
      where: { organizationId: orgId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, status: true, opportunityId: true, createdAt: true },
    })
  },

  /** Mark an import's parse status. */
  async setStatus(orgId: string, importId: string, status: 'parsed' | 'failed') {
    // Tenant-scoped update — won't touch another org's import.
    return db.boqImport.updateMany({
      where: { id: importId, organizationId: orgId },
      data: { status },
    })
  },
}

// ─── BoqItem Repository ─────────────────────────────────────────────────────

export const boqItemRepository = {
  /** Bulk-create items for an import (within a transaction). */
  async createMany(
    tx: Tx,
    boqImportId: string,
    items: Array<{
      worksheet: string
      rowNumber: number
      rawDescription: string
      rawCode: string | null
      rawQuantity: number | null
      rawUnit: string | null
      rawRate: number | null
      rawAmount: number | null
      rawCellJson: string
      normalizedDescription: string | null
      normalizedCode: string | null
      normalizedUnit: string | null
      normalizedQuantity: number | null
      normalizedRate: number | null
      currency: string | null
      provenanceJson: string
    }>,
  ) {
    if (items.length === 0) return { count: 0 }
    return tx.boqItem.createMany({
      data: items.map((i) => ({ boqImportId, ...i })),
    })
  },

  /** List items for an import (tenant-scoped via the import relation). */
  async listForImport(orgId: string, importId: string) {
    return db.boqItem.findMany({
      where: { boqImportId: importId, boqImport: { organizationId: orgId } },
      orderBy: { rowNumber: 'asc' },
    })
  },

  /** Get a single item with its import (tenant-scoped). */
  async getForOrganization(orgId: string, itemId: string) {
    return db.boqItem.findFirst({
      where: { id: itemId, boqImport: { organizationId: orgId } },
      include: { boqImport: true, binding: true },
    })
  },
}

// ─── Canonical Line Loader (for binding + reconciliation) ───────────────────
//
// H1/H5 hardening: the application services must load canonical EstimateLines
// AUTHORITATIVELY (tenant + opportunity scoped), not trust caller-supplied
// projections. This repository method is the single authoritative source for
// "which canonical lines does this BOQ import bind against?" It loads lines
// scoped to the import's opportunity (verified tenant-owned), so a caller
// cannot supply a line from a different opportunity in the same org.

export const canonicalLineRepository = {
  /**
   * Load canonical EstimateLines for a BOQ import's opportunity.
   * Verifies: the import belongs to orgId, AND the import has an opportunityId,
   * AND the loaded lines belong to estimates under that opportunity in that org.
   * Returns the line projection needed by the matcher/reconciler.
   */
  async listForImportOpportunity(
    orgId: string,
    importId: string,
  ): Promise<
    Array<{
      estimateLineId: string
      estimateId: string
      description: string
      unit: string
      quantity: number
      unitRate: number
      workDefinitionCode: string | null
    }>
  > {
    // Load the import to get its opportunityId (tenant-scoped).
    const imp = await db.boqImport.findFirst({
      where: { id: importId, organizationId: orgId },
      select: { opportunityId: true },
    })
    if (!imp) return []
    if (!imp.opportunityId) return []
    // Load lines under that opportunity in this org.
    const lines = await db.estimateLine.findMany({
      where: {
        estimate: {
          organizationId: orgId,
          opportunityId: imp.opportunityId,
        },
      },
      select: {
        id: true,
        estimateId: true,
        description: true,
        unit: true,
        quantity: true,
        unitRate: true,
        workDefinition: { select: { code: true } },
      },
    })
    return lines.map((l) => ({
      estimateLineId: l.id,
      estimateId: l.estimateId,
      description: l.description,
      unit: l.unit,
      quantity: l.quantity,
      unitRate: l.unitRate,
      workDefinitionCode: l.workDefinition?.code ?? null,
    }))
  },

  /**
   * Load a single canonical EstimateLine for reconciliation, scoped to the
   * BoqItem's import opportunity (tenant + opportunity verified).
   * H5: replaces the reconciliation service's direct db.estimateLine calls.
   */
  async getForBoqItem(
    orgId: string,
    boqItemId: string,
  ): Promise<{
    estimateLineId: string
    quantity: number
    unit: string
    unitRate: number
  } | null> {
    // Resolve the item → import → opportunity, then load the bound line under
    // that opportunity scope. This proves the line is a valid candidate for
    // THIS import (not just any line in the org).
    const item = await db.boqItem.findFirst({
      where: { id: boqItemId, boqImport: { organizationId: orgId } },
      select: {
        binding: { select: { estimateLineId: true, status: true } },
        boqImport: { select: { opportunityId: true } },
      },
    })
    if (!item || !item.binding || !item.binding.estimateLineId) return null
    if (item.binding.status !== 'MATCHED') return null
    const line = await db.estimateLine.findFirst({
      where: {
        id: item.binding.estimateLineId,
        estimate: {
          organizationId: orgId,
          ...(item.boqImport.opportunityId
            ? { opportunityId: item.boqImport.opportunityId }
            : {}),
        },
      },
      select: { id: true, quantity: true, unit: true, unitRate: true },
    })
    return line
      ? {
          estimateLineId: line.id,
          quantity: line.quantity,
          unit: line.unit,
          unitRate: line.unitRate,
        }
      : null
  },
}

// ─── BoqBinding Repository ──────────────────────────────────────────────────

export const boqBindingRepository = {
  /** Get the binding for a BoqItem (tenant-scoped via item → import). */
  async getForItem(orgId: string, boqItemId: string) {
    return db.boqBinding.findFirst({
      where: { boqItemId, boqItem: { boqImport: { organizationId: orgId } } },
    })
  },

  /** List all bindings for an import (tenant-scoped). */
  async listForImport(orgId: string, importId: string) {
    return db.boqBinding.findMany({
      where: { boqItem: { boqImportId: importId, boqImport: { organizationId: orgId } } },
      include: { boqItem: true },
    })
  },

  /**
   * Upsert a binding. The boqItem must belong to the org (verified via the
   * import relation). estimateLineId may be null for UNMATCHED/REJECTED.
   */
  async upsert(
    orgId: string,
    data: {
      boqItemId: string
      estimateLineId: string | null
      status: string
      matchMethod: string | null
      candidateIdsJson: string
      confirmedById: string | null
      confirmedAt: Date | null
    },
  ) {
    // Verify the BoqItem belongs to this org AND load its import's opportunity
    // so we can scope the estimateLine to the SAME opportunity (H1 hardening:
    // prevents same-org cross-opportunity binding — a domain-identity violation).
    const item = await db.boqItem.findFirst({
      where: { id: data.boqItemId, boqImport: { organizationId: orgId } },
      select: { id: true, boqImport: { select: { opportunityId: true } } },
    })
    if (!item) {
      throw new Error('BoqItem not found in this organization')
    }
    // If an estimateLineId is provided, verify it belongs to this org AND to the
    // import's opportunity (same org is not enough — wrong-opportunity binding
    // is a domain-identity violation even within one org).
    if (data.estimateLineId) {
      const opportunityFilter = item.boqImport.opportunityId
        ? { opportunityId: item.boqImport.opportunityId }
        : {}
      const line = await db.estimateLine.findFirst({
        where: {
          id: data.estimateLineId,
          estimate: { organizationId: orgId, ...opportunityFilter },
        },
        select: { id: true },
      })
      if (!line) {
        throw new Error(
          'EstimateLine not found in this organization or does not belong to the import opportunity',
        )
      }
    }
    return db.boqBinding.upsert({
      where: { boqItemId: data.boqItemId },
      create: data,
      update: {
        estimateLineId: data.estimateLineId,
        status: data.status,
        matchMethod: data.matchMethod,
        candidateIdsJson: data.candidateIdsJson,
        confirmedById: data.confirmedById,
        confirmedAt: data.confirmedAt,
      },
    })
  },
}
