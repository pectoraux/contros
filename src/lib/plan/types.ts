/**
 * Plan Domain Contract — pure types for the plan/measurement graph.
 *
 * ARCHITECTURE:
 *   This file contains ONLY types. The pure validation/serialization functions
 *   live in measurement.ts. No Prisma, no DB, no side effects.
 *
 *   PlanArtifact (uploaded source artifact: PDF, DWG, IFC)
 *       ↓ 1:N
 *   PlanSheet (logical sheet: A-101, S-001)
 *       ↓ 1:N (append-only, immutable revisions)
 *   PlanSheetRevision (immutable revision: Rev C, Rev 3)
 *       ↓ 1:N (append-only observations)
 *   PlanMeasurement (measured fact: elementReference, quantity, unit, method)
 *       ↓ [EstimateLine.currentMeasurementId — mutable current lineage]
 *   EstimateLine (canonical commercial hub — already exists)
 *
 * FOUR REFINEMENTS (from the architectural review):
 *
 * 1. PlanMeasurement is EVIDENCE, not EstimateLine-owned truth.
 *    EstimateLine.currentMeasurementId is a mutable "current lineage" pointer,
 *    not ownership. A single measurement can support multiple lines (e.g. slab
 *    area → concrete + formwork + reinforcement). The measurement remains the
 *    upstream observation.
 *
 * 2. Drawing revision status is NOT mutable truth.
 *    PlanSheetRevision is append-only and immutable. "Current" is a DERIVED
 *    selection (latest revision for a PlanSheet), not a mutable status field.
 *    This keeps historical reconstruction deterministic.
 *
 * 3. File identity is SEPARATE from drawing identity.
 *    PlanArtifact.id = uploaded source artifact (file identity).
 *    PlanSheet.id = logical sheet (drawing identity).
 *    fileHash = content identity / duplicate detection.
 *    The same drawing number may appear in multiple uploaded packages.
 *
 * 4. PlanMeasurement has stronger provenance than just elementReference.
 *    measurementBasisJson records HOW the quantity was obtained (points, scale,
 *    formula, tool version) — not merely WHICH drawing it came from. This
 *    matters enormously once CAD/BIM extraction and AI takeoff are added.
 *
 * ADAPTER PRINCIPLE:
 *   The domain types say "PlanSheetRevision" and "PlanMeasurement" — they do
 *   NOT mention DWG, IFC, PDF, Archicad, Revit, or AI. An adapter knows the
 *   source format; the domain is format-neutral. All adapters produce the same
 *   PlanMeasurement domain object:
 *
 *     PDF adapter ───┐
 *     DWG adapter ───┤
 *     IFC adapter ───┼──→ PlanMeasurement
 *     BIM adapter ───┤
 *     AI adapter ────┤
 *     Manual UI ─────┘
 *
 * HISTORICAL INVARIANT:
 *   same PlanSheetRevision
 *   + same measurement input
 *   + same measurement algorithm/version
 *       → same PlanMeasurement content
 *       → same content hash
 *
 *   This mirrors the Programme domain's snapshot determinism:
 *     same ProgrammeSnapshot + same schedule-engine version → same ScheduleResult
 */

// ─── PlanArtifact (the uploaded source artifact) ────────────────────────────

/**
 * A PlanArtifact is an uploaded source file (PDF, DWG, IFC, etc.) that
 * contains one or more drawing sheets.
 *
 * File identity is SEPARATE from drawing identity (refinement 3): the same
 * drawing number may appear in multiple uploaded packages or consultants'
 * submissions. PlanArtifact.id identifies the uploaded file; PlanSheet.id
 * identifies the logical sheet.
 *
 * Mirrors the BoqImport pattern: fileReference + fileName + fileHash + source.
 */
export interface PlanArtifact {
  id: string
  organizationId: string
  opportunityId: string
  /** Storage path / key for the uploaded file. */
  fileReference: string
  /** Original file name (e.g. "architectural-drawings.pdf"). */
  fileName: string
  /** SHA-256 of file contents — content identity + duplicate detection. */
  fileHash: string
  /** Who provided the artifact: client | consultant | tender-portal | internal | other. */
  source: PlanArtifactSource
  /** Optional document ID link (if the artifact is tracked as a Document). */
  documentId: string | null
  createdAt: Date
  createdById: string
}

export type PlanArtifactSource =
  | 'client'
  | 'consultant'
  | 'tender-portal'
  | 'internal'
  | 'other'

// ─── PlanSheet (a logical sheet within an artifact) ─────────────────────────

/**
 * A PlanSheet is a logical drawing sheet (e.g. A-101, S-001) within a
 * PlanArtifact. A single PDF may contain multiple sheets; a DWG may have
 * multiple layouts.
 *
 * Sheet identity: (planArtifactId, sheetNumber) — unique within the artifact.
 * The drawingNumber is the contractor's external drawing identifier (may be
 * shared across artifacts — refinement 3).
 */
export interface PlanSheet {
  id: string
  planArtifactId: string
  /** The sheet number within the artifact (e.g. "A-101", "S-001"). */
  sheetNumber: string
  /** The contractor's external drawing number (e.g. "DWG-2024-001"). */
  drawingNumber: string | null
  /** Human-readable title (e.g. "Ground Floor Plan"). */
  title: string | null
  createdAt: Date
}

