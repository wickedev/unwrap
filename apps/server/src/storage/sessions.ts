import type { GenerateResponse, SessionListItem, StoredSession } from '@unwrap/protocol'
import type { Env } from '../env'

const TTL_SECONDS = 30 * 24 * 60 * 60

function sessionKey(email: string, id: string): string {
  return `session:${email}:${id}`
}

function indexKey(email: string): string {
  return `index:${email}`
}

export function newSessionId(): string {
  // Time-sortable 22-char id: 8 hex of seconds + 14 base32 of randomness.
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
  const rand = crypto.getRandomValues(new Uint8Array(9))
  const b32 = Array.from(rand)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 14)
  return `${seconds}${b32}`
}

export async function putSession(env: Env, record: StoredSession): Promise<void> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV namespace not configured')
  await env.SESSIONS.put(sessionKey(record.email, record.id), JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
    metadata: toListItem(record),
  })
  await appendIndex(env, record.email, record.id)
}

export async function getSession(env: Env, email: string, id: string): Promise<StoredSession | null> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV namespace not configured')
  const raw = await env.SESSIONS.get(sessionKey(email, id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

export async function deleteSession(env: Env, email: string, id: string): Promise<void> {
  if (!env.SESSIONS) return
  await env.SESSIONS.delete(sessionKey(email, id))
  await removeFromIndex(env, email, id)
}

export async function setGenerated(
  env: Env,
  email: string,
  id: string,
  generated: GenerateResponse,
): Promise<StoredSession | null> {
  const record = await getSession(env, email, id)
  if (!record) return null
  record.generated = { ...generated, generatedAt: Date.now() }
  await putSession(env, record)
  return record
}

export async function listSessions(env: Env, email: string): Promise<SessionListItem[]> {
  if (!env.SESSIONS) return []
  const ids = await loadIndex(env, email)
  if (ids.length === 0) return []

  // KV list lets us read metadata cheaply without fetching the values.
  const out: SessionListItem[] = []
  const prefix = `session:${email}:`
  let cursor: string | undefined
  const live = new Set<string>()
  do {
    const page = await env.SESSIONS.list<SessionListItem>({ prefix, cursor })
    for (const k of page.keys) {
      const id = k.name.slice(prefix.length)
      live.add(id)
      if (k.metadata) out.push(k.metadata as SessionListItem)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  // Heal index — drop entries that are no longer live (expired).
  const stale = ids.filter((id) => !live.has(id))
  if (stale.length) await rewriteIndex(env, email, ids.filter((id) => live.has(id)))

  return out.sort((a, b) => b.uploadedAt - a.uploadedAt)
}

async function appendIndex(env: Env, email: string, id: string): Promise<void> {
  if (!env.SESSIONS) return
  const existing = await loadIndex(env, email)
  if (existing.includes(id)) return
  const next = [id, ...existing].slice(0, 1000)
  await env.SESSIONS.put(indexKey(email), JSON.stringify(next))
}

async function rewriteIndex(env: Env, email: string, ids: string[]): Promise<void> {
  if (!env.SESSIONS) return
  await env.SESSIONS.put(indexKey(email), JSON.stringify(ids))
}

async function removeFromIndex(env: Env, email: string, id: string): Promise<void> {
  const existing = await loadIndex(env, email)
  await rewriteIndex(env, email, existing.filter((x) => x !== id))
}

async function loadIndex(env: Env, email: string): Promise<string[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(indexKey(email))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function toListItem(record: StoredSession): SessionListItem {
  return {
    id: record.id,
    host: record.summary.meta.host,
    startUrl: record.summary.meta.url,
    startedAt: record.summary.meta.startedAt,
    durationMs: record.summary.meta.durationMs,
    uploadedAt: record.uploadedAt,
    hasGeneratedSpec: !!record.generated?.spec,
  }
}
