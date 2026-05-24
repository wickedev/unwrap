import type { Env } from '../env'

export interface ShareRecord {
  token: string
  email: string
  host: string
  createdAt: number
}

const TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days

function shareKey(token: string): string {
  return `share:${token}`
}

function shareByHostKey(email: string, host: string): string {
  return `share-by-host:${email}:${host}`
}

function newShareToken(): string {
  // 24 chars, base36, ~120 bits of entropy. Long enough to be effectively
  // unguessable on a per-project basis; short enough to fit a URL nicely.
  const rand = crypto.getRandomValues(new Uint8Array(15))
  return Array.from(rand)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 24)
}

// Mints a share token for (email, host). Idempotent — if one already
// exists we return that token so the URL the user already shared keeps
// working.
export async function getOrCreateShareToken(env: Env, email: string, host: string): Promise<ShareRecord> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV namespace not configured')
  const existing = await env.SESSIONS.get(shareByHostKey(email, host))
  if (existing) {
    const rec = (await env.SESSIONS.get(shareKey(existing), 'json')) as ShareRecord | null
    if (rec) return rec
  }
  const token = newShareToken()
  const rec: ShareRecord = { token, email, host, createdAt: Date.now() }
  await env.SESSIONS.put(shareKey(token), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  await env.SESSIONS.put(shareByHostKey(email, host), token, { expirationTtl: TTL_SECONDS })
  return rec
}

// Resolves a share token to the owning (email, host) pair. Anonymous
// caller — no auth check.
export async function resolveShareToken(env: Env, token: string): Promise<ShareRecord | null> {
  if (!env.SESSIONS) return null
  const rec = (await env.SESSIONS.get(shareKey(token), 'json')) as ShareRecord | null
  return rec
}

// Revokes a project's share link. Deletes both directions.
export async function revokeShareToken(env: Env, email: string, host: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const token = await env.SESSIONS.get(shareByHostKey(email, host))
  if (!token) return false
  await env.SESSIONS.delete(shareKey(token))
  await env.SESSIONS.delete(shareByHostKey(email, host))
  return true
}

// Reads the current token (without minting one) so the project page can
// surface "shared" state without committing to a token until the user
// asks for one.
export async function readShareToken(env: Env, email: string, host: string): Promise<string | null> {
  if (!env.SESSIONS) return null
  return env.SESSIONS.get(shareByHostKey(email, host))
}
