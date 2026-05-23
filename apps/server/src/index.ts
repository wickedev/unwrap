import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type {
  AuthStartResponse,
  ErrorResponse,
  GenerateResponse,
  MeResponse,
  SessionListResponse,
  UploadSessionRequest,
  UploadSessionResponse,
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
import { clearSessionCookie, readEmail, setSessionCookie } from './auth/cookie'
import { callGemini } from './gemini'
import {
  getScreenshot,
  getSession as getStoredSession,
  listSessions,
  newSessionId,
  putSession,
  setGenerated,
} from './storage/sessions'
import { LoginPage, SessionsPage } from './pages/home'
import { SessionDetailPage } from './pages/session'
import { verifySession } from './verify'

type Bindings = Env
type Variables = { email: string }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use(
  '/api/*',
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
  const { authUrl, state } = await startGoogleOAuth(c.env, serverCallback, {
    type: 'extension',
    extensionRedirect,
  })
  return c.json<AuthStartResponse>({ authUrl, state })
})

app.get('/auth/google/start', async (c) => {
  if (c.req.query('mode') !== 'web') return c.redirect('/', 302)
  const returnTo = c.req.query('returnTo') ?? '/sessions'
  const serverCallback = `${originOf(c.req.url)}/auth/google/callback`
  const { authUrl } = await startGoogleOAuth(c.env, serverCallback, { type: 'web', returnTo })
  return c.redirect(authUrl, 302)
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

    if (record.mode.type === 'web') {
      await setSessionCookie(c, jwt)
      return c.redirect(record.mode.returnTo || '/sessions', 302)
    }

    const redirect = new URL(record.mode.extensionRedirect)
    redirect.searchParams.set('token', jwt)
    redirect.searchParams.set('email', user.email)
    redirect.searchParams.set('expires_at', String(expiresAt))
    return c.redirect(redirect.toString(), 302)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return c.html(htmlError(message))
  }
})

app.get('/auth/sign-out', async (c) => {
  await clearSessionCookie(c)
  return c.redirect('/', 302)
})

// ---------- API auth (JWT bearer or signed cookie) ----------

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/me' || c.req.path.startsWith('/api/sessions') || c.req.path === '/api/generate') {
    const email = await readEmail(c)
    if (!email) return c.json(err('Not signed in'), 401)
    c.set('email', email)
  }
  await next()
})

app.get('/api/me', (c) => {
  return c.json<MeResponse>({ email: c.get('email'), expiresAt: 0 })
})

// ---------- Session upload + retrieval ----------

app.post('/api/sessions', async (c) => {
  let body: UploadSessionRequest
  try {
    body = (await c.req.json()) as UploadSessionRequest
  } catch {
    return c.json(err('Invalid JSON body'), 400)
  }
  if (!body?.summary || !body?.fallbackSpec) {
    return c.json(err('summary and fallbackSpec are required'), 400)
  }
  const id = newSessionId()
  await putSession(c.env, {
    id,
    email: c.get('email'),
    uploadedAt: Date.now(),
    clientSessionId: body.clientSessionId ?? '',
    summary: body.summary,
    fallbackSpec: body.fallbackSpec,
    screenshots: body.screenshots ?? [],
  })
  const url = `${originOf(c.req.url)}/sessions/${id}`
  return c.json<UploadSessionResponse>({ id, url })
})

app.get('/api/sessions', async (c) => {
  const sessions = await listSessions(c.env, c.get('email'))
  return c.json<SessionListResponse>({ sessions })
})

app.get('/api/sessions/:id', async (c) => {
  const record = await getStoredSession(c.env, c.get('email'), c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  return c.json(record)
})

app.post('/api/sessions/:id/generate', async (c) => {
  const id = c.req.param('id')
  const email = c.get('email')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return c.json(err('Not found'), 404)
  const model = c.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  try {
    const generated: GenerateResponse = await callGemini(
      {
        sessionId: record.id,
        summary: record.summary,
        fallbackSpec: record.fallbackSpec,
        screenshots: record.screenshots,
      },
      { apiKey: c.env.GEMINI_API_KEY, model },
    )
    const updated = await setGenerated(c.env, email, id, generated)
    return c.json({ ...generated, sessionId: id, generatedAt: updated?.generated?.generatedAt ?? Date.now() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[unwrap-server] generate failed', message)
    return c.json(err('Generation failed', message), 502)
  }
})

app.post('/api/sessions/:id/verify', async (c) => {
  const id = c.req.param('id')
  const email = c.get('email')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return c.json(err('Not found'), 404)
  try {
    const result = await verifySession(c.env, email, record)
    record.verification = result
    await putSession(c.env, record)
    return c.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[unwrap-server] verify failed', message)
    return c.json(err('Verification failed', message), 502)
  }
})

app.get('/api/sessions/:id/screenshots/:ref', async (c) => {
  const id = c.req.param('id')
  const ref = c.req.param('ref')
  const email = c.get('email')
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) return c.json(err('Invalid ref'), 400)
  const record = await getStoredSession(c.env, email, id)
  if (!record) return c.json(err('Not found'), 404)
  if (!record.verification?.screenshotRefs.includes(ref)) {
    return c.json(err('Screenshot not found'), 404)
  }
  const bytes = await getScreenshot(c.env, email, id, ref)
  if (!bytes) return c.json(err('Screenshot expired'), 404)
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=86400',
    },
  })
})

// Legacy: keep /api/generate as a synchronous one-shot for extensions that
// haven't upgraded yet. Same JWT auth, same Gemini path, no storage.
app.post('/api/generate', async (c) => {
  let body: UploadSessionRequest
  try {
    body = (await c.req.json()) as UploadSessionRequest
  } catch {
    return c.json(err('Invalid JSON body'), 400)
  }
  if (!body?.summary || !body?.fallbackSpec) {
    return c.json(err('summary and fallbackSpec are required'), 400)
  }
  const model = c.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  try {
    const generated = await callGemini(
      {
        sessionId: body.clientSessionId ?? 'inline',
        summary: body.summary,
        fallbackSpec: body.fallbackSpec,
        screenshots: body.screenshots ?? [],
      },
      { apiKey: c.env.GEMINI_API_KEY, model },
    )
    return c.json(generated)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[unwrap-server] generate failed', message)
    return c.json(err('Generation failed', message), 502)
  }
})

// ---------- HTML routes ----------

app.get('/', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.html(LoginPage())
  return c.redirect('/sessions', 302)
})

app.get('/sessions', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const sessions = await listSessions(c.env, email)
  return c.html(SessionsPage({ email, sessions }))
})

app.get('/sessions/:id', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.html(LoginPage(), 404)
  return c.html(SessionDetailPage({ email, session: record }))
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

// satisfy ts: imports used only in types above
void (verifyToken as unknown)

export default app