// ─── PlanSheetRevision (an immutable revision of a sheet) ───────────────────

/**
 * A PlanSheetRevision is an immutable, append-only revision of a PlanSheet.
 *
 * Refinement 2: revision status is NOT mutable truth. Each revision is
 * immutable once created. "Current" is a DERIVED selection (the latest
 * revision for a PlanSheet), not a mutable status field on the revision.
 * This keeps historical reconstruction deterministic.
 *
 * A new revision does NOT edit the old one — it creates a new
 * PlanSheetRevision row. Old revisions' measurements remain as historical
 * observations.
 *
 * Mirrors the ProgrammeRevision pattern: immutable, append-only, content-addressed.
 */
export interface PlanSheetRevision {
  id: string
  planSheetId: string
  /** The revision identifier (e.g. "Rev C", "Rev 3", "2024-08-15"). */
  revision: string
  /**
   * Optional file/page reference for this specific sheet revision. If the
   * PlanArtifact is a multi-sheet PDF, this might be a page number or a
   * cropped file reference. If the sheet revision has its own file, this
   * is the storage path.
   */
  fileReference: string | null
  /** SHA-256 of the sheet revision content (if separate from the artifact). */
  fileHash: string | null
  createdAt: Date
  createdById: string
}

// ─── PlanMeasurement (a measured fact from a sheet revision) ────────────────

/**
 * The measurement-engine version that produced (or will produce) this
 * measurement. Part of the reproducibility story:
 *   same PlanSheetRevision + same input + same engine version → same content hash.
 *
 * v1 — initial: manual measurement with provenance payload.
 */
export const CURRENT_MEASUREMENT_ENGINE_VERSION = 1

/**
 * A PlanMeasurement is an append-only OBSERVATION — a measured construction
 * fact extracted from a PlanSheetRevision.
 *
 * Refinement 1: the measurement is EVIDENCE, not EstimateLine-owned truth.
 * EstimateLine.currentMeasurementId is a mutable "current lineage" pointer;
 * the measurement itself is immutable and can support multiple lines.
 *
 * Refinement 4: the measurement carries measurementBasisJson — a provenance
 * payload recording HOW the quantity was obtained (points, scale, formula,
 * tool version). This matters enormously once CAD/BIM extraction and AI
 * takeoff are added.
 *
 * The domain type is format-neutral (refinement: no CAD/IFC/PDF concepts).
 * An adapter knows the source format; the domain only records the method.
 *
 * HISTORICAL INVARIANT:
 *   same PlanSheetRevision + same measurement input + same engine version
 *       → same PlanMeasurement content → same content hash
 */
export interface PlanMeasurement {
  id: string
  /** The immutable sheet revision this measurement was extracted from. */
  planSheetRevisionId: string
  /**
   * Optional reference to the drawn element (e.g. "wall-grid-B7",
   * "room-101-floor", "beam-3F-2"). The contractor's reference to the
   * specific element on the sheet.
   */
  elementReference: string | null
  /** How the measurement was obtained (manual, pdf-takeoff, cad-extraction, etc.). */
  measurementMethod: MeasurementMethod
  /** The measured quantity (finite, >= 0). */
  quantity: number
  /** The unit of measurement (m2, m3, m, nr, ton, etc.). May differ from the commercial unit. */
  unit: string
  /**
   * Provenance payload recording HOW the quantity was obtained.
   * Structure evolves; examples:
   *   { source: "manual", points: [...], scale: "1:100", formula: "length × count" }
   *   { source: "cad-extraction", layer: "Walls", toolVersion: "autoCAD-2024" }
   *   { source: "ai-extraction", model: "glm-v1", confidence: 0.92 }
   *
   * This is the key explainability field: we can reconstruct HOW the number
   * was derived, not merely WHICH drawing it came from.
   */
  measurementBasisJson: string
  /** The measurement-engine version that produced this measurement. */
  measurementEngineVersion: number
  /** Content hash of the measurement content (for determinism verification). */
  contentHash: string
  measuredById: string
  measuredAt: Date
  createdAt: Date
}

/**
 * The recognized measurement methods. Each corresponds to an adapter that
 * produces PlanMeasurement objects. The domain is format-neutral; the method
 * records the provenance.
 */
export type MeasurementMethod =
  | 'manual' // someone measured it by hand from a print/PDF
  | 'pdf-takeoff' // measured from a PDF using on-screen tools
  | 'cad-extraction' // extracted from a DWG/DXF via an adapter
  | 'bim-export' // exported from an IFC/BIM model
  | 'ai-extraction' // AI-assisted extraction from a drawing image

/**
 * The content projection of a PlanMeasurement — the subset that defines the
 * measurement's identity for content hashing. Excludes metadata (id, createdAt,
 * measuredById, measuredAt) that doesn't affect the measurement's content.
 *
 * same content projection → same content hash
 * (regardless of when/by whom it was recorded)
 */
export interface PlanMeasurementContent {
  planSheetRevisionId: string
  elementReference: string | null
  measurementMethod: MeasurementMethod
  quantity: number
  unit: string
  measurementBasisJson: string
  measurementEngineVersion: number
}

// ─── Validation result ──────────────────────────────────────────────────────

export interface PlanMeasurementValidationResult {
  ok: boolean
  errors: string[]
}
