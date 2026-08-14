import { PrismaClient } from '@prisma/client'

// Ensure the Neon URL is used even when the shell exports a stale SQLite DATABASE_URL.
// (Happens in the sandbox; on Vercel the env is set correctly via the dashboard.)
if (
  process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.startsWith('postgresql://') &&
  process.env.DIRECT_DATABASE_URL
) {
  process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
