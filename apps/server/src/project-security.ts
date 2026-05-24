import type { ApiCall, StoredSession } from '@unwrap/protocol'

export type FindingSeverity = 'info' | 'warn' | 'high'

export interface SecurityFinding {
  id: string
  severity: FindingSeverity
  title: string
  description: string
  // Concrete examples — URLs, header names, paths. Limited to a handful.
  evidence: string[]
}

export interface SecurityReport {
  host: string
  sessionCount: number
  // Counts so the page can render a summary strip.
  totals: {
    endpoints: number
    cookies: number
    authedEndpoints: number
    crossOriginRequests: number
  }
  // Detected auth schemes per endpoint, useful as a separate table.
  authMatrix: AuthMatrixRow[]
  findings: SecurityFinding[]
}

export interface AuthMatrixRow {
  method: string
  normalizedPath: string
  hostname: string
  // Most common auth scheme observed across calls; '(none)' when we never
  // saw an auth header for this endpoint.
  scheme: 'Bearer' | 'Cookie' | 'API key' | 'Basic' | '(none)' | 'Mixed'
  callCount: number
  // 401/403 hits — bigger numbers mean the endpoint actively enforces auth.
  unauthorizedHits: number
  forbiddenHits: number
}

// Heuristics for "this query param looks like a secret in the URL." Conservative
// list — too broad would cry wolf on innocuous `token=csrf` patterns.
const SECRET_PARAM_NAMES = new Set([
  'api_key', 'apikey', 'api-key',
  'access_token', 'accesstoken',
  'auth_token', 'authtoken',
  'session', 'session_id', 'sessionid',
  'password', 'passwd', 'pwd',
  'secret', 'client_secret',
  'private_key', 'privatekey',
])

// Long-opaque-value-in-query heuristic threshold.
const OPAQUE_VALUE_MIN = 40

// Hosts considered analytics/tracking that we silently ignore in the
// cross-origin section so it doesn't dominate findings.
const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'segment.io', 'amplitude.com', 'mixpanel.com', 'hotjar.com',
  'fullstory.com', 'datadoghq.com', 'sentry.io', 'newrelic.com',
  'facebook.com', 'fbcdn.net', 'linkedin.com',
]

