import type { Env } from '../env'

export interface SentryConfig {
  // Sentry API auth token (Internal Integration or User Auth Token).
  apiToken: string
  // Sentry org slug — used in /api/0/organizations/:org/issues/.
  org: string
  // Sentry project slug — used in the issue query filter.
  project: string
  // Optional self-hosted Sentry base URL. Defaults to sentry.io.
  baseUrl?: string
  createdAt: number
}

// Stored per (Unwrap user, host). Different projects can point at
// different Sentry projects, even if it's the same Sentry org.
function key(email: string, host: string): string {
  return `sentry-config:${email}:${host}`
}

function indexKey(email: string): string {
  return `sentry-configs-by-email:${email}`
}

const TTL_SECONDS = 365 * 24 * 60 * 60

export async function setSentryConfig(env: Env, email: string, host: string, cfg: Omit<SentryConfig, 'createdAt'>): Promise<SentryConfig> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  const rec: SentryConfig = { ...cfg, createdAt: Date.now() }
  await env.SESSIONS.put(key(email, host), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  const list = await listSentryHosts(env, email)
  if (!list.includes(host)) {
    list.unshift(host)
    await env.SESSIONS.put(indexKey(email), JSON.stringify(list), { expirationTtl: TTL_SECONDS })
  }
  return rec
}

export async function getSentryConfig(env: Env, email: string, host: string): Promise<SentryConfig | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(key(email, host), 'json')) as SentryConfig | null
}

export async function deleteSentryConfig(env: Env, email: string, host: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const had = (await env.SESSIONS.get(key(email, host))) !== null
  if (!had) return false
  await env.SESSIONS.delete(key(email, host))
  const list = await listSentryHosts(env, email)
  const next = list.filter((h) => h !== host)
  await env.SESSIONS.put(indexKey(email), JSON.stringify(next), { expirationTtl: TTL_SECONDS })
  return true
}

export async function listSentryHosts(env: Env, email: string): Promise<string[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(indexKey(email))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as string[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
