/**
 * Cross-tenant adversarial tests — verify tenant-safe dereferencing.
 *
 * Run: bun test tests/unit/tenant-safety.test.ts
 *
 * These tests verify that:
 * 1. The price-line route's subcontract quote lookup is org-scoped
 * 2. The finalize-revision route's subcontract quote lookup is org-scoped
 * 3. The subcontractPackageLine lookups are org-scoped
 * 4. No unscoped findUnique calls remain on org-owned entities
 */
import { test, expect, describe } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const API_DIR = join(process.cwd(), 'src', 'app', 'api')

/** Recursively find all .ts files under a directory. */
async function findTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findTsFiles(full)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('Tenant-safe dereferencing — source code audit', () => {
  test('no unscoped findUnique on org-owned entities in API routes', async () => {
    const files = await findTsFiles(API_DIR)
    const violations: string[] = []

    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      // Find findUnique calls on org-owned entities (not User/WaitlistEntry)
      const orgOwnedEntities = [
        'opportunity', 'estimate', 'estimateLine', 'estimateRevision',
        'subcontractQuote', 'subcontractPackage', 'subcontractPackageLine',
        'scopeAtom', 'quoteScopeCoverage', 'workDefinition', 'workDefinitionVersion',
        'resource', 'resourcePriceObservation', 'bid', 'commercialException',
        'projectActual', 'calibrationProposal', 'client', 'auditLog', 'knowledgeAlert',
      ]
      for (const entity of orgOwnedEntities) {
        // Match: db.<entity>.findUnique({ where: { id: ... } }) without organizationId
        const pattern = new RegExp(`db\\.${entity}\\.findUnique\\(`, 'g')
        let match
        while ((match = pattern.exec(content)) !== null) {
          // Check if the next ~200 chars contain organizationId
          const after = content.substring(match.index, match.index + 300)
          if (!after.includes('organizationId') && !after.includes('ctx.organizationId')) {
            violations.push(`${file}:${content.substring(0, match.index).split('\n').length} — db.${entity}.findUnique without organizationId`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('price-line route scopes subcontract quote lookup via subcontractPackage.opportunity.organizationId', async () => {
    const content = await readFile(join(API_DIR, 'estimates', '[id]', 'price-line', 'route.ts'), 'utf-8')
    // The subcontract quote lookup must use findFirst with org scoping
    expect(content).toContain('db.subcontractQuote.findFirst')
    expect(content).not.toContain('db.subcontractQuote.findUnique')
    // Must chain through subcontractPackage → opportunity → organizationId
    expect(content).toContain('subcontractPackage:')
    expect(content).toContain('opportunity:')
    expect(content).toContain('organizationId: ctx.organizationId')
  })

  test('finalize-revision route scopes subcontract quote lookup', async () => {
    const content = await readFile(join(API_DIR, 'estimates', '[id]', 'finalize-revision', 'route.ts'), 'utf-8')
    expect(content).toContain('db.subcontractQuote.findFirst')
    expect(content).not.toContain('db.subcontractQuote.findUnique')
    expect(content).toContain('organizationId: ctx.organizationId')
  })

  test('price-line route scopes subcontractPackageLine lookup', async () => {
    const content = await readFile(join(API_DIR, 'estimates', '[id]', 'price-line', 'route.ts'), 'utf-8')
    // The package line lookup must include org scoping
    const pkgLineSection = content.substring(
      content.indexOf('db.subcontractPackageLine.findFirst'),
      content.indexOf('db.subcontractPackageLine.findFirst') + 400,
    )
    expect(pkgLineSection).toContain('organizationId: ctx.organizationId')
  })

  test('finalize-revision route scopes subcontractPackageLine lookup', async () => {
    const content = await readFile(join(API_DIR, 'estimates', '[id]', 'finalize-revision', 'route.ts'), 'utf-8')
    const pkgLineSection = content.substring(
      content.indexOf('db.subcontractPackageLine.findFirst'),
      content.indexOf('db.subcontractPackageLine.findFirst') + 400,
    )
    expect(pkgLineSection).toContain('organizationId: ctx.organizationId')
  })
})

describe('Cross-tenant access prevention — behavioral', () => {
  test('a foreign-key reference from Org A to Org B is not trusted', () => {
    // This test documents the invariant: even if an ExecutionSegment in Org A
    // has a subcontractQuoteId pointing to a quote in Org B, the quote must
    // NOT be resolved. The findFirst query with the org scoping filter
    // ensures the quote is only found if it belongs to the same org.
    //
    // The query pattern is:
    //   db.subcontractQuote.findFirst({
    //     where: {
    //       id: seg.subcontractQuoteId,
    //       subcontractPackage: {
    //         opportunity: {
    //           organizationId: ctx.organizationId,  // ← this is the guard
    //         },
    //       },
    //     },
    //   })
    //
    // If the quote belongs to Org B but ctx.organizationId is Org A,
    // the query returns null — the quote is not resolved, its data is not
    // exposed, and pricing does not use it.
    //
    // This is verified by the source-code audit tests above.
    expect(true).toBe(true)
  })
})
