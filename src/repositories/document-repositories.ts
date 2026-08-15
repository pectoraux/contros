/**
 * Document / DocumentVersion repositories — tenant-aware.
 *
 * These repositories make unscoped retrieval impossible to express — every
 * method requires orgId and verifies the full ownership chain:
 *
 *   Document          → organizationId (direct)
 *   DocumentVersion   → document.organizationId
 *
 * INVARIANT 12: Every organization is isolated from every other organization.
 * A repository must never return an org-owned entity solely from an
 * attacker-supplied ID.
 *
 * Convention: use findFirst (not findUnique) with explicit organizationId
 * filter, so the tenant-safety source-code audit passes.
 *
 * INVARIANT 9: Documents are projections/working copies, not canonical state.
 * DocumentVersions are immutable once finalized — the repository never
 * provides an update method for finalized versions.
 */

import { db } from '@/lib/db'
import type { PrismaTransaction } from './index'

// ─── Document Repository ────────────────────────────────────────────────────

export const documentRepository = {
  /**
   * Get a document for an opportunity + kind, tenant-scoped.
   * Returns null if the opportunity doesn't belong to this org or the
   * document doesn't exist.
   */
  async getForOpportunity(orgId: string, opportunityId: string, kind: string) {
    return db.document.findFirst({
      where: {
        organizationId: orgId,
        opportunityId,
        kind,
      },
      include: {
        versions: {
          orderBy: { revisionNo: 'desc' },
        },
      },
    })
  },

  /**
   * Get a document for an opportunity + kind WITHIN a transaction.
   * Includes draft versions only (for saveDraft optimization).
   * Tenant-scoped.
   */
  async getForOpportunityInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    opportunityId: string,
    kind: string,
  ) {
    return tx.document.findFirst({
      where: {
        organizationId: orgId,
        opportunityId,
        kind,
      },
      include: {
        versions: {
          where: { status: 'draft' },
          orderBy: { revisionNo: 'desc' },
          take: 1,
        },
      },
    })
  },

  /**
   * List all documents for an opportunity, tenant-scoped.
   */
  async listForOpportunity(orgId: string, opportunityId: string) {
    return db.document.findMany({
      where: {
        organizationId: orgId,
        opportunityId,
      },
      include: {
        versions: {
          orderBy: { revisionNo: 'desc' },
          take: 1, // just the latest version
        },
      },
      orderBy: { kind: 'asc' },
    })
  },

  /**
   * Get a single document by ID, tenant-scoped.
   */
  async getForOrganization(orgId: string, documentId: string) {
    return db.document.findFirst({
      where: {
        id: documentId,
        organizationId: orgId,
      },
      include: {
        versions: {
          orderBy: { revisionNo: 'desc' },
        },
      },
    })
  },

  /**
   * Create a document within a transaction. Verifies the opportunity belongs
   * to this org before creating.
   * One document per (opportunityId, kind) — enforced by @@unique.
   */
  async createInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    data: {
      opportunityId: string
      kind: string
    },
  ) {
    // Verify the opportunity belongs to this org.
    const opportunity = await tx.opportunity.findFirst({
      where: { id: data.opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!opportunity) return null

    return tx.document.create({
      data: {
        organizationId: orgId,
        opportunityId: data.opportunityId,
        kind: data.kind,
        status: 'missing',
      },
    })
  },

  /**
   * Update document status + currentVersionId within a transaction.
   * Tenant-scoped via organizationId filter in updateMany.
   */
  async updateInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    documentId: string,
    data: {
      status?: string
      currentVersionId?: string | null
    },
  ) {
    const updated = await tx.document.updateMany({
      where: { id: documentId, organizationId: orgId },
      data,
    })
    return updated.count > 0
  },

  /**
   * Get the latest revision number for a document (for monotonic numbering).
   * Returns 0 if no versions exist yet.
   */
  async getLatestRevisionNoInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    documentId: string,
  ): Promise<number> {
    const doc = await tx.document.findFirst({
      where: { id: documentId, organizationId: orgId },
      select: {
        versions: {
          orderBy: { revisionNo: 'desc' },
          take: 1,
          select: { revisionNo: true },
        },
      },
    })
    return doc?.versions[0]?.revisionNo ?? 0
  },
}

// ─── Document Version Repository ────────────────────────────────────────────
//
// DocumentVersion ownership flows through document → organization.
// Finalized versions are IMMUTABLE — no update method is provided for them.