// Scans every captured session for the host and assembles a security
// report. We can be moderately confident because the extension preserves
// header NAMES even when redacting their values, and we have full URLs +
// status codes + cookie names.
export function analyzeProjectSecurity(host: string, sessions: StoredSession[]): SecurityReport {
  const findings: SecurityFinding[] = []
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const allNavs = sessions.flatMap((s) => s.summary.navigations ?? [])
  const storageStates = sessions.map((s) => s.summary.storageState).filter((s): s is NonNullable<typeof s> => !!s)

  // ---- Auth scheme detection per endpoint -----------------------------------
  const authMatrix = buildAuthMatrix(allCalls)

  // ---- Cross-origin requests ----
  const crossOrigin: Map<string, { count: number; methods: Set<string> }> = new Map()
  for (const c of allCalls) {
    try {
      const u = new URL(c.url)
      if (u.host === host) continue
      if (TRACKER_HOSTS.some((t) => u.host === t || u.host.endsWith('.' + t))) continue
      const entry = crossOrigin.get(u.host) ?? { count: 0, methods: new Set() }
      entry.count++
      entry.methods.add(c.method.toUpperCase())
      crossOrigin.set(u.host, entry)
    } catch {
      // skip
    }
  }
  if (crossOrigin.size > 0) {
    findings.push({
      id: 'cross-origin',
      severity: 'info',
      title: `Cross-origin API calls to ${crossOrigin.size} other host${crossOrigin.size === 1 ? '' : 's'}`,
      description: `The captured frontend calls APIs on hosts other than ${host}. Trackers/analytics filtered out. If any of these are critical, they widen the trust boundary you have to reason about.`,
      evidence: [...crossOrigin.entries()]
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 10)
        .map(([h, { count, methods }]) => `${h} (${count} call${count === 1 ? '' : 's'}, methods: ${[...methods].sort().join(', ')})`),
    })
  }

  // ---- Mixed content: http:// URLs from a presumed https:// origin ----
  const httpUrls = new Set<string>()
  const projectOnHttps = sessions.some((s) => s.summary.meta.url.startsWith('https://'))
  if (projectOnHttps) {
    for (const c of allCalls) {
      if (c.url.startsWith('http://') && !c.url.startsWith('http://localhost') && !c.url.startsWith('http://127.')) {
        httpUrls.add(`${c.method.toUpperCase()} ${c.url}`)
      }
    }
    for (const n of allNavs) {
      if (n.url.startsWith('http://') && !n.url.startsWith('http://localhost') && !n.url.startsWith('http://127.')) {
        httpUrls.add(`nav → ${n.url}`)
      }
    }
    if (httpUrls.size > 0) {
      findings.push({
        id: 'mixed-content',
        severity: 'high',
        title: `${httpUrls.size} insecure http:// request${httpUrls.size === 1 ? '' : 's'} from an https:// origin`,
        description: 'Modern browsers block or warn on mixed content. Anything loaded over plain http leaks contents and can be modified in transit.',
        evidence: [...httpUrls].slice(0, 10),
      })
    }
  }

  // ---- Secrets in URLs ----
  const secretsInUrl: string[] = []
  for (const item of [...allCalls.map((c) => ({ url: c.url, label: `${c.method.toUpperCase()} ${c.url}` })),
                      ...allNavs.map((n) => ({ url: n.url, label: `nav → ${n.url}` }))]) {
    try {
      const u = new URL(item.url)
      for (const [name, value] of u.searchParams) {
        const lower = name.toLowerCase()
        if (SECRET_PARAM_NAMES.has(lower)) {
          secretsInUrl.push(`${name}=… on ${item.label.slice(0, 120)}`)
        } else if (value.length >= OPAQUE_VALUE_MIN && /^[A-Za-z0-9._-]+$/.test(value)) {
          // Long opaque value — JWT-shaped or similar.
          secretsInUrl.push(`${name}=<${value.length}-char opaque> on ${item.label.slice(0, 120)}`)
        }
      }
    } catch {
      // skip
    }
  }
  if (secretsInUrl.length > 0) {
    findings.push({
      id: 'secrets-in-url',
      severity: 'high',
      title: `${secretsInUrl.length} secret-shaped query parameter${secretsInUrl.length === 1 ? '' : 's'} in URLs`,
      description: 'Secrets in query strings end up in browser history, referrer headers, and access logs. Move to request bodies or headers when possible.',
      evidence: dedupe(secretsInUrl).slice(0, 10),
    })
  }

  // ---- Auth-enforcing endpoints (401/403 hits) ----
  const authEnforcing = authMatrix.filter((r) => r.unauthorizedHits + r.forbiddenHits > 0)
  if (authEnforcing.length > 0) {
    findings.push({
      id: 'auth-enforced',
      severity: 'info',
      title: `${authEnforcing.length} endpoint${authEnforcing.length === 1 ? '' : 's'} returned 401/403 during recording`,
      description: 'These endpoints actively enforce auth — useful for understanding the auth boundary. Some may have been hit before login or after token expiry.',
      evidence: authEnforcing
        .sort((a, b) => (b.unauthorizedHits + b.forbiddenHits) - (a.unauthorizedHits + a.forbiddenHits))
        .slice(0, 10)
        .map((r) => `${r.method} ${r.normalizedPath} — 401×${r.unauthorizedHits}${r.forbiddenHits > 0 ? `, 403×${r.forbiddenHits}` : ''}`),
    })
  }

  // ---- Login-redirect map (302/303 to a /login or /signin URL) ----
  // We don't have response headers for redirects in apiCalls (just status),
  // but we can infer from consecutive navigations where the second URL looks
  // like a login page.
  const loginNavs = allNavs.filter((n) => /\/(login|signin|sign-in|auth\/)/i.test(n.url))
  if (loginNavs.length > 0) {
    findings.push({
      id: 'login-pages',
      severity: 'info',
      title: `${loginNavs.length} navigation${loginNavs.length === 1 ? '' : 's'} to a login-shaped URL`,
      description: 'Either the app sent the user to log in, or the user explicitly visited the login page. Marks the perimeter of the unauthenticated surface.',
      evidence: dedupe(loginNavs.map((n) => n.url)).slice(0, 6),
    })
  }

  // ---- Cookies / storage audit ----
  const cookieNames = new Map<string, Set<string>>()
  const localKeys = new Set<string>()
  const sessionKeys = new Set<string>()
  for (const s of storageStates) {
    for (const k of s.localStorageKeys) localKeys.add(k)
    for (const k of s.sessionStorageKeys) sessionKeys.add(k)
    for (const c of s.cookies) {
      const set = cookieNames.get(c.name) ?? new Set<string>()
      set.add(c.domain)
      cookieNames.set(c.name, set)
    }
  }
  const sensitiveCookieKeywords = /session|token|auth|jwt|access|refresh|csrf|xsrf/i
  const sensitiveCookies = [...cookieNames.entries()].filter(([n]) => sensitiveCookieKeywords.test(n))
  if (sensitiveCookies.length > 0) {
    findings.push({
      id: 'sensitive-cookies',
      severity: 'info',
      title: `${sensitiveCookies.length} session/auth-shaped cookie${sensitiveCookies.length === 1 ? '' : 's'} observed`,
      description: 'Cookie names that look auth-relevant. The extension only captures names+domain (no values, no Secure/HttpOnly/SameSite flags), so this is an inventory, not a verdict.',
      evidence: sensitiveCookies.slice(0, 12).map(([n, ds]) => `${n} (domains: ${[...ds].join(', ')})`),
    })
  }

  // localStorage keys that look like they store auth/credentials
  const sensitiveLocal = [...localKeys].filter((k) => sensitiveCookieKeywords.test(k))
  if (sensitiveLocal.length > 0) {
    findings.push({
      id: 'sensitive-local-storage',
      severity: 'warn',
      title: `${sensitiveLocal.length} auth-shaped localStorage key${sensitiveLocal.length === 1 ? '' : 's'}`,
      description: 'Tokens in localStorage are accessible to any script running on the same origin (including XSS payloads). Cookies with HttpOnly are typically safer.',
      evidence: sensitiveLocal.slice(0, 10),
    })
  }

  // ---- POST/mutation endpoints that don't appear to require any auth ----
  // Heuristic: any non-GET endpoint that succeeded (2xx) but never had any
  // sensitive header sent. Could be public mutation, could be cookie-via-
  // browser (which the captured header set doesn't see — the browser's
  // cookie jar is invisible to fetch headers). So this is "info" only.
  const unauthedMutations = authMatrix.filter(
    (r) => r.method !== 'GET' && r.scheme === '(none)' && r.callCount > 0 && r.unauthorizedHits === 0,
  )
  if (unauthedMutations.length > 0) {
    findings.push({
      id: 'unauthed-mutations',
      severity: 'info',
      title: `${unauthedMutations.length} non-GET endpoint${unauthedMutations.length === 1 ? '' : 's'} with no observed auth header`,
      description: 'These mutations went through without any captured Authorization/cookie/api-key header. Note: browsers send cookies from their jar without exposing them to fetch — so this may be cookie-auth invisible to the capture. Still worth checking.',
      evidence: unauthedMutations
        .slice(0, 10)
        .map((r) => `${r.method} ${r.normalizedPath} (${r.callCount} call${r.callCount === 1 ? '' : 's'})`),
    })
  }

  return {
    host,
    sessionCount: sessions.length,
    totals: {
      endpoints: authMatrix.length,
      cookies: cookieNames.size,
      authedEndpoints: authMatrix.filter((r) => r.scheme !== '(none)').length,
      crossOriginRequests: crossOrigin.size,
    },
    authMatrix,
    findings: findings.sort(severityRank),
  }
}

