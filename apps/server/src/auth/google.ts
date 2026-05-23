import type { Env } from '../env'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

const SCOPES = ['openid', 'email', 'profile']

export type OAuthMode = { type: 'extension'; extensionRedirect: string } | { type: 'web'; returnTo: string }

export interface OAuthStateRecord {
  mode: OAuthMode
  createdAt: number
}

export async function startGoogleOAuth(
  env: Env,
  serverCallback: string,
  mode: OAuthMode,
): Promise<{ authUrl: string; state: string }> {
  if (!env.OAUTH_STATE) throw new Error('OAUTH_STATE KV namespace not configured')

  const state = crypto.randomUUID()
  const record: OAuthStateRecord = { mode, createdAt: Date.now() }
  await env.OAUTH_STATE.put(`state:${state}`, JSON.stringify(record), { expirationTtl: 600 })

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', serverCallback)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'select_account')
  return { authUrl: url.toString(), state }
}

export async function consumeOAuthState(env: Env, state: string): Promise<OAuthStateRecord | null> {
  if (!env.OAUTH_STATE) throw new Error('OAUTH_STATE KV namespace not configured')
  const key = `state:${state}`
  const raw = await env.OAUTH_STATE.get(key)
  if (!raw) return null
  await env.OAUTH_STATE.delete(key)
  try {
    return JSON.parse(raw) as OAuthStateRecord
  } catch {
    return null
  }
}

interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  scope: string
  token_type: string
  id_token?: string
}

export async function exchangeCodeForToken(
  env: Env,
  code: string,
  serverCallback: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: serverCallback,
    grant_type: 'authorization_code',
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Google token exchange failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as GoogleTokenResponse
}

export interface GoogleUserInfo {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const resp = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Google userinfo failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as GoogleUserInfo
}

export function isEmailAllowed(env: Env, email: string): boolean {
  const raw = (env.ALLOWED_EMAILS ?? '').trim()
  if (!raw) return true
  const allowed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const lower = email.toLowerCase()
  return allowed.some((entry) => (entry.startsWith('@') ? lower.endsWith(entry) : lower === entry))
}
