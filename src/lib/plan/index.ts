/**
 * Plan domain — pure types + measurement validation/content-hash functions.
 *
 * The plan/measurement graph: drawing artifact → sheet → revision → measurement.
 * No DB, no Prisma, no side effects.
 *
 * ARCHITECTURE:
 *   PlanArtifact (uploaded source)
 *       ↓ 1:N
 *   PlanSheet (logical sheet)
 *       ↓ 1:N (append-only, immutable)
 *   PlanSheetRevision (immutable revision)
 *       ↓ 1:N (append-only observations)
 *   PlanMeasurement (measured fact — evidence, not EstimateLine-owned truth)
 *       ↓ [EstimateLine.currentMeasurementId — mutable current lineage]
 *   EstimateLine (canonical commercial hub — already exists)
 *
 * The domain is format-neutral. Adapters (PDF, DWG, IFC, BIM, AI, Manual)
 * all produce the same PlanMeasurement domain object.
 */

export * from './types'
export * from './measurement'
