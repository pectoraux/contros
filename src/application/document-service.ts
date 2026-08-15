/**
 * DocumentService — application service for tender document lifecycle.
 *
 * Manages the 7 document-backed TenderDeliverable kinds:
 *   boq, method-statement, jha, cover-letter, assumptions, clarifications, certificate
 *
 * (The 8th kind, 'programme', is revision-backed and owned by EstimateRevision
 * with revisionType='programme' — NOT by this service.)
 *
 * Architecture:
 *   RequestContext → Service → Repository → Engine → Transaction → Audit
 *
 * Key invariants:
 * - INVARIANT 9: Documents are projections/working copies, not canonical state.
 *   The Estimate is canonical; documents are assembled FROM the estimate + WDV.
 * - DocumentVersions are immutable once finalized. A new draft version is
 *   created for each edit cycle; finalization freezes the snapshot.
 * - One Document per (opportunityId, kind) — enforced by @@unique.
 * - When a DocumentVersion is finalized, the linked TenderDeliverable is
 *   updated: status → 'finalized', revisionId → DocumentVersion.id.
 *   This connects DocumentService to BidService's submission gate WITHOUT
 *   modifying BidService.
 * - All mutations are transactional (dbTx.$transaction) with audit log entries.
 * - No raw Prisma in the service — all access through tenant-scoped repositories.
 * - INVARIANT 5: AI cannot silently commit a document. AI suggestions come
 *   through a separate path; only a human can save/finalize.
 */

import { dbTx } from '@/lib/db'
import type { RequestContext } from '@/lib/context'
import {
  documentRepository,
  documentVersionRepository,
  tenderDeliverableLinkRepository,
  auditLogRepository,
} from '@/repositories'

// ─── Types ──────────────────────────────────────────────────────────────────

type Err = { ok: false; error: string; status: number }

