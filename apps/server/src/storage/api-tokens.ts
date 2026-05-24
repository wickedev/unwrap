import type { Env } from '../env'

export interface ApiTokenRecord {
  token: string
  email: string
  createdAt: number
  // Free-text label users set when minting ("github-actions", "local-dev", ...)
  label: string
}

const TTL_SECONDS = 365 * 24 * 60 * 60 // one year

function tokenKey(token: string): string {
  return `apitoken:${token}`
}

function emailIndexKey(email: string): string {
  return `apitokens-by-email:${email}`
}

// Tokens look like `uw_ci_<24 base36 chars>` so they're visually distinct
// from JWTs and easy to spot in logs / accidentally-leaked configs.
function newApiToken(): string {
  const rand = crypto.getRandomValues(new Uint8Array(15))
  const body = Array.from(rand)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 24)
  return `uw_ci_${body}`
}

// Mints a fresh API token for an email. Each call returns a new token —
// users may keep multiple in rotation. The email index gets updated so
// the user can list/revoke them later.
export async function mintApiToken(env: Env, email: string, label: string): Promise<ApiTokenRecord> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV namespace not configured')
  const token = newApiToken()
  const rec: ApiTokenRecord = { token, email, createdAt: Date.now(), label: label.slice(0, 80) }
  await env.SESSIONS.put(tokenKey(token), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  const list = await listApiTokens(env, email)
  list.unshift(rec)
  await env.SESSIONS.put(emailIndexKey(email), JSON.stringify(list), { expirationTtl: TTL_SECONDS })
  return rec
}

// Lookup by token. Used by the auth middleware to authenticate Bearer
// tokens that don't parse as JWTs.
export async function resolveApiToken(env: Env, token: string): Promise<ApiTokenRecord | null> {
  if (!env.SESSIONS) return null
  if (!token.startsWith('uw_ci_')) return null
  const rec = (await env.SESSIONS.get(tokenKey(token), 'json')) as ApiTokenRecord | null
  return rec
}

export async function listApiTokens(env: Env, email: string): Promise<ApiTokenRecord[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(emailIndexKey(email))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as ApiTokenRecord[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function revokeApiToken(env: Env, email: string, token: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  await env.SESSIONS.delete(tokenKey(token))
  const list = await listApiTokens(env, email)
  const next = list.filter((t) => t.token !== token)
  if (next.length === list.length) return false
  await env.SESSIONS.put(emailIndexKey(email), JSON.stringify(next), { expirationTtl: TTL_SECONDS })
  return true
}
