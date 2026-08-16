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
// BEFORE any test module imports `@/lib/db`. It explicitly establishes the
// PostgreSQL test database URL with a strict, auditable precedence:
//
//   1. TEST_DATABASE_URL        — explicit, dedicated test DB (CI / Neon branch)
//   2. .env DATABASE_URL        — parsed directly from the .env FILE, NOT the
//                                 shell, so an inherited SQLite value can never
//                                 win.
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

// Resolve the test database URL with strict precedence.
const testUrl =
  process.env.TEST_DATABASE_URL || dotenv.DATABASE_URL || undefined

const testDirectUrl =
  process.env.TEST_DIRECT_DATABASE_URL ||
  dotenv.DIRECT_DATABASE_URL ||
  testUrl ||
  undefined

if (!testUrl) {
  // Fail loudly — never silently run against nothing or against a SQLite shell value.
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

// Visible confirmation on every test run — proves which DB the suite used.
console.log(
  `[tests/setup] PostgreSQL test database established: ${redact(testUrl)}` +
    (process.env.TEST_DATABASE_URL
      ? '  (source: TEST_DATABASE_URL — dedicated test DB)'
      : '  (source: .env DATABASE_URL)'),
)
