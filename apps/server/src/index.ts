import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type {
  AuthStartResponse,
  ErrorResponse,
  GenerateResponse,
  MeResponse,
  SessionListResponse,
  StoredSession,
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
  findPreviousSession,
  getScreenshot,
  getSession as getStoredSession,
  listSessions,
  newSessionId,
  putScreenshot,
  putSession,
  setGenerated,
} from './storage/sessions'
import { LoginPage, SessionsPage } from './pages/home'
import { SessionDetailPage } from './pages/session'
import { ComparePage } from './pages/compare'
import { ApiInventoryPage } from './pages/api-inventory'
import { generateMockServer } from './mock-export'
import { buildStaticMirrorZip } from './static-mirror'
import { extractGraphqlOperations } from './graphql-extract'
import { aggregateProject } from './project-aggregate'
import { ProjectPage } from './pages/project'
import { buildCloneBundle } from './clone-bundle'
import { buildOpenApiFromProject, buildOpenApiFromSession } from './openapi-export'
import { buildPostmanFromProject, buildPostmanFromSession } from './postman-export'
import { loadOrGenerateNarrative } from './project-narrative'
import { ProjectNarrativePage } from './pages/project-narrative'
import { buildProjectGraph } from './project-graph'
import { ProjectGraphPage } from './pages/project-graph'
import { buildProjectHeatmaps } from './project-heatmap'
import { ProjectHeatmapPage } from './pages/project-heatmap'
import { verifySession } from './verify'
import { diffSessions, summarizeRegression } from './sessiondiff'
import { computeCrossSessionVisualDiff } from './visualcrossdiff'

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
  const email = c.get('email')

  // Stash every full-res captured screenshot as a separate KV blob and
  // keep only metadata on the session record.
  const verifyScreenshotMeta: NonNullable<StoredSession['verifyScreenshotMeta']> = []
  for (const shot of body.verifyScreenshots ?? []) {
    if (!shot?.dataBase64 || !shot?.originalRef) continue
    if (!/^[A-Za-z0-9._-]+$/.test(shot.originalRef)) continue
    const storedRef = `orig-${shot.originalRef}`
    try {
      const bytes = base64ToBytes(shot.dataBase64)
      await putScreenshot(c.env, email, id, storedRef, bytes)
      verifyScreenshotMeta.push({
        originalRef: shot.originalRef,
        originalTs: shot.originalTs,
        url: shot.url ?? '',
        width: shot.width,
        height: shot.height,
        storedRef,
      })
    } catch (e) {
      console.warn('[unwrap-server] failed to persist verify screenshot', e)
    }
  }

  const uploadedAt = Date.now()
  const record: StoredSession = {
    id,
    email,
    uploadedAt,
    clientSessionId: body.clientSessionId ?? '',
    summary: body.summary,
    fallbackSpec: body.fallbackSpec,
    screenshots: body.screenshots ?? [],
    ...(verifyScreenshotMeta.length ? { verifyScreenshotMeta } : {}),
  }

  // Auto-baseline: diff against the most recent session of the same host
  // and stash a compact regression summary on the record. The Compare
  // page uses the full diff; the list uses this summary for badges.
  try {
    const previous = await findPreviousSession(c.env, email, body.summary.meta.host, uploadedAt)
    if (previous) {
      const diff = diffSessions(previous, record)
      record.regression = summarizeRegression(previous, diff)
    }
  } catch (e) {
    console.warn('[unwrap-server] failed to compute regression', e)
  }

  await putSession(c.env, record)
  const url = `${originOf(c.req.url)}/sessions/${id}`
  return c.json<UploadSessionResponse>({ id, url })
})

