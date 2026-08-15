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
  prismaTx: PrismaClient | undefined
}

/**
 * Main Prisma client — uses the pooled connection (DATABASE_URL).
 * Good for regular queries. Does NOT support interactive transactions ($transaction with callback)
 * when using PgBouncer in transaction mode.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

/**
 * Transaction Prisma client — uses the DIRECT connection (DIRECT_DATABASE_URL).
 * Required for interactive transactions ($transaction with callback) which
 * don't work through PgBouncer's transaction-mode pooler.
 * Falls back to the main client if DIRECT_DATABASE_URL is not set.
 */
export const dbTx =
  globalForPrisma.prismaTx ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
  globalForPrisma.prismaTx = dbTx
}
