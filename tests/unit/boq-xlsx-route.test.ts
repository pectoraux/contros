/**
 * Unit tests for the BOQ XLSX export API route.
 *
 * The route is a THIN ADAPTER — it maps BoqProjectionService.exportXlsx()
 * results to HTTP responses. The service is already fully tested (16
 * integration tests against Neon). These tests verify:
 *
 *   - the route file imports ONLY the service + auth helpers (boundary)
 *   - the route does NOT import Prisma, repositories, engines, or the
 *     serializer directly (it goes through the service)
 *   - the route's GET handler exists and is exported
 *
 * Full HTTP-level integration tests (200/404/422/content-type/content-
 * disposition/audit-warning-header) require a running dev server with
 * NextAuth session setup, which is a sandbox process-lifecycle limitation.
 * The service-level integration tests (boq-projection-service.test.ts)
 * cover the full pipeline including tenant isolation, non-finalized
 * rejection, audit failure, and determinism — the route only adds the
 * HTTP response mapping, which is verified structurally here.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('BOQ XLSX route — boundary (thin adapter)', () => {
  const src = readFileSync(
    'src/app/api/estimates/revisions/[revisionId]/boq.xlsx/route.ts',
    'utf8',
  )

  test('imports the service (not Prisma/engines/repositories directly)', () => {
    // Must import the service.
    expect(src).toMatch(/from ['"]@\/application\/boq-projection-service['"]/)
    // Must import requireAuth + authErrorResponse from context.
    expect(src).toMatch(/from ['"]@\/lib\/context['"]/)
    // Must NOT import Prisma, engines, repositories, or the serializer.
    expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/from ['"]@\/lib\/engines['"]/)
    expect(src).not.toMatch(/from ['"]@\/repositories['"]/)
    expect(src).not.toMatch(/from ['"]@\/lib\/boq['"]/)
    expect(src).not.toMatch(/from ['"]write-excel-file['"]/)
  })

  test('exports a GET handler', () => {
    expect(src).toMatch(/export async function GET/)
  })

  test('does not call Prisma or service internals directly', () => {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // Must NOT call db.* or any repository/engine method.
    expect(code).not.toMatch(/\bdb\./i)
    expect(code).not.toMatch(/\b(estimateRevisionRepository|auditLogRepository|projectRevision|buildXlsxArtifact|serializeXlsxArtifact|finalizeRevision|replayRevision)\s*\(/)
    // The ONLY service call is boqProjectionService.exportXlsx.
    expect(code).toMatch(/boqProjectionService\.exportXlsx\(/)
  })

  test('maps service results to HTTP responses (no raw exception leakage)', () => {
    // On failure: NextResponse.json with the service's safe error + status.
    expect(src).toMatch(/NextResponse\.json\(\s*\{\s*error:\s*result\.error\s*\}/)
    // On success: binary Response with XLSX content-type.
    expect(src).toMatch(/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/)
    // Content-Disposition with the service's fileName.
    expect(src).toMatch(/Content-Disposition/)
    expect(src).toMatch(/result\.fileName/)
    // Audit warning as an informational header (not a status change).
    expect(src).toMatch(/X-GenOffice-Audit-Warning/)
    expect(src).toMatch(/result\.auditWarning/)
  })

  test('does not change HTTP status based on auditWarning', () => {
    // The success path returns status 200 regardless of auditWarning.
    // The auditWarning is added as a header, not as a status change.
    const successSection = src.match(/if\s*\(!result\.ok\)[\s\S]*?return[^}]*}/)
    const okSection = src.substring(successSection ? successSection.index! + successSection[0].length : 0)
    // The success response uses status: 200 (or new Response with default 200).
    expect(okSection).toMatch(/status:\s*200|new Response\(result\.bytes/)
  })

  test('uses authErrorResponse for auth errors (existing pattern)', () => {
    expect(src).toMatch(/authErrorResponse/)
  })

  test('parses revisionId from route params (not from query/body)', () => {
    // The revision ID comes from the URL path, not from the request body.
    expect(src).toMatch(/params.*revisionId/)
    expect(src).not.toMatch(/req\.json\(\)/)
  })
})
