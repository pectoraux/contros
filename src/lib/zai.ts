import ZAI from 'z-ai-web-dev-sdk'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let initialized = false
let zaiPromise: Promise<unknown> | null = null

/**
 * Initialize the z-ai-web-dev-sdk.
 *
 * The SDK searches for a `.z-ai-config` JSON file in:
 *   1. current project dir (process.cwd())
 *   2. user home dir (homedir())
 *   3. /etc/.z-ai-config
 *
 * On Vercel the filesystem is read-only except /tmp. So we:
 *   - Write the config to /tmp/.z-ai-config (writable)
 *   - Set HOME=/tmp so the SDK's homedir() check finds it
 *   - Also write to process.cwd() and /etc when possible (sandbox)
 */
export async function getZAI() {
  if (!initialized) {
    initialized = true

    // If env vars are present, ensure a config file exists for the SDK.
    if (process.env.ZAI_BASE_URL && process.env.ZAI_API_KEY) {
      const config = {
        baseUrl: process.env.ZAI_BASE_URL,
        apiKey: process.env.ZAI_API_KEY,
        chatId: process.env.ZAI_CHAT_ID || '',
        token: process.env.ZAI_TOKEN || '',
        userId: process.env.ZAI_USER_ID || '',
      }
      const configStr = JSON.stringify(config)

      // /tmp is writable on Vercel serverless functions.
      const tmpTargets = [
        '/tmp/.z-ai-config',
        join('/tmp', '.z-ai-config'),
      ]
      // Point HOME at /tmp so the SDK's homedir() resolves to /tmp.
      if (!process.env.HOME || process.env.HOME === '/home') {
        process.env.HOME = '/tmp'
      }
      // Also set USERPROFILE for Windows-style fallbacks (harmless on Linux).
      process.env.USERPROFILE = '/tmp'

      const allTargets = [
        ...tmpTargets,
        join(process.cwd(), '.z-ai-config'),
        join(homedir(), '.z-ai-config'),
        '/etc/.z-ai-config',
      ]

      for (const target of allTargets) {
        try {
          if (!existsSync(target)) {
            // Ensure parent dir exists.
            const dir = target.replace(/\/[^/]+$/, '')
            if (!existsSync(dir)) {
              try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
            }
            writeFileSync(target, configStr, { mode: 0o644 })
          } else {
            // Overwrite with env-provided config (env vars are authoritative).
            writeFileSync(target, configStr, { mode: 0o644 })
          }
        } catch {
          // target not writable — skip (e.g. /etc on Vercel)
        }
      }
    }
  }

  if (!zaiPromise) {
    zaiPromise = ZAI.create()
  }
  return zaiPromise
}
