import type { Env } from '../env'

export interface SlackConfig {
  // Slack incoming webhook URL (https://hooks.slack.com/services/...).
  // We never see the workspace identity beyond the URL itself.
  webhookUrl: string
  // Which event types should ping this channel. All booleans for now.
  notifyOnRegression: boolean
  notifyOnFirstCapture: boolean
  createdAt: number
}

const TTL_SECONDS = 365 * 24 * 60 * 60

function key(email: string, host: string): string {
  return `slack-config:${email}:${host}`
}
function indexKey(email: string): string {
  return `slack-configs-by-email:${email}`
}

export async function setSlackConfig(env: Env, email: string, host: string, cfg: Omit<SlackConfig, 'createdAt'>): Promise<SlackConfig> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  const rec: SlackConfig = { ...cfg, createdAt: Date.now() }
  await env.SESSIONS.put(key(email, host), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  const list = await listSlackHosts(env, email)
  if (!list.includes(host)) {
    list.unshift(host)
    await env.SESSIONS.put(indexKey(email), JSON.stringify(list), { expirationTtl: TTL_SECONDS })
  }
  return rec
}

export async function getSlackConfig(env: Env, email: string, host: string): Promise<SlackConfig | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(key(email, host), 'json')) as SlackConfig | null
}

export async function deleteSlackConfig(env: Env, email: string, host: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const had = (await env.SESSIONS.get(key(email, host))) !== null
  if (!had) return false
  await env.SESSIONS.delete(key(email, host))
  const list = await listSlackHosts(env, email)
  await env.SESSIONS.put(indexKey(email), JSON.stringify(list.filter((h) => h !== host)), { expirationTtl: TTL_SECONDS })
  return true
}

export async function listSlackHosts(env: Env, email: string): Promise<string[]> {
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
