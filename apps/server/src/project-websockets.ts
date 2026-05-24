import type { StoredSession, WsMessageType } from '@unwrap/protocol'

export interface ProjectWsChannel {
  url: string
  // host:path or just host, used as the dedupe key (channels with the
  // same logical endpoint but different session-instance ids merge).
  endpoint: string
  // Across all sessions.
  totalSendCount: number
  totalRecvCount: number
  totalSendBytes: number
  totalRecvBytes: number
  sessionCount: number
  // Merged message types — same key across sessions counts cumulatively.
  messageTypes: WsMessageType[]
}

// Aggregates per-session WS channels into a project-wide view. Channels
// are merged by the (host, pathname) tuple so the same realtime endpoint
// captured in multiple sessions appears once with cumulative stats.
export function aggregateWsChannels(sessions: StoredSession[]): ProjectWsChannel[] {
  const map = new Map<string, ProjectWsChannel>()
  const sessionsByEndpoint = new Map<string, Set<string>>()

  for (const s of sessions) {
    for (const ch of s.summary.wsChannels ?? []) {
      const endpoint = endpointFor(ch.url)
      let entry = map.get(endpoint)
      if (!entry) {
        entry = {
          url: ch.url,
          endpoint,
          totalSendCount: 0,
          totalRecvCount: 0,
          totalSendBytes: 0,
          totalRecvBytes: 0,
          sessionCount: 0,
          messageTypes: [],
        }
        map.set(endpoint, entry)
      }
      entry.totalSendCount += ch.sendCount
      entry.totalRecvCount += ch.recvCount
      entry.totalSendBytes += ch.sendBytes
      entry.totalRecvBytes += ch.recvBytes
      const seen = sessionsByEndpoint.get(endpoint) ?? new Set<string>()
      seen.add(s.id)
      sessionsByEndpoint.set(endpoint, seen)
      mergeMessageTypes(entry, ch.messageTypes)
    }
  }

  for (const [endpoint, entry] of map) {
    entry.sessionCount = sessionsByEndpoint.get(endpoint)?.size ?? 1
    entry.messageTypes.sort((a, b) => b.count - a.count)
  }

  return [...map.values()].sort((a, b) => (b.totalRecvCount + b.totalSendCount) - (a.totalRecvCount + a.totalSendCount))
}

function endpointFor(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url
  }
}

function mergeMessageTypes(entry: ProjectWsChannel, types: WsMessageType[]) {
  const byKey = new Map(entry.messageTypes.map((t) => [t.key, t]))
  for (const t of types) {
    const existing = byKey.get(t.key)
    if (!existing) {
      byKey.set(t.key, { ...t })
    } else {
      existing.count += t.count
      existing.bytes += t.bytes
      if (existing.direction !== t.direction) existing.direction = 'both'
      // Prefer the existing sample/shape; fall back to incoming when missing.
      if (!existing.sample && t.sample) existing.sample = t.sample
      if (!existing.inferredShape && t.inferredShape) existing.inferredShape = t.inferredShape
    }
  }
  entry.messageTypes = [...byKey.values()]
}