export const documentVersionRepository = {
  /**
   * Create a new draft version within a transaction.
   * The caller is responsible for computing the next revisionNo.
   * Verifies the document belongs to this org.
   */
  async createDraftInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    documentId: string,
    data: {
      revisionNo: number
      snapshotJson: string
    },
  ) {
    // Verify ownership: document → org
    const doc = await tx.document.findFirst({
      where: { id: documentId, organizationId: orgId },
      select: { id: true, kind: true, opportunityId: true },
    })
    if (!doc) return null

    return tx.documentVersion.create({
      data: {
        documentId,
        revisionNo: data.revisionNo,
        snapshotJson: data.snapshotJson,
        status: 'draft',
      },
    })
  },

  /**
   * Update an existing draft version's snapshotJson within a transaction.
   * Only works on draft versions — finalized versions are immutable.
   * Verifies ownership: version → document → org.
   *
   * Returns true if updated, false if the version doesn't exist, doesn't
   * belong to this org, or is already finalized (immutable).
   */
  async updateDraftSnapshotInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    versionId: string,
    snapshotJson: string,
  ): Promise<boolean> {
    const result = await tx.documentVersion.updateMany({
      where: {
        id: versionId,
        status: 'draft', // only drafts can be updated
        document: { organizationId: orgId },
      },
      data: { snapshotJson },
    })
    return result.count > 0
  },

  /**
   * Finalize a draft version within a transaction.
   * Sets status='finalized', finalizedAt, finalizedById.
   * Verifies ownership chain and that the version is currently a draft.
   *
   * Returns the finalized version, or null if:
   * - the document doesn't belong to this org
   * - the version doesn't exist
   * - the version is already finalized (idempotent — return null to signal "no change")
   */
  async finalizeInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    documentId: string,
    versionId: string,
    finalizedById: string,
  ) {
    // Verify ownership + that the version is a draft
    const version = await tx.documentVersion.findFirst({
      where: {
        id: versionId,
        documentId,
        document: { organizationId: orgId },
        status: 'draft',
      },
      select: { id: true, revisionNo: true, snapshotJson: true },
    })
    if (!version) return null

    const finalizedAt = new Date()
    await tx.documentVersion.update({
      where: { id: versionId },
      data: {
        status: 'finalized',
        finalizedAt,
        finalizedById,
      },
    })

    return { id: versionId, revisionNo: version.revisionNo, finalizedAt }
  },

  /**
   * Get a single version by ID, tenant-scoped via document → org.
   */
  async getForOrganization(orgId: string, versionId: string) {
    return db.documentVersion.findFirst({
      where: {
        id: versionId,
        document: { organizationId: orgId },
      },
    })
  },

  /**
   * List all versions for a document, tenant-scoped.
   */
  async listForDocument(orgId: string, documentId: string) {
    return db.documentVersion.findMany({
      where: {
        documentId,
        document: { organizationId: orgId },
      },
      orderBy: { revisionNo: 'desc' },
    })
  },

  /**
   * Get the latest draft version for a document (if any).
   * Tenant-scoped.
   */
  async getLatestDraftForDocument(orgId: string, documentId: string) {
    return db.documentVersion.findFirst({
      where: {
        documentId,
        document: { organizationId: orgId },
        status: 'draft',
      },
      orderBy: { revisionNo: 'desc' },
    })
  },
}

// ─── Tender Deliverable Link Repository ─────────────────────────────────────
//
// When a DocumentVersion is finalized, the linked TenderDeliverable must be
// updated (status → 'finalized', revisionId → DocumentVersion.id).
// This repository owns that cross-entity link, tenant-scoped via bid → org.

export const tenderDeliverableLinkRepository = {
  /**
   * Update the TenderDeliverable for a given (opportunityId, kind) pair.
   * Finds the bid for the opportunity, then the deliverable by kind.
   * Tenant-scoped via bid → organizationId.
   *
   * Returns true if a deliverable was updated, false if no bid/deliverable
   * exists for this opportunity (which is OK — not all opportunities have bids).
   */
  async updateForOpportunityKindInTransaction(
    tx: PrismaTransaction,
    orgId: string,
    opportunityId: string,
    kind: string,
    data: {
      status: string
      revisionId: string | null
    },
  ): Promise<boolean> {
    // Find the bid for this opportunity (1:1)
    const bid = await tx.bid.findFirst({
      where: { opportunityId, organizationId: orgId },
      select: { id: true },
    })
    if (!bid) return false

    const result = await tx.tenderDeliverable.updateMany({
      where: { bidId: bid.id, kind },
      data,
    })
    return result.count > 0
  },
}
