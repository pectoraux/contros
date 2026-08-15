import { NextResponse } from 'next/server'
import { BUILD_COMMIT_SHA, BUILD_BRANCH, BUILD_TIME } from '@/lib/generated/version'

/**
 * /api/version — release integrity endpoint.
 *
 * Returns the exact Git commit SHA the running deployment was built from.
 * This allows mechanical verification that:
 *
 *   GitHub main SHA  ===  Vercel deployment SHA  ===  /api/version SHA
 *
 * The SHA is baked into the build at compile time via scripts/generate-version.ts
 * (which reads VERCEL_GIT_COMMIT_SHA or falls back to `git rev-parse HEAD`).
 *
 * This endpoint is intentionally public (no auth) — it exposes only the
 * commit SHA, build time, and environment, never secrets or domain data.
 */

export async function GET() {
  const sha = BUILD_COMMIT_SHA
  return NextResponse.json({
    commitSha: sha,
    commitShaShort: sha.length >= 7 ? sha.substring(0, 7) : sha,
    buildTime: BUILD_TIME,
    deploymentUrl: process.env.VERCEL_URL || process.env.NEXT_PUBLIC_APP_URL || 'unknown',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    branch: BUILD_BRANCH,
    repo: 'pectoraux/contros',
    githubUrl: sha !== 'unknown' ? `https://github.com/pectoraux/contros/commit/${sha}` : 'https://github.com/pectoraux/contros',
  })
}