function severityRank(a: SecurityFinding, b: SecurityFinding): number {
  const w: Record<FindingSeverity, number> = { high: 0, warn: 1, info: 2 }
  return w[a.severity] - w[b.severity]
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

function buildAuthMatrix(calls: ApiCall[]): AuthMatrixRow[] {
  const map = new Map<string, { method: string; path: string; host: string; schemes: Map<string, number>; calls: number; un: number; fb: number }>()
  for (const c of calls) {
    let hostname = ''
    let path = c.url
    try {
      const u = new URL(c.url)
      hostname = u.host
      path = normalizePath(u.pathname)
    } catch {
      // skip URL parse fail
    }
    const key = `${c.method.toUpperCase()} ${hostname} ${path}`
    let entry = map.get(key)
    if (!entry) {
      entry = {
        method: c.method.toUpperCase(),
        path,
        host: hostname,
        schemes: new Map(),
        calls: 0,
        un: 0,
        fb: 0,
      }
      map.set(key, entry)
    }
    entry.calls++
    if (c.status === 401) entry.un++
    if (c.status === 403) entry.fb++
    const scheme = detectAuthScheme(c)
    entry.schemes.set(scheme, (entry.schemes.get(scheme) ?? 0) + 1)
  }
  const rows: AuthMatrixRow[] = []
  for (const e of map.values()) {
    // Pick the most common observed scheme; "Mixed" when more than one type appears.
    const observed = [...e.schemes.entries()].filter(([s]) => s !== '(none)')
    let scheme: AuthMatrixRow['scheme']
    if (observed.length === 0) scheme = '(none)'
    else if (observed.length === 1) scheme = observed[0]![0] as AuthMatrixRow['scheme']
    else scheme = 'Mixed'
    rows.push({
      method: e.method,
      normalizedPath: e.path,
      hostname: e.host,
      scheme,
      callCount: e.calls,
      unauthorizedHits: e.un,
      forbiddenHits: e.fb,
    })
  }
  return rows.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath) || a.method.localeCompare(b.method))
}

function detectAuthScheme(c: ApiCall): 'Bearer' | 'Cookie' | 'API key' | 'Basic' | '(none)' {
  const h = c.requestHeaders ?? {}
  for (const [name, val] of Object.entries(h)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') {
      // Even though value is redacted, the prefix "Bearer ..." is gone too.
      // Use header name presence + redacted-length heuristic: short redacted
      // values are usually Basic; longer ones are usually Bearer.
      if (/^\[REDACTED:(\d+)\]$/.test(val)) {
        const len = parseInt(/^\[REDACTED:(\d+)\]$/.exec(val)![1]!, 10)
        return len > 40 ? 'Bearer' : 'Basic'
      }
      // Unredacted (shouldn't happen post-redaction but just in case)
      if (/^bearer /i.test(val)) return 'Bearer'
      if (/^basic /i.test(val)) return 'Basic'
      return 'Bearer'
    }
    if (lower === 'cookie') return 'Cookie'
    if (lower === 'x-api-key' || lower === 'x-auth-token' || lower === 'apikey') return 'API key'
  }
  return '(none)'
}

function normalizePath(p: string): string {
  return (
    '/' +
    p.split('/').filter(Boolean).map((seg) => {
      if (/^\d+$/.test(seg)) return '{id}'
      if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
      if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
      return seg
    }).join('/')
  )
}
