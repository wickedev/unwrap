import type { Env } from '../env'

export interface CanonicalTestRecord {
  sessionId: string
  // Slug used as the .spec.ts filename in the bundle.
  name: string
  // Optional free-text tags ("smoke", "auth", "checkout") for grouping.
  tags: string[]
  addedAt: number
}

const TTL_SECONDS = 365 * 24 * 60 * 60

function key(email: string, host: string): string {
  return `canonical-tests:${email}:${host}`
}

export async function listCanonicalTests(env: Env, email: string, host: string): Promise<CanonicalTestRecord[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(key(email, host))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as CanonicalTestRecord[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// Adds or replaces a canonical test entry for a session. The same session
// can be re-added with an updated name/tags — re-adds replace the prior
// entry in place rather than duplicating.
export async function addCanonicalTest(
  env: Env,
  email: string,
  host: string,
  rec: Omit<CanonicalTestRecord, 'addedAt'>,
): Promise<CanonicalTestRecord> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  const list = await listCanonicalTests(env, email, host)
  const next = list.filter((r) => r.sessionId !== rec.sessionId)
  const full: CanonicalTestRecord = { ...rec, addedAt: Date.now() }
  next.unshift(full)
  await env.SESSIONS.put(key(email, host), JSON.stringify(next), { expirationTtl: TTL_SECONDS })
  return full
}

export async function removeCanonicalTest(env: Env, email: string, host: string, sessionId: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const list = await listCanonicalTests(env, email, host)
  const next = list.filter((r) => r.sessionId !== sessionId)
  if (next.length === list.length) return false
  await env.SESSIONS.put(key(email, host), JSON.stringify(next), { expirationTtl: TTL_SECONDS })
  return true
}

// Convenience: is this session marked canonical for its host?
export async function isCanonical(env: Env, email: string, host: string, sessionId: string): Promise<boolean> {
  const list = await listCanonicalTests(env, email, host)
  return list.some((r) => r.sessionId === sessionId)
}

// Sanitize a free-text label into a safe spec filename slug.
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return s || 'test'
}
