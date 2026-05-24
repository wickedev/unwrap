import type { Env } from './env'

// GitHub App MVP — JWT minting (App-level), installation token exchange
// + caching, webhook signature verification, and a thin comment-poster
// that uses the bot identity instead of a user PAT.
//
// All crypto goes through Workers' built-in crypto.subtle so this runs
// unchanged on Cloudflare. No native deps.

export interface InstallationRecord {
  installationId: number
  // The "account" GitHub assigns the install — could be a user OR an
  // organization. Stored verbatim so the UI can show owner avatars later.
  accountLogin: string
  accountType: 'User' | 'Organization'
  // owner/repo pairs we have access to (cap to ~50 to keep payloads small).
  repositories: string[]
  installedAt: number
  // Suspended installations stop working but stay in our index so
  // re-enabling them is one click on GitHub's side.
  suspended: boolean
}

const INSTALLATION_TTL = 365 * 24 * 60 * 60
const INSTALL_TOKEN_TTL_CACHE = 50 * 60 // GitHub installation tokens live ~1h; refresh slightly before.

function installationKey(id: number): string {
  return `github-installation:${id}`
}
function installationByRepoKey(repo: string): string {
  return `github-installation-by-repo:${repo}`
}
function cachedInstallTokenKey(id: number): string {
  return `github-installation-token:${id}`
}

// ---- Webhook signature verification ----------------------------------------

// GitHub signs webhook payloads with HMAC-SHA256 of the raw body using
// the App's webhook secret, prefixed with "sha256=" in the
// X-Hub-Signature-256 header.
export async function verifyWebhookSignature(
  env: Env,
  rawBody: string,
  headerSig: string,
): Promise<boolean> {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return false
  if (!headerSig.startsWith('sha256=')) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.GITHUB_APP_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const macBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  const mac = bufToHex(macBuf)
  return timingSafeEqualHex(`sha256=${mac}`, headerSig)
}

function bufToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += arr[i]!.toString(16).padStart(2, '0')
  return s
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---- App-level JWT minter --------------------------------------------------

// GitHub Apps authenticate with a short-lived JWT signed by the App's
// RSA private key. We mint a fresh JWT per call — TTL is 10 minutes per
// GitHub's spec, but we clamp to 5 minutes for safety.
export async function mintAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App not configured (missing GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)')
  }
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: now - 60,           // 60s back-dated for clock skew
    exp: now + 5 * 60,       // 5min TTL
    iss: env.GITHUB_APP_ID,
  }
  const headerB64 = b64urlEncode(JSON.stringify(header))
  const payloadB64 = b64urlEncode(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await importRsaPrivateKey(env.GITHUB_APP_PRIVATE_KEY)
  const sigBuf = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  )
  const sigB64 = b64urlEncodeBuf(sigBuf)
  return `${signingInput}.${sigB64}`
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM header/footer, base64-decode, import as PKCS#8.
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '')
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function b64urlEncode(s: string): string {
  // .buffer can be a SharedArrayBuffer when the source view shares its
  // backing store; copy into a fresh ArrayBuffer to keep the helper's
  // signature simple.
  const view = new TextEncoder().encode(s)
  const copy = new ArrayBuffer(view.length)
  new Uint8Array(copy).set(view)
  return b64urlEncodeBuf(copy)
}

function b64urlEncodeBuf(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// ---- Installation token exchange + cache -----------------------------------

interface InstallTokenResponse {
  token: string
  expires_at: string
}

interface CachedInstallToken {
  token: string
  expiresAt: number
}

// Trades the App JWT for an installation token (scoped to one install).
// Cached in KV for ~50 minutes so frequent comment posts on the same
// installation only round-trip GitHub once per hour.
export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  if (!env.SESSIONS) {
    return await mintInstallationToken(env, installationId)
  }
  const cached = (await env.SESSIONS.get(cachedInstallTokenKey(installationId), 'json')) as CachedInstallToken | null
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const token = await mintInstallationToken(env, installationId)
  await env.SESSIONS.put(
    cachedInstallTokenKey(installationId),
    JSON.stringify({ token, expiresAt: Date.now() + INSTALL_TOKEN_TTL_CACHE * 1000 }),
    { expirationTtl: INSTALL_TOKEN_TTL_CACHE + 60 },
  )
  return token
}

