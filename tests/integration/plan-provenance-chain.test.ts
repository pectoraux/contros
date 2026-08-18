/**
 * Plan domain integration tests — full provenance chain end-to-end.
 *
 * Proves the evidence chain against PostgreSQL:
 *   authenticated tenant
 *   → upload/register PlanArtifact
 *   → create PlanSheet + immutable revision
 *   → create manual PlanMeasurement
 *   → validate + content-hash it
 *   → link it to an EstimateLine
 *   → retrieve the complete provenance chain
 *
 * Also proves:
 *   - cross-tenant isolation (404)
 *   - validation rejects invalid measurements (NaN, negative, bad method)
 *   - content hash is deterministic (same input → same hash)
 *   - one measurement can support multiple EstimateLines
 *   - rebinding EstimateLine.currentMeasurementId doesn't affect the old measurement
 *
 * Requires: TEST_DATABASE_URL pointing to PostgreSQL.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { planService } from '../../src/application/plan-service'
import { computeMeasurementContentHash, CURRENT_MEASUREMENT_ENGINE_VERSION } from '../../src/lib/plan'
import type { RequestContext } from '../../src/lib/context'

const db = new PrismaClient()

const ORG_A = 'test-pl-org-a'
const ORG_B = 'test-pl-org-b'
const USER_A = 'test-pl-user-a'
const USER_B = 'test-pl-user-b'
const CLIENT_A = 'test-pl-client-a'
const OPP_A = 'test-pl-opp-a'
const OPP_B = 'test-pl-opp-b'
const ESTIMATE_A = 'test-pl-estimate-a'
const ESTIMATE_B = 'test-pl-estimate-b'
const ESTIMATE_LINE_1 = 'test-pl-line-1'
const ESTIMATE_LINE_2 = 'test-pl-line-2'
const ESTIMATE_LINE_B = 'test-pl-line-b'

const ctxA: RequestContext = {
  userId: USER_A, organizationId: ORG_A, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test A', email: 'a@pl.test',
}
const ctxB: RequestContext = {
  userId: USER_B, organizationId: ORG_B, role: 'estimator', isDemo: false,
  actorType: 'human', name: 'Test B', email: 'b@pl.test',
}

describe('Plan domain integration tests — provenance chain', () => {
  let artifactId: string
  let sheetId: string
  let revisionId: string
  let measurementId: string

  beforeAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.planMeasurement.deleteMany({ where: { planSheetRevision: { planSheet: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } } } }).catch(() => {})
    await db.planSheetRevision.deleteMany({ where: { planSheet: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } } }).catch(() => {})
    await db.planSheet.deleteMany({ where: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } }).catch(() => {})
    await db.planArtifact.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { opportunity: { organizationId: { startsWith: 'test-pl-' } } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: { startsWith: 'test-pl-' } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-pl-' } } }).catch(() => {})

    await db.organization.create({ data: { id: ORG_A, name: 'PL Org A', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_A, organizationId: ORG_A, name: 'User A', email: 'a@pl.test', role: 'estimator' } })
    await db.client.create({ data: { id: CLIENT_A, organizationId: ORG_A, name: 'Client A' } })
    await db.opportunity.create({ data: { id: OPP_A, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp A', status: 'estimating' } })
    // P2: Second opportunity in the SAME org (for cross-opportunity test).
    await db.opportunity.create({ data: { id: OPP_B, organizationId: ORG_A, clientId: CLIENT_A, title: 'Opp B', status: 'estimating' } })
    await db.organization.create({ data: { id: ORG_B, name: 'PL Org B', currency: 'GHS' } })
    await db.user.create({ data: { id: USER_B, organizationId: ORG_B, name: 'User B', email: 'b@pl.test', role: 'estimator' } })

    // Create an estimate + 2 estimate lines in OPP_A (for the measurement linkage).
    await db.estimate.create({ data: { id: ESTIMATE_A, organizationId: ORG_A, opportunityId: OPP_A, version: 1, status: 'draft' } })
    await db.estimateLine.create({ data: { id: ESTIMATE_LINE_1, estimateId: ESTIMATE_A, description: 'Concrete supply', quantity: 184.6, unit: 'm2', executionStrategy: 'self-perform' } })
    await db.estimateLine.create({ data: { id: ESTIMATE_LINE_2, estimateId: ESTIMATE_A, description: 'Formwork', quantity: 184.6, unit: 'm2', executionStrategy: 'self-perform' } })

    // P2: Create an estimate + line in OPP_B (for cross-opportunity test).
    await db.estimate.create({ data: { id: ESTIMATE_B, organizationId: ORG_A, opportunityId: OPP_B, version: 1, status: 'draft' } })
    await db.estimateLine.create({ data: { id: ESTIMATE_LINE_B, estimateId: ESTIMATE_B, description: 'Other project line', quantity: 50, unit: 'm2', executionStrategy: 'self-perform' } })
  }, 120000)

  afterAll(async () => {
    await db.planMeasurement.deleteMany({ where: { planSheetRevision: { planSheet: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } } } }).catch(() => {})
    await db.planSheetRevision.deleteMany({ where: { planSheet: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } } }).catch(() => {})
    await db.planSheet.deleteMany({ where: { planArtifact: { organizationId: { startsWith: 'test-pl-' } } } }).catch(() => {})
    await db.planArtifact.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.estimateLine.deleteMany({ where: { estimate: { opportunity: { organizationId: { startsWith: 'test-pl-' } } } } }).catch(() => {})
    await db.estimate.deleteMany({ where: { opportunity: { organizationId: { startsWith: 'test-pl-' } } } }).catch(() => {})
    await db.opportunity.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.client.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.organization.deleteMany({ where: { id: { startsWith: 'test-pl-' } } }).catch(() => {})
    await db.$disconnect()
  }, 120000)

  // ── 1. Create PlanArtifact ────────────────────────────────────────────────

  test('create PlanArtifact → registered', async () => {
    const res = await planService.createArtifact({
      ctx: ctxA, opportunityId: OPP_A,
      fileReference: '/storage/drawings/arch-drawing.pdf',
      fileName: 'architectural-drawings.pdf',
      fileHash: 'abc123def456',
      source: 'consultant',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.fileHash).toBe('abc123def456')
    expect(res.artifact.source).toBe('consultant')
    artifactId = res.artifact.id
  }, 60000)

  // ── 2. Create PlanSheet ───────────────────────────────────────────────────

  test('create PlanSheet → registered', async () => {
    const res = await planService.createSheet({
      ctx: ctxA, planArtifactId: artifactId,
      sheetNumber: 'A-101',
      drawingNumber: 'DWG-2024-001',
      title: 'Ground Floor Plan',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.sheet.sheetNumber).toBe('A-101')
    sheetId = res.sheet.id
  }, 60000)

  // ── 3. Create PlanSheetRevision (immutable) ───────────────────────────────

  test('create PlanSheetRevision → immutable', async () => {
    const res = await planService.createRevision({
      ctx: ctxA, planSheetId: sheetId,
      revision: 'Rev C',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.revision.revision).toBe('Rev C')
    revisionId = res.revision.id
  }, 60000)

  // ── 4. Create PlanMeasurement (manual) ────────────────────────────────────

  test('create PlanMeasurement → validated + content-hashed', async () => {
    const res = await planService.createMeasurement({
      ctx: ctxA, planSheetRevisionId: revisionId,
      elementReference: 'wall-grid-B7',
      measurementMethod: 'manual',
      quantity: 184.6,
      unit: 'm2',
      measurementBasisJson: '{"source":"manual","scale":"1:100","formula":"length × height"}',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.measurement.quantity).toBe(184.6)
    expect(res.measurement.unit).toBe('m2')
    expect(res.measurement.measurementMethod).toBe('manual')
    expect(res.measurement.contentHash).toBeTruthy()
    expect(res.measurement.measurementEngineVersion).toBe(CURRENT_MEASUREMENT_ENGINE_VERSION)
    measurementId = res.measurement.id
  }, 60000)

  // ── 5. Content hash is deterministic ──────────────────────────────────────

  test('content hash is deterministic (same input → same hash)', async () => {
    // Re-compute the hash from the same content and verify it matches.
    const measurement = await db.planMeasurement.findUnique({ where: { id: measurementId } })
    expect(measurement).toBeTruthy()

    // The hash should match what the service computed.
    const expectedHash = computeMeasurementContentHash({
      id: measurement!.id,
      planSheetRevisionId: measurement!.planSheetRevisionId,
      elementReference: measurement!.elementReference,
      measurementMethod: measurement!.measurementMethod as 'manual',
      quantity: measurement!.quantity,
      unit: measurement!.unit,
      measurementBasisJson: measurement!.measurementBasisJson,
      measurementEngineVersion: measurement!.measurementEngineVersion,
      contentHash: '',
      measuredById: measurement!.measuredById,
      measuredAt: measurement!.measuredAt,
      createdAt: measurement!.createdAt,
    })
    expect(measurement!.contentHash).toBe(expectedHash)
  }, 60000)

  // ── 6. Link measurement to EstimateLine ───────────────────────────────────

  test('link measurement to EstimateLine → current lineage set', async () => {
    const res = await planService.linkToEstimateLine({
      ctx: ctxA,
      estimateLineId: ESTIMATE_LINE_1,
      planMeasurementId: measurementId,
    })
    expect(res.ok).toBe(true)

    // Verify the EstimateLine's currentMeasurementId is set.
    const line = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_1 } })
    expect(line!.currentMeasurementId).toBe(measurementId)
  }, 60000)

  // ── 7. One measurement supports multiple EstimateLines ────────────────────

  test('one measurement supports multiple EstimateLines', async () => {
    // Link the SAME measurement to a second EstimateLine.
    const res = await planService.linkToEstimateLine({
      ctx: ctxA,
      estimateLineId: ESTIMATE_LINE_2,
      planMeasurementId: measurementId,
    })
    expect(res.ok).toBe(true)

    // Both lines now point to the same measurement.
    const line1 = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_1 } })
    const line2 = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_2 } })
    expect(line1!.currentMeasurementId).toBe(measurementId)
    expect(line2!.currentMeasurementId).toBe(measurementId)
  }, 60000)

  // ── 8. Retrieve the complete provenance chain ─────────────────────────────

  test('retrieve provenance chain → measurement → revision → sheet → artifact', async () => {
    const res = await planService.getProvenanceChain({ ctx: ctxA, planMeasurementId: measurementId })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const m = res.measurement
    expect(m.id).toBe(measurementId)
    expect(m.quantity).toBe(184.6)
    expect(m.planSheetRevision.id).toBe(revisionId)
    expect(m.planSheetRevision.revision).toBe('Rev C')
    expect(m.planSheetRevision.planSheet.id).toBe(sheetId)
    expect(m.planSheetRevision.planSheet.sheetNumber).toBe('A-101')
    expect(m.planSheetRevision.planSheet.planArtifact.id).toBe(artifactId)
    expect(m.planSheetRevision.planSheet.planArtifact.fileName).toBe('architectural-drawings.pdf')

    // The measurement should reference both EstimateLines.
    expect(m.estimateLines.length).toBe(2)
    expect(m.estimateLines.some((l) => l.id === ESTIMATE_LINE_1)).toBe(true)
    expect(m.estimateLines.some((l) => l.id === ESTIMATE_LINE_2)).toBe(true)
  }, 60000)

  // ── 9. Cross-tenant isolation → 404 ───────────────────────────────────────

  test('cross-tenant: Org B cannot read Org A measurement → 404', async () => {
    const res = await planService.getProvenanceChain({ ctx: ctxB, planMeasurementId: measurementId })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  test('cross-tenant: Org B cannot create artifact on Org A opportunity → 404', async () => {
    const res = await planService.createArtifact({
      ctx: ctxB, opportunityId: OPP_A,
      fileReference: '/storage/hack.pdf',
      fileName: 'hack.pdf',
      fileHash: 'hack',
      source: 'internal',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  }, 60000)

  // ── 10. Validation rejects invalid measurements ───────────────────────────

  test('NaN quantity → 422', async () => {
    const res = await planService.createMeasurement({
      ctx: ctxA, planSheetRevisionId: revisionId,
      measurementMethod: 'manual',
      quantity: NaN,
      unit: 'm2',
      measurementBasisJson: '{}',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  test('negative quantity → 422', async () => {
    const res = await planService.createMeasurement({
      ctx: ctxA, planSheetRevisionId: revisionId,
      measurementMethod: 'manual',
      quantity: -5,
      unit: 'm2',
      measurementBasisJson: '{}',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  test('invalid measurement method → 422', async () => {
    const res = await planService.createMeasurement({
      ctx: ctxA, planSheetRevisionId: revisionId,
      measurementMethod: 'telepathy' as 'manual',
      quantity: 100,
      unit: 'm2',
      measurementBasisJson: '{}',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
  }, 60000)

  // ── 11. Rebinding EstimateLine doesn't affect the old measurement ─────────

  test('rebinding EstimateLine to a new measurement → old measurement unchanged', async () => {
    // Create a second measurement.
    const res2 = await planService.createMeasurement({
      ctx: ctxA, planSheetRevisionId: revisionId,
      elementReference: 'wall-grid-B8',
      measurementMethod: 'manual',
      quantity: 95.3,
      unit: 'm2',
      measurementBasisJson: '{"source":"manual","scale":"1:100"}',
    })
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    const measurement2Id = res2.measurement.id

    // Rebind ESTIMATE_LINE_1 to the new measurement.
    const linkRes = await planService.linkToEstimateLine({
      ctx: ctxA,
      estimateLineId: ESTIMATE_LINE_1,
      planMeasurementId: measurement2Id,
    })
    expect(linkRes.ok).toBe(true)

    // ESTIMATE_LINE_1 now points to measurement2.
    const line1 = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_1 } })
    expect(line1!.currentMeasurementId).toBe(measurement2Id)

    // The OLD measurement is unchanged (immutable evidence).
    const oldMeasurement = await db.planMeasurement.findUnique({ where: { id: measurementId } })
    expect(oldMeasurement).toBeTruthy()
    expect(oldMeasurement!.quantity).toBe(184.6) // unchanged

    // ESTIMATE_LINE_2 still points to the old measurement.
    const line2 = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_2 } })
    expect(line2!.currentMeasurementId).toBe(measurementId)
  }, 60000)

  // ── 12. P2: Cross-opportunity link (same tenant, different opportunity) → 422 ─

  test('P2: cross-opportunity link (same tenant, different opportunity) → 422', async () => {
    // The measurement belongs to OPP_A (via the artifact). The EstimateLine
    // belongs to OPP_B (same org, different project). This must be rejected —
    // a plan measurement from one project must NEVER become current lineage
    // for a different project's commercial line merely because both belong to
    // the same tenant.
    const res = await planService.linkToEstimateLine({
      ctx: ctxA,
      estimateLineId: ESTIMATE_LINE_B, // belongs to OPP_B
      planMeasurementId: measurementId, // belongs to OPP_A
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/same opportunity/i)

    // P3: Verify the EstimateLine was NOT mutated — the transaction rolled back.
    const lineB = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_B } })
    expect(lineB!.currentMeasurementId).toBeNull() // unchanged — atomic rollback
  }, 60000)

  // ── 12b. P3: Transaction-boundary atomicity — failed link leaves no side effects ─

  test('P3: failed link (nonexistent measurement) → EstimateLine unchanged (atomic)', async () => {
    // Attempt a link with a nonexistent measurement ID. The transaction should
    // roll back — the EstimateLine must NOT be mutated.
    const res = await planService.linkToEstimateLine({
      ctx: ctxA,
      estimateLineId: ESTIMATE_LINE_2, // a valid line
      planMeasurementId: 'nonexistent-measurement-id', // invalid
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)

    // The EstimateLine must be unchanged — the transaction rolled back.
    const line2 = await db.estimateLine.findUnique({ where: { id: ESTIMATE_LINE_2 } })
    // It should still point to the old measurement (or null if not yet linked).
    expect(line2!.currentMeasurementId).not.toBe('nonexistent-measurement-id')
  }, 60000)

  // ── 13. P4: Invalid documentId → 422 ─────────────────────────────────────

  test('P4: invalid documentId (wrong opportunity) → 422', async () => {
    // Create a Document in OPP_B.
    const docB = await db.document.create({
      data: {
        organizationId: ORG_A,
        opportunityId: OPP_B,
        kind: 'boq',
        status: 'draft',
      },
    })

    // Attempt to create an artifact in OPP_A with a documentId from OPP_B.
    const res = await planService.createArtifact({
      ctx: ctxA, opportunityId: OPP_A,
      fileReference: '/storage/test.pdf',
      fileName: 'test.pdf',
      fileHash: 'testdocvalidation',
      source: 'internal',
      documentId: docB.id, // belongs to OPP_B, not OPP_A
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(422)
    expect(res.error).toMatch(/Document does not belong/i)

    // Clean up.
    await db.document.delete({ where: { id: docB.id } }).catch(() => {})
  }, 60000)

  // ── 14. P4: Valid documentId (same opportunity) → succeeds ────────────────

  test('P4: valid documentId (same opportunity) → succeeds', async () => {
    // Create a Document in OPP_A.
    const docA = await db.document.create({
      data: {
        organizationId: ORG_A,
        opportunityId: OPP_A,
        kind: 'boq',
        status: 'draft',
      },
    })

    const res = await planService.createArtifact({
      ctx: ctxA, opportunityId: OPP_A,
      fileReference: '/storage/test2.pdf',
      fileName: 'test2.pdf',
      fileHash: 'testdocvalid',
      source: 'internal',
      documentId: docA.id, // belongs to OPP_A — valid
    })
    expect(res.ok).toBe(true)

    // Clean up.
    await db.document.delete({ where: { id: docA.id } }).catch(() => {})
  }, 60000)
})
