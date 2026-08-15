/**
 * Tenant-safe dereferencing — source code audit.
 *
 * Scans the application service and repository files for unscoped lookups.
 * The business logic now lives in src/application/ and src/repositories/,
 * not in the API routes.
 *
 * Run: bun test tests/unit/tenant-safety.test.ts
 */
import { test, expect, describe } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const APP_DIR = join(process.cwd(), 'src', 'application')
const REPO_DIR = join(process.cwd(), 'src', 'repositories')

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
  test('no unscoped findUnique on org-owned entities in application/repositories', async () => {
    const files = [...(await findTsFiles(APP_DIR)), ...(await findTsFiles(REPO_DIR))]
    const violations: string[] = []

    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      const orgOwnedEntities = [
        'opportunity', 'estimate', 'estimateLine', 'estimateRevision',
        'subcontractQuote', 'subcontractPackage', 'subcontractPackageLine',
        'scopeAtom', 'quoteScopeCoverage', 'workDefinition', 'workDefinitionVersion',
        'resource', 'resourcePriceObservation', 'bid', 'commercialException',
        'projectActual', 'calibrationProposal', 'client', 'auditLog', 'knowledgeAlert',
      ]
      for (const entity of orgOwnedEntities) {
        const pattern = new RegExp(`db\\.${entity}\\.findUnique\\(`, 'g')
        let match
        while ((match = pattern.exec(content)) !== null) {
          const after = content.substring(match.index, match.index + 300)
          if (!after.includes('organizationId') && !after.includes('ctx.organizationId')) {
            violations.push(`${file}: db.${entity}.findUnique without organizationId`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  test('estimate-service scopes subcontract quote lookup via org chain', async () => {
    const content = await readFile(join(APP_DIR, 'estimate-service.ts'), 'utf-8')
    // The service uses subcontractQuoteRepository.getForOrganization which is org-scoped
    expect(content).toContain('subcontractQuoteRepository.getForOrganization')
    expect(content).not.toContain('db.subcontractQuote.findUnique')
  })

  test('repositories expose org-scoped methods, not getById', async () => {
    const content = await readFile(join(REPO_DIR, 'index.ts'), 'utf-8')
    expect(content).toContain('getForOrganization')
    expect(content).not.toMatch(/getById\(/)
    // The subcontractQuoteRepository must scope via subcontractPackage.opportunity.organizationId
    expect(content).toContain('subcontractPackage:')
    expect(content).toContain('opportunity:')
    expect(content).toContain('organizationId')
  })

  test('price-line route is a thin adapter (no direct Prisma access)', async () => {
    const content = await readFile(join(process.cwd(), 'src', 'app', 'api', 'estimates', '[id]', 'price-line', 'route.ts'), 'utf-8')
    expect(content).not.toContain('db.estimateLine.findFirst')
    expect(content).not.toContain('db.subcontractQuote.findFirst')
    expect(content).not.toContain('db.subcontractPackageLine.findFirst')
    expect(content).toContain('estimateService.recomputeLine')
  })

  test('finalize-revision route is a thin adapter', async () => {
    const content = await readFile(join(process.cwd(), 'src', 'app', 'api', 'estimates', '[id]', 'finalize-revision', 'route.ts'), 'utf-8')
    expect(content).not.toContain('db.estimate.findFirst')
    expect(content).not.toContain('db.subcontractQuote.findFirst')
    expect(content).toContain('estimateService.finalizeRevision')
  })
})