async function mintInstallationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await mintAppJwt(env)
  const resp = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'unwrap-app',
    },
  })
  if (!resp.ok) {
    throw new Error(`installation token mint failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)
  }
  const body = (await resp.json()) as InstallTokenResponse
  return body.token
}

// ---- Installation registry -------------------------------------------------

export async function rememberInstallation(env: Env, rec: InstallationRecord): Promise<void> {
  if (!env.SESSIONS) return
  await env.SESSIONS.put(installationKey(rec.installationId), JSON.stringify(rec), {
    expirationTtl: INSTALLATION_TTL,
  })
  for (const repo of rec.repositories) {
    await env.SESSIONS.put(installationByRepoKey(repo), String(rec.installationId), {
      expirationTtl: INSTALLATION_TTL,
    })
  }
}

export async function forgetInstallation(env: Env, installationId: number): Promise<void> {
  if (!env.SESSIONS) return
  // We don't delete the per-repo reverse index entries — they expire on
  // their own. The forward record is what matters for token minting.
  await env.SESSIONS.delete(installationKey(installationId))
  await env.SESSIONS.delete(cachedInstallTokenKey(installationId))
}

export async function findInstallationForRepo(env: Env, repo: string): Promise<number | null> {
  if (!env.SESSIONS) return null
  const raw = await env.SESSIONS.get(installationByRepoKey(repo))
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function getInstallation(env: Env, installationId: number): Promise<InstallationRecord | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(installationKey(installationId), 'json')) as InstallationRecord | null
}

// ---- Comment poster (bot identity) -----------------------------------------

export const UNWRAP_COMMENT_MARKER = '<!-- unwrap:pr-comment:v1 -->'

// Posts (or edits in place) a PR comment using the App's bot identity
// for the given repo+PR. Looks up the installation, mints a token,
// and idempotently finds the prior Unwrap comment via the marker.
export async function postOrUpdateCommentAsApp(opts: {
  env: Env
  repo: string             // owner/repo
  pullNumber: number
  body: string
}): Promise<{ commentId: number; htmlUrl?: string; created: boolean }> {
  const { env, repo, pullNumber, body } = opts
  const installationId = await findInstallationForRepo(env, repo)
  if (installationId == null) {
    throw new Error(`No Unwrap GitHub App installation covers ${repo}. Install at the org level and grant access.`)
  }
  const token = await getInstallationToken(env, installationId)
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'unwrap-app',
  }

  const listResp = await fetch(`https://api.github.com/repos/${repo}/issues/${pullNumber}/comments?per_page=100`, { headers })
  if (!listResp.ok) {
    throw new Error(`GitHub list-comments failed: HTTP ${listResp.status} ${(await listResp.text()).slice(0, 200)}`)
  }
  const existing = (await listResp.json()) as { id: number; body?: string; html_url?: string }[]
  const prior = existing.find((c) => (c.body ?? '').startsWith(UNWRAP_COMMENT_MARKER))
  if (prior) {
    const r = await fetch(`https://api.github.com/repos/${repo}/issues/comments/${prior.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (!r.ok) {
      throw new Error(`PATCH comment failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
    }
    const u = (await r.json()) as { id: number; html_url?: string }
    return { commentId: u.id, ...(u.html_url ? { htmlUrl: u.html_url } : {}), created: false }
  }
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${pullNumber}/comments`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!r.ok) {
    throw new Error(`POST comment failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  }
  const u = (await r.json()) as { id: number; html_url?: string }
  return { commentId: u.id, ...(u.html_url ? { htmlUrl: u.html_url } : {}), created: true }
}
