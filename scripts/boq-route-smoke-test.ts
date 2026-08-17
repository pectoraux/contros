// Authenticated HTTP smoke test for the BOQ XLSX export route.
//
// Uses the SEEDED demo user (kwesi@adomconstruction.gh / demo1234) and the
// SEEDED finalized revision (rev-office-1) — NOT invented test data. This
// tests the real NextAuth credentials flow → real route → real service → real
// XLSX bytes, end-to-end.
//
// Run: TEST_DATABASE_URL=postgresql://... bun run scripts/boq-route-smoke-test.ts
//
// T1: does NOT read .env directly. Requires an externally supplied
// TEST_DATABASE_URL (or DATABASE_URL) environment variable. Fails closed if
// absent. This follows the secret-hygiene rule: test infrastructure should not
// depend on reading a developer's secret file from the repository.

const NEON_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
if (!NEON_URL || !NEON_URL.startsWith('postgresql://')) {
  console.error(
    'FATAL: TEST_DATABASE_URL (or DATABASE_URL) must be a postgresql:// URL.\n' +
    'Set it in the environment before running this script. Do NOT read .env.\n' +
    'Example: TEST_DATABASE_URL=postgresql://... bun run scripts/boq-route-smoke-test.ts',
  )
  process.exit(1)
}
// Force the Neon URL past the shell's SQLite DATABASE_URL override.
process.env.DATABASE_URL = NEON_URL
process.env.DIRECT_DATABASE_URL = process.env.DIRECT_DATABASE_URL || NEON_URL

const SEED_REVISION_ID = 'rev-office-1'
const DEMO_EMAIL = 'kwesi@adomconstruction.gh'
const DEMO_PASSWORD = 'demo1234'
const BASE = 'http://localhost:3000'

let passed = 0
let failed = 0
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name}: ${detail}`); failed++ }
}

async function main() {
  console.log('=== BOQ XLSX Authenticated HTTP Smoke Test ===')
  console.log(`Using seeded revision: ${SEED_REVISION_ID}`)
  console.log(`Demo user: ${DEMO_EMAIL}\n`)

  // Start the dev server with the Neon URL.
  const { spawn } = await import('node:child_process')
  const server = spawn('bun', ['run', 'dev'], {
    env: { ...process.env, DATABASE_URL: NEON_URL, DIRECT_DATABASE_URL: NEON_URL },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', () => {}) // suppress
  server.stderr?.on('data', () => {}) // suppress

  // Wait for server ready.
  console.log('Waiting for dev server...')
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/session`)
      if (r.ok) { ready = true; break }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!ready) { console.log('❌ Server did not start'); server.kill(); process.exit(1) }
  console.log('Server ready.\n')

  // Authenticate via NextAuth credentials provider.
  console.log('Authenticating as demo user...')
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfToken = (await csrfRes.json() as { csrfToken: string }).csrfToken
  const csrfCookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0]

  const signInRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })

  // Extract the session cookie from the Set-Cookie header.
  const setCookie = signInRes.headers.get('set-cookie') ?? ''
  const sessionCookie = setCookie
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('session') || c.includes('next-auth'))
    .join('; ')

  if (!sessionCookie) {
    console.log('❌ Authentication failed — no session cookie returned')
    console.log(`   Sign-in response status: ${signInRes.status}`)
    server.kill()
    process.exit(1)
  }
  console.log('Authenticated.\n')

  // ── Test 1: 200 finalized revision (golden path) ──────────────────────────
  console.log('--- 200 finalized revision (golden path) ---')
  const res = await fetch(`${BASE}/api/estimates/revisions/${SEED_REVISION_ID}/boq.xlsx`, {
    headers: { cookie: sessionCookie },
  })
  assert('status is 200', res.status === 200, `got ${res.status}`)

  const contentType = res.headers.get('content-type') ?? ''
  assert(
    'Content-Type is XLSX',
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    `got ${contentType}`,
  )

  const disposition = res.headers.get('content-disposition') ?? ''
  assert('Content-Disposition is attachment', disposition.includes('attachment'), `got ${disposition}`)
  assert('Content-Disposition has BOQ filename', disposition.includes('BOQ-'), `got ${disposition}`)
  assert('Content-Disposition has revision ID', disposition.includes(SEED_REVISION_ID), `got ${disposition}`)

  const body = Buffer.from(await res.arrayBuffer())
  assert('body is non-empty', body.length > 0, `${body.length} bytes`)
  assert('body starts with ZIP magic (PK)', body[0] === 0x50 && body[1] === 0x4b, `got ${body[0]},${body[1]}`)

  // The audit should succeed (no warning header on the golden path).
  const auditWarning = res.headers.get('x-genoffice-audit-warning')
  assert('no audit warning header (audit succeeded)', auditWarning === null, `got "${auditWarning}"`)

  // ── Test 2: 401 unauthenticated ───────────────────────────────────────────
  console.log('\n--- 401 unauthenticated ---')
  const res401 = await fetch(`${BASE}/api/estimates/revisions/${SEED_REVISION_ID}/boq.xlsx`)
  assert('status is 401', res401.status === 401, `got ${res401.status}`)

  // ── Test 3: 404 nonexistent revision ──────────────────────────────────────
  console.log('\n--- 404 nonexistent revision ---')
  const res404 = await fetch(`${BASE}/api/estimates/revisions/nonexistent-revision/boq.xlsx`, {
    headers: { cookie: sessionCookie },
  })
  assert('status is 404', res404.status === 404, `got ${res404.status}`)
  const body404 = await res404.json() as { error: string }
  assert('error is safe (no DB details)', !body404.error.includes('neon') && !body404.error.includes('password'), body404.error)

  // ── Test 4: 422 non-finalized revision ────────────────────────────────────
  console.log('\n--- 422 non-finalized revision ---')
  // Create a draft revision on the seeded estimate.
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  const draftRev = await db.estimateRevision.create({
    data: { estimateId: 'est-office', revisionNo: 99998, snapshotJson: '{}', status: 'draft', finalizedById: 'user-kwesi' },
  })
  const res422 = await fetch(`${BASE}/api/estimates/revisions/${draftRev.id}/boq.xlsx`, {
    headers: { cookie: sessionCookie },
  })
  assert('status is 422', res422.status === 422, `got ${res422.status}`)
  const body422 = await res422.json() as { error: string }
  assert('error mentions not finalized', body422.error.includes('not finalized'), body422.error)
  await db.estimateRevision.delete({ where: { id: draftRev.id } })
  await db.$disconnect()

  // ── Test 5: Determinism — same revision → same Content-Disposition ────────
  console.log('\n--- Determinism ---')
  const resDet = await fetch(`${BASE}/api/estimates/revisions/${SEED_REVISION_ID}/boq.xlsx`, {
    headers: { cookie: sessionCookie },
  })
  const detDisposition = resDet.headers.get('content-disposition') ?? ''
  assert('same Content-Disposition on repeat', detDisposition === disposition, `${detDisposition} vs ${disposition}`)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  server.kill()
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Smoke test failed:', e)
  process.exit(1)
})
