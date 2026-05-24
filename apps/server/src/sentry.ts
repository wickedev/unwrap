import type { StoredSession } from '@unwrap/protocol'
import type { SentryConfig } from './storage/sentry-config'

// Subset of Sentry's issue/event shapes we read.
export interface SentryIssue {
  id: string
  shortId: string
  title: string
  // The message/value of the underlying exception or log, when present.
  culprit?: string
  permalink: string
  // ISO timestamp of the most recent event.
  lastSeen: string
  count: string // Sentry returns event count as a string
  userCount: number
  level: string
  // The fingerprint-y bits we use for matching against our captured
  // console errors: title + metadata.value.
  metadata?: { value?: string; type?: string; filename?: string }
}

export interface SentryCorrelation {
  issue: SentryIssue
  // Sessions where a console error matched this issue's signature.
  matchedSessions: { sessionId: string; matchedMessage: string }[]
}

export async function fetchRecentSentryIssues(cfg: SentryConfig, limit = 50): Promise<SentryIssue[]> {
  const base = (cfg.baseUrl ?? 'https://sentry.io').replace(/\/+$/, '')
  // Use the issues endpoint with project filter. statsPeriod=14d keeps
  // it bounded.
  const url = `${base}/api/0/organizations/${encodeURIComponent(cfg.org)}/issues/?project=${encodeURIComponent(cfg.project)}&statsPeriod=14d&limit=${limit}&sort=date`
  const resp = await fetch(url, {
    headers: {
      authorization: `Bearer ${cfg.apiToken}`,
      accept: 'application/json',
      'user-agent': 'unwrap-server',
    },
  })
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200)
    throw new Error(`Sentry API ${resp.status}: ${detail}`)
  }
  const data = (await resp.json()) as SentryIssue[]
  return Array.isArray(data) ? data : []
}

// Match Sentry issues against our captured console errors and exceptions.
// Matching strategy: normalize both sides (strip URLs, line/column numbers,
// numeric ids), require the first ~80 chars of the normalized strings to
// match. Conservative — bias toward false-negatives over false-positives.
export function correlateSentryIssuesWithSessions(
  issues: SentryIssue[],
  sessions: StoredSession[],
): SentryCorrelation[] {
  const out: SentryCorrelation[] = []
  for (const issue of issues) {
    const candidates = [issue.title, issue.metadata?.value, issue.culprit]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map(normalize)
    if (candidates.length === 0) continue

    const matchedSessions: SentryCorrelation['matchedSessions'] = []
    for (const s of sessions) {
      for (const msg of [...(s.summary.consoleErrors ?? []), ...(s.summary.exceptions ?? [])]) {
        const text = 'message' in msg ? msg.message : ''
        if (!text) continue
        const normalizedMsg = normalize(text)
        if (candidates.some((c) => candidatesMatch(c, normalizedMsg))) {
          matchedSessions.push({ sessionId: s.id, matchedMessage: text.slice(0, 240) })
          break // one match per session is enough
        }
      }
    }
    if (matchedSessions.length > 0) {
      out.push({ issue, matchedSessions })
    } else {
      // Still include unmatched issues — the page distinguishes between
      // "we have a session that produced this" and "Sentry has it but we
      // don't" so users can see where capture coverage falls short.
      out.push({ issue, matchedSessions: [] })
    }
  }
  // Matched first, then by Sentry event count desc.
  out.sort((a, b) => {
    const am = a.matchedSessions.length > 0 ? 0 : 1
    const bm = b.matchedSessions.length > 0 ? 0 : 1
    if (am !== bm) return am - bm
    return Number(b.issue.count) - Number(a.issue.count)
  })
  return out
}

function normalize(s: string): string {
  return s
    .replace(/https?:\/\/[^\s'"`]+/g, '')      // URLs
    .replace(/\b[0-9a-f]{8,}\b/gi, '')          // hex blobs / ids
    .replace(/\b\d+\b/g, '')                    // line numbers, counts
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function candidatesMatch(a: string, b: string): boolean {
  if (a.length < 12 || b.length < 12) return false
  const aHead = a.slice(0, 80)
  const bHead = b.slice(0, 80)
  return aHead === bHead || (aHead.length >= 30 && (a.includes(bHead) || b.includes(aHead)))
}
