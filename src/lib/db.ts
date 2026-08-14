import { PrismaClient } from '@prisma/client'

/**
 * Validate the database environment at startup.
 *
 * Neon PostgreSQL is the canonical persistence layer (INVARIANT 10).
 * We do NOT silently rewrite environment variables — if the configuration is
 * wrong, we fail loudly so the operator can fix it.
 */
function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'FATAL: DATABASE_URL is not set. Neon PostgreSQL (postgresql://) is the canonical database.',
    )
  }
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    throw new Error(
      `FATAL: DATABASE_URL must be a PostgreSQL connection string (postgresql:// or postgres://). ` +
        `Got: ${url.substring(0, 40)}... Neon PostgreSQL is the canonical database. ` +
        `Do not mutate the database URL in application code.`,
    )
  }
  return url
}

// Validate immediately on module load — fail fast in dev, log in production.
try {
  getDatabaseUrl()
} catch (e) {
  if (process.env.NODE_ENV !== 'production') {
    console.error(e instanceof Error ? e.message : String(e))
  } else {
    throw e
  }
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
