import type { Env } from '../env'

export interface LinearConfig {
  apiKey: string         // personal API key (lin_api_...) or OAuth access token
  teamId: string         // Linear team UUID we'll file issues under
  teamKey?: string       // display-only, e.g., "ENG"
  createdAt: number
}

const TTL_SECONDS = 365 * 24 * 60 * 60

function key(email: string, host: string): string {
  return `linear-config:${email}:${host}`
}

function indexKey(email: string): string {
  return `linear-configs-by-email:${email}`
}

export async function setLinearConfig(env: Env, email: string, host: string, cfg: Omit<LinearConfig, 'createdAt'>): Promise<LinearConfig> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  const rec: LinearConfig = { ...cfg, createdAt: Date.now() }
  await env.SESSIONS.put(key(email, host), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  const list = await listLinearHosts(env, email)
  if (!list.includes(host)) {
    list.unshift(host)
    await env.SESSIONS.put(indexKey(email), JSON.stringify(list), { expirationTtl: TTL_SECONDS })
  }
  return rec
}

export async function getLinearConfig(env: Env, email: string, host: string): Promise<LinearConfig | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(key(email, host), 'json')) as LinearConfig | null
}

export async function deleteLinearConfig(env: Env, email: string, host: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const had = (await env.SESSIONS.get(key(email, host))) !== null
  if (!had) return false
  await env.SESSIONS.delete(key(email, host))
  const list = await listLinearHosts(env, email)
  await env.SESSIONS.put(indexKey(email), JSON.stringify(list.filter((h) => h !== host)), { expirationTtl: TTL_SECONDS })
  return true
}

export async function listLinearHosts(env: Env, email: string): Promise<string[]> {
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
