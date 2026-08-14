import ZAI from 'z-ai-web-dev-sdk'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let initialized = false

/**
 * Initialize the z-ai-web-dev-sdk.
 *
 * The SDK searches for a `.z-ai-config` JSON file in:
 *   1. current project dir
 *   2. user home dir
 *   3. /etc/.z-ai-config
 *
 * On Vercel there is no such file, so we fall back to environment variables
 * (ZAI_BASE_URL, ZAI_API_KEY, ZAI_CHAT_ID, ZAI_TOKEN, ZAI_USER_ID) and write
 * a temporary config file that the SDK can read.
 */
export async function getZAI() {
  if (!initialized) {
    // If env vars are present, ensure a config file exists for the SDK.
    if (process.env.ZAI_BASE_URL && process.env.ZAI_API_KEY) {
      const config = {
        baseUrl: process.env.ZAI_BASE_URL,
        apiKey: process.env.ZAI_API_KEY,
        chatId: process.env.ZAI_CHAT_ID || '',
        token: process.env.ZAI_TOKEN || '',
        userId: process.env.ZAI_USER_ID || '',
      }
      // Write to home dir (writable on Vercel) and /etc (sandbox).
      const targets = [join(process.cwd(), '.z-ai-config'), join(homedir(), '.z-ai-config')]
      for (const target of targets) {
        try {
          writeFileSync(target, JSON.stringify(config), { mode: 0o644 })
        } catch {
          // ignore — may be read-only on Vercel
        }
      }
      // Also try /etc for the sandbox (may fail on Vercel — that's fine).
      try {
        if (!existsSync('/etc/.z-ai-config')) {
          mkdirSync('/etc', { recursive: true })
          writeFileSync('/etc/.z-ai-config', JSON.stringify(config), { mode: 0o644 })
        }
      } catch {
        // ignore
      }
    }
    initialized = true
  }
  return ZAI.create()
}
