import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

describe('Smoke test', () => {
  beforeAll(async () => {
    // Quick DB check.
    const count = await db.organization.count()
    console.log('Org count:', count)
  }, 30000)

  afterAll(async () => {
    await db.$disconnect()
  }, 30000)

  test('can count organizations', async () => {
    const count = await db.organization.count()
    expect(typeof count).toBe('number')
  }, 30000)
})
