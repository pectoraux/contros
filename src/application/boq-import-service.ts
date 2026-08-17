/**
 * BoqImportService — application service for BOQ import ingestion.
 *
 * Owns: tenant validation, transaction boundaries, repository calls, audit
 * logging, and parse-status transitions.
 *
 * Does NOT own: matching/binding/reconciliation (those are BoqBindingService
 * and BoqReconciliationService), pricing (PricingEngine), or any mutation of
 * EstimateLine (INVARIANT: import never touches canonical commercial state).
 *
 * The XLSX parser adapter is injected (parseRows) so this service stays
 * format-agnostic. The parser produces RawBoqRow[]; this service normalizes
 * them (pure function) and persists BoqItems with both raw* and normalized*
 * fields preserved.
 *
 * INVARIANT 5: an imported BOQ rate can NEVER silently commit a price.
 * INVARIANT 9: the XLSX is a working copy, not canonical state.
 */

import { dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import { auditLogRepository, boqImportRepository, boqItemRepository } from '@/repositories'
import { normalizeRows, type RawBoqRow, type NormalizedBoqItem } from '@/lib/boq'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateImportInput {
  ctx: RequestContext
  opportunityId?: string | null
  documentId?: string | null
  fileReference: string
  fileName: string
  fileHash: string
  source?: 'client' | 'consultant' | 'tender-portal' | 'internal' | 'other'
}

export interface ParseImportInput {
  ctx: RequestContext
  importId: string
  /** Format-agnostic parser producing raw rows. Injected by the route. */
  parseRows: (fileReference: string) => Promise<RawBoqRow[]>
}

export interface CreateImportResult {
  ok: true
  import: {
    id: string
    status: string
    fileHash: string
    fileName: string
  }
  /**
   * Prior imports of the same fileHash in this organization (H3: re-imports are
   * permitted, but surfaced so the operator is aware). Empty array on first upload.
   */
  priorImportsOfSameHash: Array<{
    id: string
    fileName: string
    status: string
    opportunityId: string | null
    createdAt: Date
  }>
}

export interface ParseImportResult {
  ok: true
  importId: string
  itemCount: number
  status: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build the structured provenance JSON for a BoqItem. */
function buildProvenance(
  importId: string,
  worksheet: string,
  rowNumber: number,
  source: string,
): string {
  return JSON.stringify({
    importId,
    worksheet,
    rowNumber,
    source,
    importedAt: new Date().toISOString(),
  })
}

/** Convert normalized items to repository-ready rows. */
function toRepoItems(
  items: NormalizedBoqItem[],
  importId: string,
  source: string,
) {
  return items.map((i) => ({
    worksheet: i.worksheet,
    rowNumber: i.rowNumber,
    rawDescription: i.rawDescription,
    rawCode: i.rawCode,
    rawQuantity: i.rawQuantity,
    rawUnit: i.rawUnit,
    rawRate: i.rawRate,
    rawAmount: i.rawAmount,
    rawCellJson: i.rawCellJson,
    normalizedDescription: i.normalizedDescription,
    normalizedCode: i.normalizedCode,
    normalizedUnit: i.normalizedUnit,
    normalizedQuantity: i.normalizedQuantity,
    normalizedRate: i.normalizedRate,
    currency: null as string | null,
    provenanceJson: buildProvenance(importId, i.worksheet, i.rowNumber, source),
  }))
}

// ─── Service ────────────────────────────────────────────────────────────────

export const boqImportService = {
  /**
   * Create an import record (status: pending). The file must already be
   * stored at fileReference; this records its existence and hash.
   *
   * H2 hardening: validates the import↔opportunity↔document graph and tenant
   * ownership BEFORE creating the record.
   * R2: the validation is delegated to boqImportRepository.validateImportContext
   * so this service contains NO direct Prisma calls (preserves Application
   * Service → Repository → Database). The service orchestrates validate →
   * create → audit without knowing Prisma query syntax.
   */
  async createImport(input: CreateImportInput): Promise<CreateImportResult> {
    const { ctx } = input
    const opportunityId = input.opportunityId ?? null
    const documentId = input.documentId ?? null

    // R2: validate the import↔opportunity↔document graph via the repository.
    // Returns the RESOLVED opportunityId (inferred from the document when only
    // documentId is supplied). Throws on invalid references (we attach 422).
    let resolved: { opportunityId: string | null; documentId: string | null }
    try {
      resolved = await boqImportRepository.validateImportContext(
        ctx.organizationId,
        opportunityId,
        documentId,
      )
    } catch (e) {
      const err = new Error(
        e instanceof Error ? e.message : String(e),
      ) as Error & { status: number }
      err.status = 422
      throw err
    }

    const record = await boqImportRepository.create(ctx.organizationId, {
      opportunityId: resolved.opportunityId,
      documentId: resolved.documentId,
      fileReference: input.fileReference,
      fileName: input.fileName,
      fileHash: input.fileHash,
      source: input.source ?? 'client',
      createdById: ctx.userId,
    })
    // H3: surface prior imports of the same hash (re-imports are permitted,
    // but the operator must be aware). Returns the PRIOR imports (excludes this
    // one), newest first.
    const priorImports = await boqImportRepository.findPriorByHash(
      ctx.organizationId,
      input.fileHash,
    )
    const priorImportsExcludingThis = priorImports.filter(
      (p) => p.id !== record.id,
    )
    await auditLogRepository.create(ctx.organizationId, ctx.userId, {
      action: 'boq.import.created',
      entityType: 'BoqImport',
      entityId: record.id,
      summary: `BOQ import created: ${input.fileName} (hash ${input.fileHash.substring(0, 12)}…${priorImportsExcludingThis.length > 0 ? `, ${priorImportsExcludingThis.length} prior import(s) of same hash` : ''})`,
    })
    return {
      ok: true,
      import: {
        id: record.id,
        status: record.status,
        fileHash: record.fileHash,
        fileName: record.fileName,
      },
      priorImportsOfSameHash: priorImportsExcludingThis,
    }
  },

  /**
   * Parse an import's file into BoqItems. Runs normalization (pure) and
   * persists items in a single transaction. Marks the import parsed/failed.
   *
   * The parser is injected so this service is format-agnostic and testable
   * without real XLSX files.
   */
  async parseImport(input: ParseImportInput): Promise<ParseImportResult> {
    const { ctx, importId, parseRows } = input
    // Load tenant-scoped.
    const imp = await boqImportRepository.getForOrganization(
      ctx.organizationId,
      importId,
    )
    if (!imp) {
      const err = new Error('BOQ import not found') as Error & { status: number }
      err.status = 404
      throw err
    }

    let rawRows: RawBoqRow[]
    try {
      rawRows = await parseRows(imp.fileReference)
    } catch (e) {
      await boqImportRepository.setStatus(ctx.organizationId, importId, 'failed')
      await auditLogRepository.create(ctx.organizationId, ctx.userId, {
        action: 'boq.import.failed',
        entityType: 'BoqImport',
        entityId: importId,
        summary: `BOQ parse failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      const err = new Error(
        `BOQ parse failed: ${e instanceof Error ? e.message : String(e)}`,
      ) as Error & { status: number }
      err.status = 422
      throw err
    }

    const normalized = normalizeRows(rawRows)
    const repoItems = toRepoItems(normalized, importId, imp.source)

    // Persist items + flip status in one transaction.
    await dbTx.$transaction(async (tx) => {
      if (repoItems.length > 0) {
        await boqItemRepository.createMany(tx, importId, repoItems)
      }
      await tx.boqImport.update({
        where: { id: importId },
        data: { status: 'parsed' },
      })
    })

    await auditLogRepository.create(ctx.organizationId, ctx.userId, {
      action: 'boq.import.parsed',
      entityType: 'BoqImport',
      entityId: importId,
      summary: `BOQ parsed: ${repoItems.length} item(s) extracted from ${imp.fileName}`,
      afterJson: JSON.stringify({ itemCount: repoItems.length }),
    })

    return {
      ok: true,
      importId,
      itemCount: repoItems.length,
      status: 'parsed',
    }
  },

  /** Get an import with its items (tenant-scoped). */
  async getImport(ctx: RequestContext, importId: string) {
    const imp = await boqImportRepository.getForOrganization(
      ctx.organizationId,
      importId,
    )
    if (!imp) {
      const err = new Error('BOQ import not found') as Error & { status: number }
      err.status = 404
      throw err
    }
    return imp
  },

  /** List imports for an organization (optionally per opportunity). */
  async listImports(ctx: RequestContext, opportunityId?: string) {
    return boqImportRepository.listForOrganization(
      ctx.organizationId,
      opportunityId,
    )
  },
}