export interface GetDocumentInput {
  ctx: RequestContext
  opportunityId: string
  kind: string
}
export interface ListDocumentsInput {
  ctx: RequestContext
  opportunityId: string
}
export interface SaveDraftInput {
  ctx: RequestContext
  opportunityId: string
  kind: string
  /** The document content — markdown body, assembled fragments, source provenance. */
  content: string
  /** Optional metadata about source fragments (WDV IDs, estimate line IDs) for reproducibility. */
  sourceProvenance?: Record<string, unknown>
}
export interface FinalizeVersionInput {
  ctx: RequestContext
  documentId: string
  /** The version ID to finalize. If omitted, finalizes the latest draft. */
  versionId?: string
}
export interface MarkReadyInput {
  ctx: RequestContext
  documentId: string
}
export interface GetVersionHistoryInput {
  ctx: RequestContext
  documentId: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

// The 7 document-backed kinds. Must match DELIVERABLE_KIND_CLASS in bid-service.ts.
const VALID_DOCUMENT_KINDS = [
  'boq',
  'method-statement',
  'jha',
  'cover-letter',
  'assumptions',
  'clarifications',
  'certificate',
]

const VALID_DOCUMENT_STATUSES = ['missing', 'draft', 'ready', 'finalized']

// ─── DocumentService ────────────────────────────────────────────────────────

export const documentService = {
  /**
   * Get a document for an opportunity + kind. Returns the document with all
   * its versions (latest first). If no document exists yet, returns
   * { ok: true, document: null } — the caller can create one via saveDraft.
   */
  async getDocument(input: GetDocumentInput): Promise<{ ok: true; document: unknown } | Err> {
    const { ctx, opportunityId, kind } = input

    if (!VALID_DOCUMENT_KINDS.includes(kind)) {
      return { ok: false, error: `Invalid document kind: ${kind}. Must be one of: ${VALID_DOCUMENT_KINDS.join(', ')}`, status: 400 }
    }

    const document = await documentRepository.getForOpportunity(
      ctx.organizationId, opportunityId, kind,
    )

    return { ok: true, document }
  },

  /**
   * List all documents for an opportunity. Returns each document with its
   * latest version (if any).
   */
  async listDocuments(input: ListDocumentsInput): Promise<{ ok: true; documents: unknown[] } | Err> {
    const { ctx, opportunityId } = input

    const documents = await documentRepository.listForOrganization(
      ctx.organizationId, opportunityId,
    )

    return { ok: true, documents }
  },

  /**
   * Save a draft version of a document.
   *
   * Behavior:
   * - If no Document exists for this (opportunityId, kind), creates one.
   * - If a draft version already exists, updates its snapshotJson (in-place
   *   draft editing — no new version number).
   * - If no draft exists (previous version was finalized or this is the first),
   *   creates a new draft version with the next revision number.
   *
   * The document status is set to 'draft'.
   *
   * Transactional with audit.
   */
  async saveDraft(input: SaveDraftInput): Promise<{ ok: true; documentId: string; versionId: string; revisionNo: number } | Err> {
    const { ctx, opportunityId, kind, content, sourceProvenance } = input

    if (!VALID_DOCUMENT_KINDS.includes(kind)) {
      return { ok: false, error: `Invalid document kind: ${kind}`, status: 400 }
    }
    if (!content || !content.trim()) {
      return { ok: false, error: 'Document content is required', status: 400 }
    }

    // Build the snapshot JSON — includes the content + source provenance.
    // This is what gets frozen when the version is finalized.
    const snapshotJson = JSON.stringify({
      content: content.trim(),
      sourceProvenance: sourceProvenance ?? null,
      savedAt: new Date().toISOString(),
    })

    try {
      const result = await dbTx.$transaction(async (tx) => {
        // Try to find an existing document for this (opportunity, kind)
        // via the tenant-scoped repository (no raw tx.document.findFirst).
        let document = await documentRepository.getForOpportunityInTransaction(
          tx, ctx.organizationId, opportunityId, kind,
        )

        // Create the document if it doesn't exist
        if (!document) {
          const created = await documentRepository.createInTransaction(tx, ctx.organizationId, {
            opportunityId, kind,
          })
          if (!created) {
            // Opportunity doesn't belong to this org — throw a tagged error
            // so the catch handler can translate it to a 404 Err.
            throw new Error('OPPORTUNITY_NOT_FOUND')
          }
          document = { ...created, versions: [] }
        }

        // Check for an existing draft version
        const existingDraft = document.versions[0]

        let versionId: string
        let revisionNo: number

        if (existingDraft) {
          // Update the existing draft's snapshotJson via the repository
          // (no raw tx.documentVersion.update — immutability enforced by repo)
          await documentVersionRepository.updateDraftSnapshotInTransaction(
            tx, ctx.organizationId, existingDraft.id, snapshotJson,
          )
          versionId = existingDraft.id
          revisionNo = existingDraft.revisionNo
        } else {
          // Create a new draft version with the next revision number
          const latestRevisionNo = await documentRepository.getLatestRevisionNoInTransaction(
            tx, ctx.organizationId, document.id,
          )
          revisionNo = latestRevisionNo + 1

          const newVersion = await documentVersionRepository.createDraftInTransaction(
            tx, ctx.organizationId, document.id,
            { revisionNo, snapshotJson },
          )
          if (!newVersion) {
            throw new Error('VERSION_CREATE_FAILED')
          }
          versionId = newVersion.id
        }

        // Update document status to 'draft'
        await documentRepository.updateInTransaction(tx, ctx.organizationId, document.id, {
          status: 'draft',
        })

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'document.draft-saved',
          entityType: 'Document',
          entityId: document.id,
          summary: `Draft saved: kind=${kind}, revision=${revisionNo}`,
          afterJson: JSON.stringify({
            kind, revisionNo, versionId,
            contentLength: content.trim().length,
            hasProvenance: !!sourceProvenance,
          }),
        })

        return { documentId: document.id, versionId, revisionNo }
      })

      return { ok: true, ...result }
    } catch (e) {
      if (e instanceof Error && e.message === 'OPPORTUNITY_NOT_FOUND') {
        return { ok: false, error: 'Opportunity not found in this organization', status: 404 }
      }
      throw e
    }
  },

  /**
   * Finalize a document version — freeze it as immutable.
   *
   * Behavior:
   * - Finalizes the specified version (or the latest draft if versionId omitted).
   * - Sets Document.status = 'finalized', Document.currentVersionId = versionId.
   * - Updates the linked TenderDeliverable (if a bid exists for this opportunity):
   *   status → 'finalized', revisionId → versionId.
   *   This connects to BidService's submission gate without modifying BidService.
   *
   * Idempotent: if the version is already finalized, returns success without
   * creating a new version.
   *
   * Transactional with audit.
   */
  async finalizeVersion(input: FinalizeVersionInput): Promise<{ ok: true; documentId: string; versionId: string; revisionNo: number; deliverableUpdated: boolean } | Err> {
    const { ctx, documentId, versionId } = input

    try {
      const result = await dbTx.$transaction(async (tx) => {
        // Load the document (tenant-scoped)
        const document = await documentRepository.getForOrganization(
          ctx.organizationId, documentId,
        )
        if (!document) {
          throw new Error('DOCUMENT_NOT_FOUND')
        }

        // Determine which version to finalize
        let targetVersionId: string
        let targetRevisionNo: number

        if (versionId) {
          // Find the specified version
          const version = document.versions.find((v) => v.id === versionId)
          if (!version) {
            throw new Error('VERSION_NOT_FOUND')
          }
          targetVersionId = version.id
          targetRevisionNo = version.revisionNo
        } else {
          // Find the latest draft
          const latestDraft = document.versions.find((v) => v.status === 'draft')
          if (!latestDraft) {
            throw new Error('NO_DRAFT_TO_FINALIZE')
          }
          targetVersionId = latestDraft.id
          targetRevisionNo = latestDraft.revisionNo
        }

        // Finalize the version (idempotent — returns null if already finalized)
        const finalized = await documentVersionRepository.finalizeInTransaction(
          tx, ctx.organizationId, documentId, targetVersionId, ctx.userId,
        )

        if (!finalized) {
          // Version was already finalized — idempotent success (no audit, no deliverable update)
          const version = document.versions.find((v) => v.id === targetVersionId)
          return {
            documentId,
            versionId: targetVersionId,
            revisionNo: version?.revisionNo ?? targetRevisionNo,
            deliverableUpdated: false,
          }
        }

        // Update document status + currentVersionId
        await documentRepository.updateInTransaction(tx, ctx.organizationId, documentId, {
          status: 'finalized',
          currentVersionId: targetVersionId,
        })

        // Update the linked TenderDeliverable (if a bid exists)
        const deliverableUpdated = await tenderDeliverableLinkRepository.updateForOpportunityKindInTransaction(
          tx, ctx.organizationId, document.opportunityId, document.kind,
          { status: 'finalized', revisionId: targetVersionId },
        )

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'document.finalized',
          entityType: 'Document',
          entityId: documentId,
          summary: `Document finalized: kind=${document.kind}, revision=${targetRevisionNo}`,
          afterJson: JSON.stringify({
            kind: document.kind,
            revisionNo: targetRevisionNo,
            versionId: targetVersionId,
            deliverableUpdated,
          }),
        })

        return {
          documentId,
          versionId: targetVersionId,
          revisionNo: targetRevisionNo,
          deliverableUpdated,
        }
      })

      return { ok: true, ...result }
    } catch (e) {
      if (e instanceof Error) {
        if (e.message === 'DOCUMENT_NOT_FOUND') {
          return { ok: false, error: 'Document not found', status: 404 }
        }
        if (e.message === 'VERSION_NOT_FOUND') {
          return { ok: false, error: 'Version not found for this document', status: 404 }
        }
        if (e.message === 'NO_DRAFT_TO_FINALIZE') {
          return { ok: false, error: 'No draft version to finalize — save a draft first', status: 400 }
        }
      }
      throw e
    }
  },

  /**
   * Mark a document as 'ready' (without full finalization).
   *
   * This is a lighter-weight status: the document is ready for inclusion in
   * a tender pack but may still be edited. The BidService submission gate
   * accepts both 'ready' and 'finalized' for document-backed deliverables.
   *
   * FROZEN INVARIANT — Post-ready mutation safety:
   *
   *   `markReady()` requires at least one FINALIZED DocumentVersion to exist
   *   (i.e., `document.currentVersionId` must be non-null). The "ready"
   *   state always references a specific immutable snapshot via
   *   `TenderDeliverable.revisionId = document.currentVersionId`.
   *
   *   After `markReady()`, the user may call `saveDraft()` to create a NEW
   *   draft version. This does NOT change `document.currentVersionId` (only
   *   `finalizeVersion()` changes it) and does NOT change
   *   `TenderDeliverable.revisionId`. The snapshot referenced by the
   *   "ready" state is therefore immutable — later draft edits cannot
   *   retroactively alter the content that the Bid submission gate
   *   considers ready for submission.
   *
   *   If the user wants to update the "ready" snapshot, they must:
   *     1. `saveDraft()` (creates a new draft)
   *     2. `finalizeVersion()` (freezes the new draft, updates currentVersionId)
   *     3. `markReady()` again (re-captures the new currentVersionId)
   *
   * Updates the linked TenderDeliverable.status → 'ready' (if a bid exists).
   * Transactional with audit.
   */
  async markReady(input: MarkReadyInput): Promise<{ ok: true; deliverableUpdated: boolean; revisionId: string | null } | Err> {
    const { ctx, documentId } = input

    try {
      const result = await dbTx.$transaction(async (tx) => {
        const document = await documentRepository.getForOrganization(
          ctx.organizationId, documentId,
        )
        if (!document) {
          throw new Error('DOCUMENT_NOT_FOUND')
        }

        // FROZEN INVARIANT: markReady requires a finalized version.
        // The "ready" state must reference an immutable snapshot via
        // currentVersionId. If no version is finalized, the user must
        // finalize first — this prevents the ambiguous state where
        // "ready" references a mutable draft (or null).
        if (!document.currentVersionId) {
          throw new Error('NO_FINALIZED_VERSION')
        }

        // Update document status
        await documentRepository.updateInTransaction(tx, ctx.organizationId, documentId, {
          status: 'ready',
        })

        // Update the linked TenderDeliverable (if a bid exists).
        // revisionId = currentVersionId (the finalized, immutable version).
        // Subsequent saveDraft() calls do NOT change currentVersionId or
        // this revisionId — the snapshot is frozen.
        const deliverableUpdated = await tenderDeliverableLinkRepository.updateForOpportunityKindInTransaction(
          tx, ctx.organizationId, document.opportunityId, document.kind,
          { status: 'ready', revisionId: document.currentVersionId },
        )

        await auditLogRepository.createInTransaction(tx, ctx.organizationId, ctx.userId, {
          action: 'document.marked-ready',
          entityType: 'Document',
          entityId: documentId,
          summary: `Document marked ready: kind=${document.kind}, revisionId=${document.currentVersionId}`,
          afterJson: JSON.stringify({
            kind: document.kind,
            deliverableUpdated,
            revisionId: document.currentVersionId,
          }),
        })

        return { deliverableUpdated, revisionId: document.currentVersionId }
      })

      return { ok: true, ...result }
    } catch (e) {
      if (e instanceof Error) {
        if (e.message === 'DOCUMENT_NOT_FOUND') {
          return { ok: false, error: 'Document not found', status: 404 }
        }
        if (e.message === 'NO_FINALIZED_VERSION') {
          return { ok: false, error: 'Cannot mark as ready — no finalized version exists. Finalize a version first to create an immutable snapshot.', status: 400 }
        }
      }
      throw e
    }
  },

  /**
   * Get the version history for a document — all versions, latest first.
   * Tenant-scoped.
   */
  async getVersionHistory(input: GetVersionHistoryInput): Promise<{ ok: true; versions: unknown[] } | Err> {
    const { ctx, documentId } = input

    // Verify the document belongs to this org
    const document = await documentRepository.getForOrganization(
      ctx.organizationId, documentId,
    )
    if (!document) {
      return { ok: false, error: 'Document not found', status: 404 }
    }

    const versions = await documentVersionRepository.listForDocument(
      ctx.organizationId, documentId,
    )

    return { ok: true, versions }
  },
}