function base64ToBytes(s: string): ArrayBuffer {
  const bin = atob(s)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

app.get('/api/sessions', async (c) => {
  await backfillRegressions(c.env, c.get('email'))
  const sessions = await listSessions(c.env, c.get('email'))
  return c.json<SessionListResponse>({ sessions })
})

// Walks the user's sessions (newest first) and, for any session that's
// missing a regression summary but has an older same-host neighbour,
// computes + persists one. Fire-and-forget on list/render calls so
// existing sessions catch up incrementally with no separate migration.
const backfillsInFlight = new Set<string>()
async function backfillRegressions(env: Env, email: string): Promise<void> {
  if (backfillsInFlight.has(email)) return
  backfillsInFlight.add(email)
  let processed = 0
  let updated = 0
  try {
    const items = await listSessions(env, email)
    const ordered = items.slice().sort((a, b) => a.uploadedAt - b.uploadedAt)
    const lastByHost = new Map<string, { id: string; uploadedAt: number }>()
    for (const it of ordered) {
      const prev = lastByHost.get(it.host)
      lastByHost.set(it.host, { id: it.id, uploadedAt: it.uploadedAt })
      if (!prev) continue
      processed++
      if (it.regressionLevel) continue
      const [baseline, current] = await Promise.all([
        getStoredSession(env, email, prev.id),
        getStoredSession(env, email, it.id),
      ])
      if (!baseline || !current) continue
      if (current.regression) continue
      try {
        const diff = diffSessions(baseline, current)
        current.regression = summarizeRegression(baseline, diff)
        await putSession(env, current)
        updated++
      } catch (e) {
        console.warn('[unwrap-server] backfill diff failed', it.id, e)
      }
    }
    console.info('[unwrap-server] backfill complete', { processed, updated })
  } finally {
    backfillsInFlight.delete(email)
  }
}

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

app.get('/api/sessions/:id/compare/:otherId', async (c) => {
  // URL convention: /sessions/<current>/compare/<baseline>. The route
  // exists alongside the human page and uses the same semantics.
  const email = c.get('email')
  const currentId = c.req.param('id')
  const baselineId = c.req.param('otherId')
  if (currentId === baselineId) return c.json(err('Cannot compare a session to itself'), 400)
  const [baseline, current] = await Promise.all([
    getStoredSession(c.env, email, baselineId),
    getStoredSession(c.env, email, currentId),
  ])
  if (!baseline || !current) return c.json(err('One or both sessions not found'), 404)
  return c.json(diffSessions(baseline, current))
})

app.get('/api/sessions/:id/screenshots/:ref', async (c) => {
  const id = c.req.param('id')
  const ref = c.req.param('ref')
  const email = c.get('email')
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) return c.json(err('Invalid ref'), 400)
  const record = await getStoredSession(c.env, email, id)
  if (!record) return c.json(err('Not found'), 404)

  const knownRefs = new Set<string>([
    ...(record.verification?.screenshotRefs ?? []),
    ...(record.verifyScreenshotMeta ?? []).map((m) => m.storedRef),
  ])
  for (const step of record.verification?.steps ?? []) {
    if (step.visualDiff) {
      knownRefs.add(step.visualDiff.originalRef)
      knownRefs.add(step.visualDiff.replayRef)
      knownRefs.add(step.visualDiff.diffRef)
    }
  }

  // Cross-session diffs (cmp-<baseline>-<current>-<index>) get stored
  // under the current session, so they're already authorized by the
  // record lookup above. Also allow `orig-` refs that point to the
  // OWN session's captured screenshots, or to a same-host baseline
  // referenced via verification cache, as long as the bytes exist.
  if (ref.startsWith('cmp-') || ref.startsWith('orig-')) {
    knownRefs.add(ref)
  }

  if (!knownRefs.has(ref)) {
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
  await backfillRegressions(c.env, email)
  const sessions = await listSessions(c.env, email)
  return c.html(SessionsPage({ email, sessions }))
})

app.get('/sessions/:id', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const id = c.req.param('id')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return c.html(LoginPage(), 404)
  // List of other sessions sharing the same host (for the Compare dropdown)
  const allSessions = await listSessions(c.env, email)
  const otherSameHost = allSessions
    .filter((s) => s.id !== id && s.host === record.summary.meta.host)
    .slice(0, 10)
  return c.html(SessionDetailPage({ email, session: record, otherSameHost }))
})

app.get('/sessions/:id/api', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.html(LoginPage(), 404)
  return c.html(ApiInventoryPage({ email, session: record }))
})

app.get('/sessions/:id/api/mock', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const { filename, body } = generateMockServer(record)
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

// Loads every session record for `email` belonging to `host`. Used by the
// project pages and aggregated download endpoints. Walks the list metadata
// once to pick ids by host, then fetches the full records in parallel.
async function loadProjectSessions(env: Env, email: string, host: string): Promise<StoredSession[]> {
  const items = await listSessions(env, email)
  const ids = items.filter((s) => s.host === host).map((s) => s.id)
  if (ids.length === 0) return []
  const records = await Promise.all(ids.map((id) => getStoredSession(env, email, id)))
  return records.filter((r): r is StoredSession => r !== null)
}

app.get('/projects/:host', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.html(LoginPage(), 404)
  const digest = aggregateProject(host, sessions)
  return c.html(ProjectPage({ email, digest }))
})

