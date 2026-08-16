/**
 * DocumentService integration tests — REAL adversarial tests with actual
 * Neon DB data.
 *
 * Run: bun test tests/integration/document-service.test.ts
 *
 * Requires: DATABASE_URL pointing to Neon PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { documentService } from '../../src/application/document-service'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-doc-org-a'
const ORG_B = 'test-doc-org-b'
const USER_A = 'test-doc-user-a'
const USER_B = 'test-doc-user-b'
const CLIENT_A = 'test-doc-client-a'
const CLIENT_B = 'test-doc-client-b'
const OPP_A = 'test-doc-opp-a'
const OPP_B = 'test-doc-opp-b'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false, actorType: 'human',
  name: 'Test User A', email: 'a@doc-test.com',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false, actorType: 'human',
  name: 'Test User B', email: 'b@doc-test.com',
}

describe('DocumentService integration tests', () => {
  beforeAll(async () => {
    // Clean up any leftover data
    await db.documentVersion.deleteMany({ where: { document: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.document.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'Doc Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@doc-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Doc Opp A', status: 'scope-development' } })
    await db.scopePackage.create({ data: { opportunityId: OPP_A, completeness: 0, origin: 'rfq' } })

    await db.organization.create({ data: { id: ORG_B, name: 'Doc Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@doc-test.com', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_B, organizationId: ORG_B, name: 'Client B' } })
    await db.opportunity.create({ data: { id: OPP_B, organizationId: ORG_B, clientId: CLIENT_B, title: 'Doc Opp B', status: 'scope-development' } })
    await db.scopePackage.create({ data: { opportunityId: OPP_B, completeness: 0, origin: 'rfq' } })
  }, 120000)

  afterAll(async () => {
    await db.documentVersion.deleteMany({ where: { document: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.document.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.scopePackage.deleteMany({ where: { opportunity: { organizationId: { in: [ORG_A, ORG_B] } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  beforeEach(async () => {
    await db.documentVersion.deleteMany({ where: { document: { organizationId: ORG_A } } }).catch(() => {})
    await db.document.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.tenderDeliverable.deleteMany({ where: { bid: { organizationId: ORG_A } } }).catch(() => {})
    await db.bid.deleteMany({ where: { organizationId: ORG_A } }).catch(() => {})
    await db.auditLog.deleteMany({ where: { organizationId: ORG_A, entityType: 'Document' } }).catch(() => {})
  }, 30000)

  // ── Basic document lifecycle ──────────────────────────────────────────────

  test('saveDraft creates a document + first draft version', async () => {
    const result = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'method-statement',
      content: '# Method Statement\n\n## Foundation Works\n...',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.revisionNo).toBe(1)

    const doc = await db.document.findUnique({
      where: { id: result.documentId },
      include: { versions: true },
    })
    expect(doc?.kind).toBe('method-statement')
    expect(doc?.status).toBe('draft')
    expect(doc?.versions.length).toBe(1)
    expect(doc?.versions[0]?.status).toBe('draft')
    expect(doc?.versions[0]?.revisionNo).toBe(1)

    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, entityType: 'Document', entityId: result.documentId },
    })
    expect(audit?.action).toBe('document.draft-saved')
  }, 30000)

  test('saveDraft updates existing draft (no new version number)', async () => {
    // First save
    const r1 = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'jha',
      content: 'First draft',
    })
    if (!r1.ok) return

    // Second save — should update the existing draft, not create a new version
    const r2 = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'jha',
      content: 'Updated draft content',
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return

    expect(r2.revisionNo).toBe(1) // same revision number
    expect(r2.versionId).toBe(r1.versionId) // same version ID

    const doc = await db.document.findUnique({
      where: { id: r1.documentId },
      include: { versions: true },
    })
    expect(doc?.versions.length).toBe(1) // still only one version

    // Verify the content was updated
    const snapshot = JSON.parse(doc?.versions[0]?.snapshotJson ?? '{}')
    expect(snapshot.content).toBe('Updated draft content')
  }, 30000)

  test('finalizeVersion freezes a draft as immutable', async () => {
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'boq',
      content: '# BOQ\n\nItem 1: 100 m2 @ GHS 50',
    })
    if (!saveResult.ok) return

    const finalizeResult = await documentService.finalizeVersion({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    expect(finalizeResult.ok).toBe(true)
    if (!finalizeResult.ok) return

    expect(finalizeResult.revisionNo).toBe(1)

    // Verify the version is finalized
    const version = await db.documentVersion.findUnique({
      where: { id: finalizeResult.versionId },
    })
    expect(version?.status).toBe('finalized')
    expect(version?.finalizedAt).not.toBeNull()
    expect(version?.finalizedById).toBe(USER_A)

    // Verify the document status + currentVersionId
    const doc = await db.document.findUnique({
      where: { id: saveResult.documentId },
    })
    expect(doc?.status).toBe('finalized')
    expect(doc?.currentVersionId).toBe(finalizeResult.versionId)

    // Verify audit log
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'document.finalized', entityId: saveResult.documentId },
    })
    expect(audit).not.toBeNull()
  }, 30000)

  test('saveDraft after finalize creates a NEW version (revision 2)', async () => {
    // First: save + finalize
    const r1 = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'assumptions',
      content: 'Version 1 content',
    })
    if (!r1.ok) return
    await documentService.finalizeVersion({ ctx: ctxA, documentId: r1.documentId })

    // Second: save a new draft — should create version 2
    const r2 = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'assumptions',
      content: 'Version 2 content',
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return

    expect(r2.revisionNo).toBe(2)
    expect(r2.versionId).not.toBe(r1.versionId)

    const doc = await db.document.findUnique({
      where: { id: r1.documentId },
      include: { versions: { orderBy: { revisionNo: 'asc' } } },
    })
    expect(doc?.versions.length).toBe(2)
    expect(doc?.versions[0]?.status).toBe('finalized')
    expect(doc?.versions[0]?.revisionNo).toBe(1)
    expect(doc?.versions[1]?.status).toBe('draft')
    expect(doc?.versions[1]?.revisionNo).toBe(2)
  }, 30000)

  // ── Immutability ──────────────────────────────────────────────────────────

  test('Finalized version cannot be modified via saveDraft', async () => {
    // Save + finalize
    const r1 = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'cover-letter',
      content: 'Original',
    })
    if (!r1.ok) return
    const f1 = await documentService.finalizeVersion({ ctx: ctxA, documentId: r1.documentId })
    if (!f1.ok) return

    // Attempt to update the finalized version's snapshotJson directly via the repo
    // This should return false (immutable)
    const { dbTx } = await import('../../src/lib/db')
    const { documentVersionRepository } = await import('../../src/repositories')
    const updated = await dbTx.$transaction(async (tx) => {
      return documentVersionRepository.updateDraftSnapshotInTransaction(
        tx, ORG_A, f1.versionId, 'Tampered content',
      )
    })
    expect(updated).toBe(false)

    // Verify the content was NOT changed
    const version = await db.documentVersion.findUnique({ where: { id: f1.versionId } })
    const snapshot = JSON.parse(version?.snapshotJson ?? '{}')
    expect(snapshot.content).toBe('Original')
  }, 30000)

  // ── Cross-tenant isolation ────────────────────────────────────────────────

  test('Org B cannot get Org A document', async () => {
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'method-statement',
      content: 'Org A secret method statement',
    })
    if (!saveResult.ok) return

    // Org B tries to read Org A's document
    const result = await documentService.getDocument({
      ctx: ctxB, opportunityId: OPP_A, kind: 'method-statement',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document).toBeNull() // not found in Org B
  }, 30000)

  test('Org B cannot finalize Org A document', async () => {
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'jha',
      content: 'Org A JHA',
    })
    if (!saveResult.ok) return

    const result = await documentService.finalizeVersion({
      ctx: ctxB, documentId: saveResult.documentId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
  }, 30000)

  test('Org B cannot save draft to Org A opportunity', async () => {
    const result = await documentService.saveDraft({
      ctx: ctxB, opportunityId: OPP_A, kind: 'method-statement',
      content: 'Cross-tenant attempt',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }

    // Verify no document was created in Org A
    const docs = await db.document.findMany({
      where: { organizationId: ORG_A, opportunityId: OPP_A, kind: 'method-statement' },
    })
    expect(docs.length).toBe(0)
  }, 30000)

  // ── TenderDeliverable integration ────────────────────────────────────────

  test('Finalizing a document updates the linked TenderDeliverable', async () => {
    // Create an estimate + bid + deliverables for the opportunity
    const estimate = await db.estimate.create({
      data: { id: 'test-doc-est-td', organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' },
    })
    const bid = await db.bid.create({
      data: { id: 'test-doc-bid-td', organizationId: ORG_A, opportunityId: OPP_A, estimateId: estimate.id, tenderPackStatus: 'draft' },
    })
    await db.tenderDeliverable.create({
      data: { bidId: bid.id, kind: 'method-statement', required: true, status: 'missing' },
    })

    // Save + finalize a method-statement document
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'method-statement',
      content: '# Method Statement\n...',
    })
    if (!saveResult.ok) return

    const finalizeResult = await documentService.finalizeVersion({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    expect(finalizeResult.ok).toBe(true)
    if (!finalizeResult.ok) return

    expect(finalizeResult.deliverableUpdated).toBe(true)

    // Verify the TenderDeliverable was updated
    const deliverable = await db.tenderDeliverable.findFirst({
      where: { bidId: bid.id, kind: 'method-statement' },
    })
    expect(deliverable?.status).toBe('finalized')
    expect(deliverable?.revisionId).toBe(finalizeResult.versionId)

    // Cleanup
    await db.tenderDeliverable.deleteMany({ where: { bidId: bid.id } })
    await db.bid.delete({ where: { id: bid.id } })
    await db.estimate.delete({ where: { id: estimate.id } })
  }, 30000)

  test('markReady updates TenderDeliverable status to ready (requires finalized version)', async () => {
    const estimate = await db.estimate.create({
      data: { id: 'test-doc-est-ready', organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' },
    })
    const bid = await db.bid.create({
      data: { id: 'test-doc-bid-ready', organizationId: ORG_A, opportunityId: OPP_A, estimateId: estimate.id, tenderPackStatus: 'draft' },
    })
    await db.tenderDeliverable.create({
      data: { bidId: bid.id, kind: 'boq', required: true, status: 'missing' },
    })

    // Save a draft + finalize (markReady requires a finalized version)
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'boq',
      content: '# BOQ draft',
    })
    if (!saveResult.ok) return
    const finalizeResult = await documentService.finalizeVersion({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    if (!finalizeResult.ok) return

    // Mark as ready
    const readyResult = await documentService.markReady({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    expect(readyResult.ok).toBe(true)
    if (!readyResult.ok) return
    expect(readyResult.deliverableUpdated).toBe(true)
    expect(readyResult.revisionId).toBe(finalizeResult.versionId)

    // Verify the TenderDeliverable
    const deliverable = await db.tenderDeliverable.findFirst({
      where: { bidId: bid.id, kind: 'boq' },
    })
    expect(deliverable?.status).toBe('ready')
    expect(deliverable?.revisionId).toBe(finalizeResult.versionId)

    // Cleanup
    await db.tenderDeliverable.deleteMany({ where: { bidId: bid.id } })
    await db.bid.delete({ where: { id: bid.id } })
    await db.estimate.delete({ where: { id: estimate.id } })
  }, 30000)

  test('markReady rejects when no finalized version exists', async () => {
    // Save a draft only (don't finalize)
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'cover-letter',
      content: 'Draft only, not finalized',
    })
    if (!saveResult.ok) return

    const result = await documentService.markReady({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('no finalized version')
    }
  }, 30000)

  // ── FROZEN INVARIANT: Post-ready mutation safety ──────────────────────────

  test('FROZEN INVARIANT: draft edits after markReady cannot change the ready snapshot', async () => {
    // Setup: create a bid + deliverable for this opportunity
    const estimate = await db.estimate.create({
      data: { id: 'test-doc-est-inv', organizationId: ORG_A, opportunityId: OPP_A, status: 'draft' },
    })
    const bid = await db.bid.create({
      data: { id: 'test-doc-bid-inv', organizationId: ORG_A, opportunityId: OPP_A, estimateId: estimate.id, tenderPackStatus: 'draft' },
    })
    await db.tenderDeliverable.create({
      data: { bidId: bid.id, kind: 'method-statement', required: true, status: 'missing' },
    })

    // 1. Save a draft + finalize (version 1)
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'method-statement',
      content: 'Version 1 — original method statement',
      sourceProvenance: { wdvIds: ['wdv-1', 'wdv-2'] },
    })
    if (!saveResult.ok) return
    const finalizeResult = await documentService.finalizeVersion({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    if (!finalizeResult.ok) return
    const readyVersionId = finalizeResult.versionId

    // 2. Mark as ready — captures revisionId = finalized version
    const readyResult = await documentService.markReady({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    if (!readyResult.ok) return
    expect(readyResult.revisionId).toBe(readyVersionId)

    // 3. Capture the snapshot content at the "ready" point
    const readyVersion = await db.documentVersion.findUnique({ where: { id: readyVersionId } })
    const readySnapshot = JSON.parse(readyVersion?.snapshotJson ?? '{}')
    expect(readySnapshot.content).toBe('Version 1 — original method statement')

    // 4. Now edit the document — save a NEW draft (version 2)
    const editResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'method-statement',
      content: 'Version 2 — TAMPERED content that should NOT affect the ready snapshot',
    })
    if (!editResult.ok) return
    expect(editResult.revisionNo).toBe(2) // new draft version

    // 5. INVARIANT CHECK: TenderDeliverable.revisionId must NOT have changed
    const deliverableAfter = await db.tenderDeliverable.findFirst({
      where: { bidId: bid.id, kind: 'method-statement' },
    })
    expect(deliverableAfter?.revisionId).toBe(readyVersionId) // still version 1!
    expect(deliverableAfter?.status).toBe('ready') // still ready

    // 6. INVARIANT CHECK: The finalized version's snapshot must NOT have changed
    const readyVersionAfter = await db.documentVersion.findUnique({ where: { id: readyVersionId } })
    const readySnapshotAfter = JSON.parse(readyVersionAfter?.snapshotJson ?? '{}')
    expect(readySnapshotAfter.content).toBe('Version 1 — original method statement')
    expect(readySnapshotAfter.content).not.toContain('TAMPERED')

    // 7. INVARIANT CHECK: document.currentVersionId must NOT have changed
    // (only finalizeVersion changes it, not saveDraft)
    const docAfter = await db.document.findUnique({ where: { id: saveResult.documentId } })
    expect(docAfter?.currentVersionId).toBe(readyVersionId) // still version 1!

    // 8. The new draft (version 2) IS editable — but it's a separate version
    const draftVersion = await db.documentVersion.findFirst({
      where: {
        documentId: saveResult.documentId,
        revisionNo: 2,
      },
    })
    expect(draftVersion?.status).toBe('draft')
    const draftSnapshot = JSON.parse(draftVersion?.snapshotJson ?? '{}')
    expect(draftSnapshot.content).toContain('TAMPERED')

    // Cleanup
    await db.tenderDeliverable.deleteMany({ where: { bidId: bid.id } })
    await db.bid.delete({ where: { id: bid.id } })
    await db.estimate.delete({ where: { id: estimate.id } })
  }, 45000)

  // ── Version history ──────────────────────────────────────────────────────

  test('getVersionHistory returns all versions latest-first', async () => {
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'clarifications',
      content: 'V1',
    })
    if (!saveResult.ok) return
    await documentService.finalizeVersion({ ctx: ctxA, documentId: saveResult.documentId })
    await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'clarifications',
      content: 'V2',
    })
    await documentService.finalizeVersion({ ctx: ctxA, documentId: saveResult.documentId })
    await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'clarifications',
      content: 'V3 draft',
    })

    const result = await documentService.getVersionHistory({
      ctx: ctxA, documentId: saveResult.documentId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const versions = result.versions as { revisionNo: number; status: string }[]
    expect(versions.length).toBe(3)
    expect(versions[0]?.revisionNo).toBe(3) // latest first
    expect(versions[0]?.status).toBe('draft')
    expect(versions[1]?.revisionNo).toBe(2)
    expect(versions[1]?.status).toBe('finalized')
    expect(versions[2]?.revisionNo).toBe(1)
    expect(versions[2]?.status).toBe('finalized')
  }, 30000)

  // ── Invalid kind validation ──────────────────────────────────────────────

  test('saveDraft rejects invalid document kind', async () => {
    const result = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'invalid-kind',
      content: 'test',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('Invalid document kind')
    }
  }, 30000)

  test('saveDraft rejects "programme" kind (revision-backed, not document-backed)', async () => {
    const result = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'programme',
      content: 'test',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
    }
  }, 30000)

  // ── Transaction rollback ─────────────────────────────────────────────────

  test('P0: Document version insert rolls back when audit log fails', async () => {
    // First create a document + draft normally
    const saveResult = await documentService.saveDraft({
      ctx: ctxA, opportunityId: OPP_A, kind: 'certificate',
      content: 'Rollback test draft',
    })
    if (!saveResult.ok) return

    const docBefore = await db.document.findUnique({
      where: { id: saveResult.documentId },
      include: { versions: true },
    })
    const versionCountBefore = docBefore?.versions.length ?? 0

    // Now attempt a transaction that will fail at the audit step
    const { dbTx } = await import('../../src/lib/db')
    const { documentRepository, documentVersionRepository, auditLogRepository } = await import('../../src/repositories')

    let threw = false
    try {
      await dbTx.$transaction(async (tx) => {
        const latestRevNo = await documentRepository.getLatestRevisionNoInTransaction(
          tx, ORG_A, saveResult.documentId,
        )
        const newVersion = await documentVersionRepository.createDraftInTransaction(
          tx, ORG_A, saveResult.documentId,
          { revisionNo: latestRevNo + 1, snapshotJson: '{"content":"rollback"}' },
        )
        if (!newVersion) throw new Error('version creation failed')

        // This will fail: non-existent actorId violates FK
        await auditLogRepository.createInTransaction(tx, ORG_A, 'nonexistent-user-id', {
          action: 'document.draft-saved',
          entityType: 'Document',
          entityId: saveResult.documentId,
          summary: 'This should roll back',
        })
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)

    // Verify the new version was NOT persisted
    const docAfter = await db.document.findUnique({
      where: { id: saveResult.documentId },
      include: { versions: true },
    })
    expect(docAfter?.versions.length).toBe(versionCountBefore)
  }, 30000)
})
