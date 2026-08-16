import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

const env: Record<string,string> = {}
for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq === -1) continue
  env[t.slice(0,eq).trim()] = t.slice(eq+1).trim().replace(/^["']|["']$/g,'')
}
process.env.DATABASE_URL = env.DATABASE_URL

const db = new PrismaClient()
async function main() {
  const orgs = await db.organization.findMany({ where: { id: { startsWith: 'test-' } }, select: { id: true, name: true } })
  console.log('Test orgs:', orgs.length, JSON.stringify(orgs.slice(0,5)))
  const lines = await db.estimateLine.findMany({ where: { id: { startsWith: 'test-' } }, select: { id: true } })
  console.log('Test estimate lines:', lines.length)
  const segs = await db.executionSegment.findMany({ where: { id: { startsWith: 'test-' } }, select: { id: true } })
  console.log('Test execution segments:', segs.length)
  const quotes = await db.subcontractQuote.findMany({ where: { id: { startsWith: 'test-' } }, select: { id: true } })
  console.log('Test subcontract quotes:', quotes.length)
  await db.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