app.get('/projects/:host/graphql.txt', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const digest = aggregateProject(host, sessions)
  if (digest.graphqlOps.length === 0) return c.json(err('No GraphQL traffic in this project'), 404)
  // Synthesize a session whose apiCalls union the full project — feeds the
  // same extractor we use for single sessions so the output format matches.
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host },
    },
  }
  const artifact = extractGraphqlOperations(synthetic)
  if (!artifact) return c.json(err('No GraphQL traffic in this project'), 404)
  return new Response(artifact.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${artifact.filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/projects/:host/clone.zip', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  // Most-recent session supplies the frontend (latest UI we have);
  // aggregated synthetic session supplies the mock (every endpoint).
  const mostRecent = [...sessions].sort((a, b) => b.uploadedAt - a.uploadedAt)[0]!
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host },
    },
  }
  const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
  const { filename, bytes } = buildCloneBundle({
    staticSource: mostRecent,
    mockSource: synthetic,
    label: `Local clone of ${host}`,
    filenameStem: `clone-${safeHost}`,
  })
  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/clone.zip', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const safeHost = (record.summary.meta.host || 'session').replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
  const { filename, bytes } = buildCloneBundle({
    staticSource: record,
    mockSource: record,
    label: `Local clone of session ${record.id.slice(0, 8)} (${record.summary.meta.host || 'no host'})`,
    filenameStem: `clone-${safeHost}-${record.id.slice(0, 8)}`,
  })
  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/projects/:host/api/mock', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host },
    },
  }
  const { filename, body } = generateMockServer(synthetic)
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/projects/:host/heatmap', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.html(LoginPage(), 404)
  const pages = buildProjectHeatmaps(sessions)
  return c.html(ProjectHeatmapPage({ email, host, pages }))
})

app.get('/projects/:host/graph', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.html(LoginPage(), 404)
  const graph = buildProjectGraph(sessions)
  return c.html(ProjectGraphPage({ email, host, graph }))
})

app.get('/projects/:host/narrative', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.html(LoginPage(), 404)
  const digest = aggregateProject(host, sessions)
  try {
    // Cache-only read: don't pay for Gemini on a GET. Empty result renders
    // the "generate" CTA so the user opts in explicitly.
    const cached = c.env.SESSIONS
      ? ((await c.env.SESSIONS.get(`narrative:${email}:${host}`, 'json').catch(() => null)) as
          | Awaited<ReturnType<typeof loadOrGenerateNarrative>>
          | null)
      : null
    const narrative =
      cached &&
      cached.sessionCount === digest.sessionCount &&
      cached.latestUploadedAt === digest.lastCapturedAt
        ? cached
        : undefined
    return c.html(ProjectNarrativePage({ email, host, ...(narrative ? { narrative } : {}) }))
  } catch (e) {
    return c.html(ProjectNarrativePage({ email, host, error: String(e) }))
  }
})

app.post('/projects/:host/narrative/regenerate', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.html(LoginPage(), 404)
  const digest = aggregateProject(host, sessions)
  const latestSession = [...sessions].sort((a, b) => b.uploadedAt - a.uploadedAt)[0]!
  try {
    const narrative = await loadOrGenerateNarrative({
      env: c.env,
      email,
      digest,
      latestSession,
      forceRegenerate: true,
    })
    return c.html(ProjectNarrativePage({ email, host, narrative }))
  } catch (e) {
    return c.html(ProjectNarrativePage({ email, host, error: String(e) }))
  }
})

app.get('/projects/:host/openapi.json', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const digest = aggregateProject(host, sessions)
  const { filename, body } = buildOpenApiFromProject(digest)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/projects/:host/postman.json', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const digest = aggregateProject(host, sessions)
  const { filename, body } = buildPostmanFromProject(digest)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/openapi.json', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const { filename, body } = buildOpenApiFromSession(record)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/postman.json', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const { filename, body } = buildPostmanFromSession(record)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/graphql.txt', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const artifact = extractGraphqlOperations(record)
  if (!artifact) return c.json(err('No GraphQL traffic in this session'), 404)
  return new Response(artifact.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${artifact.filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/static.zip', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const { filename, bytes } = buildStaticMirrorZip(record)
  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/sessions/:id/compare/:otherId', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const id = c.req.param('id')
  const otherId = c.req.param('otherId')
  if (id === otherId) return c.redirect(`/sessions/${id}`, 302)
  const [baseline, current] = await Promise.all([
    getStoredSession(c.env, email, otherId),
    getStoredSession(c.env, email, id),
  ])
  if (!baseline || !current) return c.html(LoginPage(), 404)
  const diff = diffSessions(baseline, current)
  let visual: Awaited<ReturnType<typeof computeCrossSessionVisualDiff>> | null = null
  try {
    visual = await computeCrossSessionVisualDiff(
      c.env,
      { email, ownerSessionId: current.id },
      baseline,
      current,
    )
  } catch (e) {
    console.warn('[unwrap-server] cross-session visual diff failed', e)
  }
  return c.html(ComparePage({ email, diff, visual, currentSessionId: current.id, baselineSessionId: baseline.id }))
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
