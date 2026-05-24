import type { StoredSession } from '@unwrap/protocol'

export type SearchResultKind =
  | 'project'
  | 'route'
  | 'endpoint'
  | 'graphql'
  | 'ws-channel'
  | 'ws-message-type'
  | 'console-error'

export interface SearchResult {
  kind: SearchResultKind
  label: string
  context: string
  href: string
  // For ranking — exact substring hits beat fuzzy positions.
  score: number
  // Where the match landed inside `label` so the UI can highlight it.
  matchStart: number
  matchEnd: number
}

const MAX_RESULTS = 80

// Scans every session the user has for a free-text query, returning a
// ranked, deduped result list. Keeps the scan in-memory because it's
// cheap relative to the KV reads that already happened upstream — the
// route handler does the listSessions + per-session getSession; this
// just walks the loaded records.
export function searchSessions(query: string, sessions: StoredSession[]): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []

  // Bucket by kind so each kind dedupes itself, then rank globally.
  const projectsSeen = new Map<string, SearchResult>()
  const routesSeen = new Map<string, SearchResult>()
  const endpointsSeen = new Map<string, SearchResult>()
  const graphqlSeen = new Map<string, SearchResult>()
  const wsChannelsSeen = new Map<string, SearchResult>()
  const wsTypesSeen = new Map<string, SearchResult>()
  const consoleSeen = new Map<string, SearchResult>()

  for (const s of sessions) {
    const host = s.summary.meta.host
    if (host && projectMatch(host, q)) {
      projectsSeen.set(host, {
        kind: 'project',
        label: host,
        context: `${sessionCountStr(sessions, host)} captured`,
        href: `/projects/${encodeURIComponent(host)}`,
        ...rangeOf(host, q),
      })
    }

    for (const r of s.summary.navigations ?? []) {
      const m = matchSpan(r.url, q)
      if (!m) continue
      const key = `${host}|${r.url}`
      if (routesSeen.has(key)) continue
      routesSeen.set(key, {
        kind: 'route',
        label: r.url,
        context: `route on ${host || '(no host)'}`,
        href: `/projects/${encodeURIComponent(host || '')}`,
        score: m.score,
        matchStart: m.start,
        matchEnd: m.end,
      })
    }

    for (const c of s.summary.apiCalls ?? []) {
      // Match against the path portion only — full URLs are noisy.
      let path = c.url
      try { path = new URL(c.url).pathname } catch { /* keep raw */ }
      const m = matchSpan(`${c.method} ${path}`, q)
      if (!m) continue
      const key = `${host}|${c.method}|${path}`
      if (endpointsSeen.has(key)) continue
      const isGraphql = !!c.graphql
      const target = isGraphql ? `/projects/${encodeURIComponent(host || '')}` : `/projects/${encodeURIComponent(host || '')}`
      endpointsSeen.set(key, {
        kind: isGraphql ? 'graphql' : 'endpoint',
        label: `${c.method} ${path}`,
        context: isGraphql
          ? `GraphQL operation on ${host}`
          : `API endpoint on ${host}`,
        href: target,
        score: m.score,
        matchStart: m.start,
        matchEnd: m.end,
      })
    }

    // GraphQL operation names — independently of URL match.
    for (const c of s.summary.apiCalls ?? []) {
      const name = c.graphql?.operationName
      if (!name) continue
      const m = matchSpan(name, q)
      if (!m) continue
      const key = `${host}|gql|${name}`
      if (graphqlSeen.has(key)) continue
      graphqlSeen.set(key, {
        kind: 'graphql',
        label: name,
        context: `${c.graphql!.operationType ?? 'query'} on ${host}`,
        href: `/projects/${encodeURIComponent(host || '')}`,
        score: m.score,
        matchStart: m.start,
        matchEnd: m.end,
      })
    }

    for (const ch of s.summary.wsChannels ?? []) {
      const mu = matchSpan(ch.url, q)
      if (mu) {
        const key = `${host}|wsch|${ch.url}`
        if (!wsChannelsSeen.has(key)) {
          wsChannelsSeen.set(key, {
            kind: 'ws-channel',
            label: ch.url,
            context: `WebSocket channel on ${host}`,
            href: `/projects/${encodeURIComponent(host || '')}/websockets`,
            score: mu.score,
            matchStart: mu.start,
            matchEnd: mu.end,
          })
        }
      }
      for (const t of ch.messageTypes) {
        const m = matchSpan(t.key, q)
        if (!m) continue
        const tkey = `${host}|wstype|${ch.url}|${t.key}`
        if (wsTypesSeen.has(tkey)) continue
        wsTypesSeen.set(tkey, {
          kind: 'ws-message-type',
          label: t.key,
          context: `WS message · ${ch.url}`,
          href: `/projects/${encodeURIComponent(host || '')}/websockets`,
          score: m.score,
          matchStart: m.start,
          matchEnd: m.end,
        })
      }
    }

    for (const e of s.summary.consoleErrors ?? []) {
      const m = matchSpan(e.message, q)
      if (!m) continue
      // Dedupe by host + leading 80 chars so the same recurring error doesn't
      // dominate results.
      const key = `${host}|cerr|${e.message.slice(0, 80)}`
      if (consoleSeen.has(key)) continue
      consoleSeen.set(key, {
        kind: 'console-error',
        label: e.message.length > 120 ? e.message.slice(0, 120) + '…' : e.message,
        context: `console.error in ${host} session ${s.id.slice(0, 8)}`,
        href: `/sessions/${s.id}`,
        score: m.score,
        matchStart: m.start,
        matchEnd: m.end,
      })
    }
  }

  const all: SearchResult[] = [
    ...projectsSeen.values(),
    ...routesSeen.values(),
    ...endpointsSeen.values(),
    ...graphqlSeen.values(),
    ...wsChannelsSeen.values(),
    ...wsTypesSeen.values(),
    ...consoleSeen.values(),
  ]
  // Sort by score desc, then label asc for stability.
  all.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
  return all.slice(0, MAX_RESULTS)
}

function projectMatch(host: string, q: string): boolean {
  return host.toLowerCase().includes(q)
}

function sessionCountStr(sessions: StoredSession[], host: string): string {
  const n = sessions.filter((s) => s.summary.meta.host === host).length
  return `${n} session${n === 1 ? '' : 's'}`
}

interface Match { start: number; end: number; score: number }

// Substring match scored by position (earlier = better) and case match
// (exact case = small bump). Returns null when q is not in haystack.
function matchSpan(haystack: string, q: string): Match | null {
  const idx = haystack.toLowerCase().indexOf(q)
  if (idx < 0) return null
  // Score: base 100, minus 1 per character of leading offset, plus 5 if
  // case matched. Word-boundary hits get a bonus.
  let score = 100 - Math.min(idx, 80)
  if (haystack.slice(idx, idx + q.length) === q) score += 5
  const before = idx === 0 ? '' : haystack[idx - 1]
  if (!before || /[^A-Za-z0-9]/.test(before)) score += 8
  return { start: idx, end: idx + q.length, score }
}

function rangeOf(haystack: string, q: string) {
  const m = matchSpan(haystack, q)
  if (!m) return { score: 0, matchStart: 0, matchEnd: 0 }
  return { score: m.score, matchStart: m.start, matchEnd: m.end }
}
