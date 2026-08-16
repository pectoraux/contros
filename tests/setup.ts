// ─────────────────────────────────────────────────────────────────────────────
// Test database environment loader.
//
// WHY THIS EXISTS
// The Contractor OS mandates Neon PostgreSQL as canonical persistence
// (INVARIANT 10). The integration suite MUST run against PostgreSQL, never
// SQLite, so that the frozen service suites are verified against the same
// database technology the application ships on.
//
// In some sandbox/CI shells, a SQLite DATABASE_URL
// (e.g. `file:/home/z/my-project/db/custom.db`) is exported into the
// environment. Both Bun and Next.js respect a pre-existing process.env value
// OVER a value declared in `.env`, so that SQLite value would silently
// override the postgres URL in `.env`. Prisma then rejects the datasource
// (`provider = "postgresql"` vs a `file:` URL) and every integration test
// fails at PrismaClientInitializationError — a false negative that masks the
// real, passing suite.
//
// WHAT THIS DOES
// This file is registered as a Bun preload (see bunfig.toml) so it runs
// BEFORE any test module imports `@/lib/db`. It establishes the PostgreSQL
// test database URL with a strict, auditable policy:
//
//   CI (process.env.CI === 'true' or '1'):
//     TEST_DATABASE_URL is MANDATORY. There is NO fallback. Integration tests
//     in CI must run against a dedicated test database — never silently
//     against the application/shared development Neon database, even if .env
//     happens to be present. This is the architectural standard.
//
//   local (no CI env):
//     1. TEST_DATABASE_URL      — explicit dedicated test DB (preferred).
//     2. .env DATABASE_URL      — convenience fallback for local dev only,
//                                  parsed directly from the .env FILE, NOT
//                                  the shell, so an inherited SQLite value
//                                  can never win.
//
// It validates that the resolved URL is postgresql:// (or postgres://) and
// fails loudly otherwise. It never falls back to a non-postgres shell value.
//
// This is infrastructure configuration, not application code — it does not
// touch any frozen service, repository, or domain model.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return out // file absent — caller will handle
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // strip matching surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function isPostgresUrl(url: string | undefined): url is string {
  return (
    !!url &&
    (url.startsWith('postgresql://') || url.startsWith('postgres://'))
  )
}

/** Render a URL with credentials redacted, for safe logging. */
function redact(url: string): string {
  try {
    return url.replace(/(\/\/[^:]+:)[^@]+@/, '$1***@')
  } catch {
    return '(unparseable)'
  }
}

const dotenv = parseEnvFile(resolve(process.cwd(), '.env'))

// CI detection — virtually every CI provider (Vercel, GitHub Actions, etc.)
// sets CI=true. In CI we REQUIRE a dedicated test database; .env is NOT a
// fallback, so destructive integration tests can never silently run against
// the application/shared development database.
const isCI =
  process.env.CI === 'true' || process.env.CI === '1' || process.env.CI === 1

// TEST_DATABASE_URL is always the preferred source.
const explicitTestUrl = process.env.TEST_DATABASE_URL || undefined

// .env DATABASE_URL is a LOCAL-DEV convenience fallback ONLY. Never used in CI.
const dotenvUrl = !isCI ? dotenv.DATABASE_URL || undefined : undefined

const testUrl = explicitTestUrl || dotenvUrl || undefined

const testDirectUrl =
  process.env.TEST_DIRECT_DATABASE_URL ||
  (!isCI ? dotenv.DIRECT_DATABASE_URL || undefined : undefined) ||
  testUrl ||
  undefined

if (!testUrl) {
  // Fail loudly — never silently run against nothing or against a SQLite shell value.
  if (isCI) {
    console.error(
      '\n[FATAL tests/setup.ts] CI environment detected, but TEST_DATABASE_URL is not set.\n' +
        'In CI, a DEDICATED PostgreSQL test database is MANDATORY (architectural standard).\n' +
        'The .env application DATABASE_URL is intentionally NOT used as a fallback in CI,\n' +
        'so destructive integration tests can never silently run against the shared\n' +
        'development database. Set TEST_DATABASE_URL (and TEST_DIRECT_DATABASE_URL) in CI.\n',
    )
    throw new Error(
      'TEST_DATABASE_URL is required in CI. See tests/setup.ts for the policy.',
    )
  }
  console.error(
    '\n[FATAL tests/setup.ts] No PostgreSQL test database URL could be resolved.\n' +
      'Set TEST_DATABASE_URL (preferred, dedicated test DB) or ensure .env contains DATABASE_URL.\n' +
      `Shell DATABASE_URL was: ${process.env.DATABASE_URL ?? '(unset)'}\n`,
  )
  throw new Error(
    'Test database URL is not configured. See tests/setup.ts for the required PostgreSQL configuration.',
  )
}

if (!isPostgresUrl(testUrl)) {
  console.error(
    '\n[FATAL tests/setup.ts] Resolved test database URL is NOT PostgreSQL.\n' +
      `Resolved: ${redact(testUrl)}\n` +
      `Shell DATABASE_URL was: ${process.env.DATABASE_URL ?? '(unset)'}\n` +
      'The Contractor OS requires Neon PostgreSQL (INVARIANT 10). A SQLite shell\n' +
      'override must NOT be allowed to silently win. Set TEST_DATABASE_URL or fix .env.\n',
  )
  throw new Error(
    `Test database URL must be PostgreSQL (postgresql://). Got: ${redact(testUrl)}`,
  )
}

// Overwrite process.env so that `@/lib/db` (and any direct PrismaClient) see
// the postgres URL regardless of what the shell exported.
process.env.DATABASE_URL = testUrl
process.env.DIRECT_DATABASE_URL = testDirectUrl

// Visible confirmation on every test run — proves which DB + policy applied.
const sourceLabel = explicitTestUrl
  ? isCI
    ? 'TEST_DATABASE_URL (CI — dedicated test DB, mandatory)'
    : 'TEST_DATABASE_URL (local — dedicated test DB)'
  : '.env DATABASE_URL (local-dev fallback)'
console.log(
  `[tests/setup] PostgreSQL test database established: ${redact(testUrl)}` +
    `  (source: ${sourceLabel})`,
)
