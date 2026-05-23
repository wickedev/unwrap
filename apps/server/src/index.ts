import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type {
  AuthStartResponse,
  ErrorResponse,
  GenerateRequest,
  GenerateResponse,
  MeResponse,
} from '@unwrap/protocol'
import type { Env } from './env'
import {
  consumeOAuthState,
  exchangeCodeForToken,
  fetchUserInfo,
  isEmailAllowed,
  startGoogleOAuth,
} from './auth/google'
import { issueToken, verifyToken } from './auth/jwt'
import { callGemini } from './gemini'

type Bindings = Env
type Variables = { email: string }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use(
  '*',
  cors({
    origin: (origin) => origin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    credentials: false,
    maxAge: 86400,
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

// ---------- OAuth ----------

app.post('/auth/google/start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { extensionRedirect?: string }
  const extensionRedirect = body.extensionRedirect
  if (!extensionRedirect) return c.json(err('extensionRedirect required'), 400)
  if (!/^https:\/\/[a-z]+\.chromiumapp\.org\//.test(extensionRedirect)) {
    return c.json(err('extensionRedirect must be a chromiumapp.org URL'), 400)
  }
  const serverCallback = `${originOf(c.req.url)}/auth/google/callback`
  const { authUrl, state } = await startGoogleOAuth(c.env, serverCallback, extensionRedirect)
  return c.json<AuthStartResponse>({ authUrl, state })
})

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errorParam = c.req.query('error')
  if (errorParam) return c.html(htmlError(`Google returned error: ${errorParam}`))
  if (!code || !state) return c.html(htmlError('Missing code or state'))

  const record = await consumeOAuthState(c.env, state)
  if (!record) return c.html(htmlError('Invalid or expired state'))

  const serverCallback = `${originOf(c.req.url)}/auth/google/callback`
  try {
    const token = await exchangeCodeForToken(c.env, code, serverCallback)
    const user = await fetchUserInfo(token.access_token)
    if (!user.email_verified) return c.html(htmlError('Email not verified by Google'))
    if (!isEmailAllowed(c.env, user.email)) {
      return c.html(htmlError(`Email ${user.email} is not on the allow list`))
    }

    const { token: jwt, expiresAt } = await issueToken(user.email, c.env.JWT_SECRET)
    const redirect = new URL(record.extensionRedirect)
    redirect.searchParams.set('token', jwt)
    redirect.searchParams.set('email', user.email)
    redirect.searchParams.set('expires_at', String(expiresAt))
    return c.redirect(redirect.toString(), 302)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return c.html(htmlError(message))
  }
})

// ---------- Auth middleware ----------

app.use('/api/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  const m = auth.match(/^Bearer (.+)$/)
  if (!m) return c.json(err('Missing bearer token'), 401)
  try {
    const claims = await verifyToken(m[1]!, c.env.JWT_SECRET)
    c.set('email', claims.email)
  } catch {
    return c.json(err('Invalid token'), 401)
  }
  await next()
})

app.get('/api/me', (c) => {
  return c.json<MeResponse>({ email: c.get('email'), expiresAt: 0 })
})

// ---------- Generate ----------

app.post('/api/generate', async (c) => {
  let body: GenerateRequest
  try {
    body = (await c.req.json()) as GenerateRequest
  } catch {
    return c.json(err('Invalid JSON body'), 400)
  }
  if (!body?.summary || !body?.fallbackSpec) {
    return c.json(err('summary and fallbackSpec are required'), 400)
  }

  const model = body.summary && c.env.GEMINI_MODEL ? c.env.GEMINI_MODEL : 'gemini-2.5-pro'
  try {
    const result: GenerateResponse = await callGemini(body, {
      apiKey: c.env.GEMINI_API_KEY,
      model,
    })
    return c.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[unwrap-server] generate failed', message)
    return c.json(err('Generation failed', message), 502)
  }
})

// ---------- helpers ----------

function err(error: string, detail?: string): ErrorResponse {
  return detail ? { error, detail } : { error }
}

function originOf(reqUrl: string): string {
  const u = new URL(reqUrl)
  return `${u.protocol}//${u.host}`
}

function htmlError(message: string): string {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<!doctype html><html><body style="font-family:system-ui;padding:32px"><h1>Sign-in failed</h1><p>${escaped}</p><p>You can close this window.</p></body></html>`
}

export default app
