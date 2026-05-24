import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ssr } from './ssr'
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
import { compareProjects } from './project-compare'
import { ProjectComparePage } from './pages/project-compare'
import { aggregateCoverage } from './project-coverage'
import { ProjectCoveragePage } from './pages/project-coverage'
import { aggregateWsChannels } from './project-websockets'
import { ProjectWebSocketsPage } from './pages/project-websockets'
import { searchSessions } from './search'
import { SearchPage } from './pages/search'
import { listApiTokens, mintApiToken, revokeApiToken } from './storage/api-tokens'
import { ApiTokensPage } from './pages/api-tokens'
import { IntegrationsPage } from './pages/integrations'
import { analyzeProjectSecurity } from './project-security'
import { ProjectSecurityPage } from './pages/project-security'
import { aggregateA11y } from './project-a11y'
import { ProjectA11yPage } from './pages/project-a11y'
import { analyzeProjectPerformance } from './project-performance'
import { ProjectPerformancePage } from './pages/project-performance'
import { analyzeTestCoverage } from './test-coverage'
import { TestCoveragePage } from './pages/test-coverage'
import { loadOrGenerateTestPlan, readCachedTestPlan } from './project-test-plan'
import { TestPlanPage } from './pages/test-plan'
import { buildSessionPrComment } from './pr-comment'
import { setSentryConfig, getSentryConfig, deleteSentryConfig } from './storage/sentry-config'
import { correlateSentryIssuesWithSessions, fetchRecentSentryIssues } from './sentry'
import { ProjectSentryPage } from './pages/project-sentry'
import { setLinearConfig, getLinearConfig, deleteLinearConfig } from './storage/linear-config'
import { createLinearIssue } from './linear'
import { setSlackConfig, getSlackConfig, deleteSlackConfig } from './storage/slack-config'
import { postSlackMessage } from './slack'
import { ProjectIntegrationsPage } from './pages/project-integrations'
import {
  appendTestRun,
  listRecentTestRuns,
  newTestRunId,
} from './storage/test-runs'
import { normalizeTestRunIngest } from './test-result-ingest'
import { analyzeTestStability } from './test-run-analysis'
import { TestRunsPage } from './pages/test-runs'
import { repairSpec } from './spec-repair'
import { SpecRepairPage } from './pages/spec-repair'
import {
  forgetInstallation,
  getInstallation,
  postOrUpdateCommentAsApp,
  rememberInstallation,
  verifyWebhookSignature,
  type InstallationRecord,
} from './github-app'
import {
  addCanonicalTest,
  listCanonicalTests,
  removeCanonicalTest,
} from './storage/canonical-tests'
import { buildTestSuiteBundle } from './test-suite-bundle'
import { TestSuitePage } from './pages/test-suite'
import {
  getOrCreateShareToken,
  readShareToken,
  resolveShareToken,
  revokeShareToken,
} from './storage/share'
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

  // Slack notify (fire-and-forget — never block the upload on it).
  void notifySlackForUpload(c.env, email, record, url).catch((e) => {
    console.warn('[unwrap-server] slack notify failed', e)
  })

  return c.json<UploadSessionResponse>({ id, url })
})

// Posts to the configured Slack webhook for the project if the user has
// notifyOnRegression on and this upload triggered a regression, or
// notifyOnFirstCapture on and this is the first capture for the host.
async function notifySlackForUpload(
  env: Env,
  email: string,
  record: StoredSession,
  sessionUrl: string,
): Promise<void> {
  const host = record.summary.meta.host
  const cfg = await getSlackConfig(env, email, host)
  if (!cfg) return
  const reg = record.regression
  const isRegression = reg && reg.level !== 'pass'
  if (!cfg.notifyOnFirstCapture && !isRegression) return
  // We treat "no baseline + notifyOnFirstCapture" as the first-capture
  // signal — the regression code returns no record when there's no
  // baseline.
  const isFirstCapture = !reg && cfg.notifyOnFirstCapture
  if (!isFirstCapture && !isRegression) return

  const title = isRegression
    ? `${reg.level === 'fail' ? '🚨' : '⚠️'} Regression detected on ${host}`
    : `📸 New Unwrap capture for ${host}`
  const text = isRegression
    ? reg.headline
    : `${record.summary.navigations.length} nav${record.summary.navigations.length === 1 ? '' : 's'}, ${record.summary.apiCalls?.length ?? 0} API call${record.summary.apiCalls?.length === 1 ? '' : 's'} captured.`
  const fields = isRegression
    ? [
        ...(reg.networkOnlyInCurrent > 0 ? [{ name: 'New endpoints', value: String(reg.networkOnlyInCurrent) }] : []),
        ...(reg.networkOnlyInBaseline > 0 ? [{ name: 'Missing endpoints', value: String(reg.networkOnlyInBaseline) }] : []),
        ...(reg.networkStatusChanges > 0 ? [{ name: 'Status changes', value: String(reg.networkStatusChanges) }] : []),
        ...(reg.consoleErrorDelta !== 0 ? [{ name: 'Console error delta', value: (reg.consoleErrorDelta > 0 ? '+' : '') + String(reg.consoleErrorDelta) }] : []),
      ]
    : []
  await postSlackMessage(cfg, {
    title,
    text,
    ...(fields.length > 0 ? { fields } : {}),
    link: { text: 'Open session in Unwrap', url: sessionUrl },
  })
}

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
  return new Response(bytes as BodyInit, {
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
  if (!email) return ssr(<LoginPage />, { title: 'Sign in' })
  return c.redirect('/sessions', 302)
})

app.get('/sessions', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  await backfillRegressions(c.env, email)
  const sessions = await listSessions(c.env, email)
  return ssr(<SessionsPage email={email} sessions={sessions} />, { title: 'Sessions' })
})

// ---------- API tokens (long-lived bearer for CLI / CI) ----------

app.get('/settings/integrations', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  // List installations by scanning the KV namespace. For now we list ALL
  // installations the server has seen — once we add a per-user claim
  // step we'll filter to "yours."
  const installations: InstallationRecord[] = []
  if (c.env.SESSIONS) {
    let cursor: string | undefined
    do {
      const page = await c.env.SESSIONS.list({ prefix: 'github-installation:', cursor })
      for (const k of page.keys) {
        // Skip the cached-token entries which use a different prefix.
        if (k.name.startsWith('github-installation-token:') || k.name.startsWith('github-installation-by-repo:')) continue
        const raw = await c.env.SESSIONS.get(k.name, 'json')
        if (raw) installations.push(raw as InstallationRecord)
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
  }
  return ssr(<IntegrationsPage {...({
    email,
    installations,
    origin: originOf(c.req.url),
    ...(c.env.GITHUB_APP_SLUG ? { appSlug: c.env.GITHUB_APP_SLUG } : {}),
  })} />, { title: "Integrations" })
})

app.get('/settings/tokens', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const tokens = await listApiTokens(c.env, email)
  return ssr(<ApiTokensPage {...({ email, tokens, origin: originOf(c.req.url) })} />, { title: "API tokens" })
})

app.post('/api/tokens', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.json(err('Not authenticated'), 401)
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const labelRaw = form['label']
  const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim() : 'unnamed'
  const fresh = await mintApiToken(c.env, email, label)
  // If the request came from the settings page form, show the page again
  // with the new token highlighted so the user can copy it. JSON callers
  // (HTTP clients) get the JSON directly.
  if ((c.req.header('accept') ?? '').includes('text/html')) {
    const tokens = await listApiTokens(c.env, email)
    return ssr(<ApiTokensPage {...({ email, tokens, freshlyMinted: fresh, origin: originOf(c.req.url) })} />, { title: "API tokens" })
  }
  return c.json(fresh)
})

app.post('/api/tokens/:token/revoke', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const token = c.req.param('token')
  await revokeApiToken(c.env, email, token)
  if ((c.req.header('accept') ?? '').includes('text/html')) {
    return c.redirect('/settings/tokens', 302)
  }
  return c.json({ revoked: true })
})

app.get('/search', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const query = (c.req.query('q') ?? '').trim()
  if (query === '') {
    return ssr(<SearchPage {...({ email, query: '', results: [] })} />, { title: "Search" })
  }
  const items = await listSessions(c.env, email)
  // Load full session records — we need their summaries to scan content.
  // Cap to the 200 most recent to keep page time bounded if a user has
  // accumulated many; older captures still surface via project pages.
  const recent = items.slice(0, 200)
  const sessions = (await Promise.all(
    recent.map((s) => getStoredSession(c.env, email, s.id)),
  )).filter((r): r is StoredSession => r !== null)
  const results = searchSessions(query, sessions)
  return ssr(<SearchPage {...({ email, query, results })} />, { title: "Search" })
})

app.get('/sessions/:id', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const id = c.req.param('id')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  // List of other sessions sharing the same host (for the Compare dropdown)
  const allSessions = await listSessions(c.env, email)
  const otherSameHost = allSessions
    .filter((s) => s.id !== id && s.host === record.summary.meta.host)
    .slice(0, 10)
  const canonical = await listCanonicalTests(c.env, email, record.summary.meta.host)
  const isCanonical = canonical.some((c) => c.sessionId === id)
  return ssr(<SessionDetailPage email={email} session={record} otherSameHost={otherSameHost} isCanonical={isCanonical} />, { title: record.summary.meta.host || 'Session' })
})

app.get('/sessions/:id/api', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  return ssr(<ApiInventoryPage {...({ email, session: record })} />, { title: "API inventory" })
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
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const digest = aggregateProject(host, sessions)
  const items = await listSessions(c.env, email)
  const otherHosts = [...new Set(items.map((s) => s.host).filter((h) => h && h !== host))].sort()
  const existingToken = await readShareToken(c.env, email, host)
  const shareUrl = existingToken
    ? { url: `${originOf(c.req.url)}/share/${existingToken}`, createdAt: 0 }
    : null
  return ssr(<ProjectPage email={email} digest={digest} otherHosts={otherHosts} shareUrl={shareUrl} />, { title: `Project · ${digest.host}` })
})

// ---------- Share links ----------

app.post('/projects/:host/share', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  await getOrCreateShareToken(c.env, email, host)
  return c.redirect(`/projects/${encodeURIComponent(host)}`, 302)
})

app.post('/projects/:host/share/revoke', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  await revokeShareToken(c.env, email, host)
  return c.redirect(`/projects/${encodeURIComponent(host)}`, 302)
})

// Anonymous resolver — used by every /share/:token/* route. Returns the
// resolved (email, host) pair so the routes can reuse loadProjectSessions
// against the OWNER's email even though the caller isn't signed in.
async function resolveShare(env: Env, token: string): Promise<{ email: string; host: string } | null> {
  const rec = await resolveShareToken(env, token)
  if (!rec) return null
  return { email: rec.email, host: rec.host }
}

app.get('/share/:token', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const digest = aggregateProject(r.host, sessions)
  return ssr(<ProjectPage email="" digest={digest} share={{ token: c.req.param('token') }} />, { title: `Project · ${digest.host}` })
})

app.get('/share/:token/graph', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const graph = buildProjectGraph(sessions)
  return ssr(<ProjectGraphPage {...({ email: '', host: r.host, graph })} />, { title: "Dependency graph" })
})

app.get('/share/:token/coverage', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const coverage = aggregateCoverage(sessions)
  return ssr(<ProjectCoveragePage {...({ email: '', host: r.host, coverage })} />, { title: "Coverage" })
})

app.get('/share/:token/heatmap', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const pages = buildProjectHeatmaps(sessions)
  return ssr(<ProjectHeatmapPage {...({ email: '', host: r.host, pages })} />, { title: "Heatmap" })
})

app.get('/share/:token/websockets', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const channels = aggregateWsChannels(sessions)
  return ssr(<ProjectWebSocketsPage {...({ email: '', host: r.host, channels })} />, { title: "WebSockets" })
})

app.get('/share/:token/security', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = analyzeProjectSecurity(r.host, sessions)
  return ssr(<ProjectSecurityPage {...({ email: '', report })} />, { title: "Security" })
})

app.get('/share/:token/narrative', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const digest = aggregateProject(r.host, sessions)
  const cached = c.env.SESSIONS
    ? ((await c.env.SESSIONS.get(`narrative:${r.email}:${r.host}`, 'json').catch(() => null)) as
        | Awaited<ReturnType<typeof loadOrGenerateNarrative>>
        | null)
    : null
  const narrative =
    cached &&
    cached.sessionCount === digest.sessionCount &&
    cached.latestUploadedAt === digest.lastCapturedAt
      ? cached
      : undefined
  return ssr(<ProjectNarrativePage {...({ email: '', host: r.host, ...(narrative ? { narrative } : {}) })} />, { title: "Narrative" })
})

app.get('/share/:token/openapi.json', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const digest = aggregateProject(r.host, sessions)
  const { filename, body } = buildOpenApiFromProject(digest)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/share/:token/postman.json', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const digest = aggregateProject(r.host, sessions)
  const { filename, body } = buildPostmanFromProject(digest)
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/share/:token/graphql.txt', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${r.host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host: r.host },
    },
  }
  const artifact = extractGraphqlOperations(synthetic)
  if (!artifact) return c.json(err('No GraphQL traffic'), 404)
  return new Response(artifact.body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${artifact.filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/share/:token/api/mock', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${r.host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host: r.host },
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

app.get('/share/:token/clone.zip', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const mostRecent = [...sessions].sort((a, b) => b.uploadedAt - a.uploadedAt)[0]!
  const allCalls = sessions.flatMap((s) => s.summary.apiCalls ?? [])
  const synthetic: StoredSession = {
    ...sessions[0]!,
    id: `project-${r.host}`,
    summary: {
      ...sessions[0]!.summary,
      apiCalls: allCalls,
      meta: { ...sessions[0]!.summary.meta, host: r.host },
    },
  }
  const safeHost = r.host.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
  const { filename, bytes } = buildCloneBundle({
    staticSource: mostRecent,
    mockSource: synthetic,
    label: `Local clone of ${r.host}`,
    filenameStem: `clone-${safeHost}`,
  })
  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
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
  return new Response(bytes as BodyInit, {
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
  return new Response(bytes as BodyInit, {
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

app.get('/projects/:host/tests', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const canonical = await listCanonicalTests(c.env, email, host)
  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const canonicalIds = new Set(canonical.map((c) => c.sessionId))
  const candidates = sessions
    .filter((s) => !!s.generated?.spec && !canonicalIds.has(s.id))
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
    .map((s) => ({ sessionId: s.id, uploadedAt: s.uploadedAt }))
  return ssr(<TestSuitePage {...({ email, host, canonical, sessionsById, candidates })} />, { title: "Canonical tests" })
})

app.post('/projects/:host/tests', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const sessionId = typeof form['sessionId'] === 'string' ? form['sessionId'] : ''
  const name = typeof form['name'] === 'string' && form['name'].trim() ? form['name'].trim() : ''
  const tagsRaw = typeof form['tags'] === 'string' ? form['tags'] : ''
  if (!sessionId || !name) return c.redirect(`/projects/${encodeURIComponent(host)}/tests`, 302)
  const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
  await addCanonicalTest(c.env, email, host, { sessionId, name, tags })
  return c.redirect(`/projects/${encodeURIComponent(host)}/tests`, 302)
})

app.post('/projects/:host/tests/:sessionId/remove', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessionId = c.req.param('sessionId')
  await removeCanonicalTest(c.env, email, host, sessionId)
  return c.redirect(`/projects/${encodeURIComponent(host)}/tests`, 302)
})

app.get('/projects/:host/tests.zip', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const canonical = await listCanonicalTests(c.env, email, host)
  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const { filename, bytes, testCount } = buildTestSuiteBundle({ host, canonical, sessionsById })
  if (testCount === 0) return c.json(err('No canonical specs in the suite'), 404)
  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

app.get('/share/:token/tests', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const canonical = await listCanonicalTests(c.env, r.email, r.host)
  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  return ssr(<TestSuitePage {...({ email: '', host: r.host, canonical, sessionsById, candidates: [], share: { token: c.req.param('token') } })} />, { title: "Canonical tests" })
})

app.get('/share/:token/tests.zip', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return c.json(err('Not found'), 404)
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return c.json(err('Not found'), 404)
  const canonical = await listCanonicalTests(c.env, r.email, r.host)
  const sessionsById = new Map(sessions.map((s) => [s.id, s]))
  const { filename, bytes, testCount } = buildTestSuiteBundle({ host: r.host, canonical, sessionsById })
  if (testCount === 0) return c.json(err('No canonical specs in the suite'), 404)
  return new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  })
})

// ---------- Per-project integrations (Linear / Slack / Sentry shortcut) ----

// ---------- Test execution feedback ----------

// CI POSTs Playwright JSON reporter output (or a flat specs array) here
// — authenticated with the standard Unwrap API token. We normalize,
// store, and surface stability rollups on the project's test-runs page.
// ---------- Spec auto-repair ----------

app.get('/sessions/:id/repair', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const id = c.req.param('id')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const spec = record.generated?.spec
  if (!spec) {
    return ssr(<SpecRepairPage email={email} sessionId={id} originalSpec="" error="This session has no generated spec — generate one from the session detail page first." />, { title: 'Spec repair' })
  }
  return ssr(<SpecRepairPage email={email} sessionId={id} originalSpec={spec} />, { title: 'Spec repair' })
})

app.post('/sessions/:id/repair', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const id = c.req.param('id')
  const record = await getStoredSession(c.env, email, id)
  if (!record) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const spec = record.generated?.spec
  if (!spec) {
    return ssr(<SpecRepairPage email={email} sessionId={id} originalSpec="" error="This session has no generated spec." />, { title: 'Spec repair' })
  }
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const errorMessage = typeof form['errorMessage'] === 'string' ? (form['errorMessage'] as string) : ''
  const sessions = await loadProjectSessions(c.env, email, record.summary.meta.host)
  try {
    const result = await repairSpec({
      env: c.env,
      originalSpec: spec,
      errorMessage,
      sessions,
    })
    return ssr(<SpecRepairPage {...({ email, sessionId: id, originalSpec: spec, result })} />, { title: "Spec repair" })
  } catch (e) {
    return ssr(<SpecRepairPage {...({ email, sessionId: id, originalSpec: spec, error: String(e) })} />, { title: "Spec repair" })
  }
})

app.post('/api/test-results', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.json(err('Not authenticated'), 401)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(err('Body must be JSON'), 400)
  }
  const normalized = normalizeTestRunIngest(body)
  if ('error' in normalized) return c.json(err(normalized.error), 400)
  const id = newTestRunId()
  const run = { id, ...normalized }
  await appendTestRun(c.env, email, run.host, run)
  return c.json({ id, host: run.host, totals: run.totals })
})

app.get('/projects/:host/test-runs', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const runs = await listRecentTestRuns(c.env, email, host, 50)
  const stability = analyzeTestStability(runs)
  return ssr(<TestRunsPage {...({
    email,
    host,
    runs,
    stability,
    ingestPath: `${originOf(c.req.url)}/api/test-results`,
  })} />, { title: "Test runs" })
})

app.get('/projects/:host/integrations', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const [linear, slack, sentry] = await Promise.all([
    getLinearConfig(c.env, email, host),
    getSlackConfig(c.env, email, host),
    getSentryConfig(c.env, email, host),
  ])
  return ssr(<ProjectIntegrationsPage {...({ email, host, linear, slack, sentry })} />, { title: "Project integrations" })
})

app.post('/projects/:host/integrations/linear', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '')
  const apiKey = get('apiKey')
  const teamId = get('teamId')
  const teamKey = get('teamKey')
  if (!apiKey || !teamId) return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
  await setLinearConfig(c.env, email, host, { apiKey, teamId, ...(teamKey ? { teamKey } : {}) })
  return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
})

app.post('/projects/:host/integrations/linear/disconnect', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  await deleteLinearConfig(c.env, email, host)
  return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
})

// Create a Linear issue from a finding. The caller (typically the
// security / a11y / performance page rendered with a button) POSTs the
// finding's title + description; we attach a link back to the report.
app.post('/projects/:host/integrations/linear/issue', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.json(err('Not authenticated'), 401)
  const host = decodeURIComponent(c.req.param('host'))
  const cfg = await getLinearConfig(c.env, email, host)
  if (!cfg) return c.json(err('Linear not connected for this project'), 400)
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; description?: string; sourcePath?: string }
  if (!body.title) return c.json(err('title required'), 400)
  const sourceLink = body.sourcePath
    ? `\n\n---\n[View finding in Unwrap](${originOf(c.req.url)}${body.sourcePath})`
    : ''
  try {
    const issue = await createLinearIssue(cfg, {
      title: body.title,
      description: (body.description ?? '') + sourceLink,
    })
    return c.json(issue)
  } catch (e) {
    return c.json(err('Linear create-issue failed', String(e)), 500)
  }
})

app.post('/projects/:host/integrations/slack', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const webhookUrl = typeof form['webhookUrl'] === 'string' ? (form['webhookUrl'] as string).trim() : ''
  if (!webhookUrl) return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
  await setSlackConfig(c.env, email, host, {
    webhookUrl,
    notifyOnRegression: form['notifyOnRegression'] === 'on',
    notifyOnFirstCapture: form['notifyOnFirstCapture'] === 'on',
  })
  return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
})

app.post('/projects/:host/integrations/slack/disconnect', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  await deleteSlackConfig(c.env, email, host)
  return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
})

app.post('/projects/:host/integrations/slack/test', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const cfg = await getSlackConfig(c.env, email, host)
  if (!cfg) return c.redirect(`/projects/${encodeURIComponent(host)}/integrations`, 302)
  try {
    await postSlackMessage(cfg, {
      title: `✅ Unwrap test message — ${host}`,
      text: 'If you see this in your channel, the webhook is wired up.',
      link: { text: `Open ${host} project`, url: `${originOf(c.req.url)}/projects/${encodeURIComponent(host)}` },
    })
    return c.redirect(`/projects/${encodeURIComponent(host)}/integrations?msg=Test+message+sent`, 302)
  } catch (e) {
    return c.redirect(`/projects/${encodeURIComponent(host)}/integrations?err=${encodeURIComponent(String(e))}`, 302)
  }
})

app.get('/projects/:host/sentry', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const config = await getSentryConfig(c.env, email, host)
  if (!config) return ssr(<ProjectSentryPage {...({ email, host, config: null, correlations: [] })} />, { title: "Sentry" })
  try {
    const issues = await fetchRecentSentryIssues(config, 50)
    const correlations = correlateSentryIssuesWithSessions(issues, sessions)
    return ssr(<ProjectSentryPage {...({ email, host, config, correlations })} />, { title: "Sentry" })
  } catch (e) {
    return ssr(<ProjectSentryPage {...({ email, host, config, correlations: [], error: String(e) })} />, { title: "Sentry" })
  }
})

app.post('/projects/:host/sentry/config', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File | undefined>
  const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '')
  const org = get('org')
  const project = get('project')
  const apiToken = get('apiToken')
  const baseUrl = get('baseUrl')
  if (!org || !project || !apiToken) return c.redirect(`/projects/${encodeURIComponent(host)}/sentry`, 302)
  await setSentryConfig(c.env, email, host, { org, project, apiToken, ...(baseUrl ? { baseUrl } : {}) })
  return c.redirect(`/projects/${encodeURIComponent(host)}/sentry`, 302)
})

app.post('/projects/:host/sentry/disconnect', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  await deleteSentryConfig(c.env, email, host)
  return c.redirect(`/projects/${encodeURIComponent(host)}/sentry`, 302)
})

app.get('/projects/:host/test-plan', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const cached = await readCachedTestPlan(c.env, email, host)
  if (cached) return ssr(<TestPlanPage {...({ email, host, plan: cached })} />, { title: "Test plan" })
  return ssr(<TestPlanPage {...({ email, host })} />, { title: "Test plan" })
})

app.post('/projects/:host/test-plan/regenerate', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const canonical = await listCanonicalTests(c.env, email, host)
  try {
    const plan = await loadOrGenerateTestPlan({
      env: c.env,
      email,
      host,
      sessions,
      canonicalCount: canonical.length,
      forceRegenerate: true,
    })
    return ssr(<TestPlanPage {...({ email, host, plan })} />, { title: "Test plan" })
  } catch (e) {
    return ssr(<TestPlanPage {...({ email, host, error: String(e) })} />, { title: "Test plan" })
  }
})

app.get('/share/:token/test-plan', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const cached = await readCachedTestPlan(c.env, r.email, r.host)
  return ssr(<TestPlanPage {...({ email: '', host: r.host, ...(cached ? { plan: cached } : {}) })} />, { title: "Test plan" })
})

app.get('/projects/:host/test-coverage', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const coverage = analyzeTestCoverage(sessions)
  return ssr(<TestCoveragePage {...({ email, host, coverage })} />, { title: "Test coverage" })
})

app.get('/share/:token/test-coverage', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const coverage = analyzeTestCoverage(sessions)
  return ssr(<TestCoveragePage {...({ email: '', host: r.host, coverage })} />, { title: "Test coverage" })
})

app.get('/projects/:host/performance', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = analyzeProjectPerformance(host, sessions)
  return ssr(<ProjectPerformancePage {...({ email, host, report })} />, { title: "Performance" })
})

app.get('/share/:token/performance', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = analyzeProjectPerformance(r.host, sessions)
  return ssr(<ProjectPerformancePage {...({ email: '', host: r.host, report })} />, { title: "Performance" })
})

app.get('/projects/:host/a11y', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = aggregateA11y(host, sessions)
  return ssr(<ProjectA11yPage {...({ email, host, report })} />, { title: "Accessibility" })
})

app.get('/share/:token/a11y', async (c) => {
  const r = await resolveShare(c.env, c.req.param('token'))
  if (!r) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const sessions = await loadProjectSessions(c.env, r.email, r.host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = aggregateA11y(r.host, sessions)
  return ssr(<ProjectA11yPage {...({ email: '', host: r.host, report })} />, { title: "Accessibility" })
})

app.get('/projects/:host/security', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const report = analyzeProjectSecurity(host, sessions)
  const linearConnected = !!(await getLinearConfig(c.env, email, host))
  return ssr(<ProjectSecurityPage {...({ email, report, linearConnected })} />, { title: "Security" })
})

app.get('/projects/:host/websockets', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const channels = aggregateWsChannels(sessions)
  return ssr(<ProjectWebSocketsPage {...({ email, host, channels })} />, { title: "WebSockets" })
})

app.get('/projects/:host/coverage', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const coverage = aggregateCoverage(sessions)
  return ssr(<ProjectCoveragePage {...({ email, host, coverage })} />, { title: "Coverage" })
})

app.get('/projects/:host/diff/:otherHost', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const leftHost = decodeURIComponent(c.req.param('host'))
  const rightHost = decodeURIComponent(c.req.param('otherHost'))
  const [leftSessions, rightSessions] = await Promise.all([
    loadProjectSessions(c.env, email, leftHost),
    loadProjectSessions(c.env, email, rightHost),
  ])
  if (leftSessions.length === 0 || rightSessions.length === 0) {
    return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  }
  const left = aggregateProject(leftHost, leftSessions)
  const right = aggregateProject(rightHost, rightSessions)
  const diff = compareProjects(left, right)
  return ssr(<ProjectComparePage {...({ email, diff })} />, { title: "Compare projects" })
})

app.get('/projects/:host/heatmap', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const pages = buildProjectHeatmaps(sessions)
  return ssr(<ProjectHeatmapPage {...({ email, host, pages })} />, { title: "Heatmap" })
})

app.get('/projects/:host/graph', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
  const graph = buildProjectGraph(sessions)
  return ssr(<ProjectGraphPage {...({ email, host, graph })} />, { title: "Dependency graph" })
})

app.get('/projects/:host/narrative', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
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
    return ssr(<ProjectNarrativePage {...({ email, host, ...(narrative ? { narrative } : {}) })} />, { title: "Narrative" })
  } catch (e) {
    return ssr(<ProjectNarrativePage {...({ email, host, error: String(e) })} />, { title: "Narrative" })
  }
})

app.post('/projects/:host/narrative/regenerate', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.redirect('/', 302)
  const host = decodeURIComponent(c.req.param('host'))
  const sessions = await loadProjectSessions(c.env, email, host)
  if (sessions.length === 0) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
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
    return ssr(<ProjectNarrativePage {...({ email, host, narrative })} />, { title: "Narrative" })
  } catch (e) {
    return ssr(<ProjectNarrativePage {...({ email, host, error: String(e) })} />, { title: "Narrative" })
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

// ---------- GitHub App ----------
// Webhook receiver. Verifies HMAC-SHA256 of the raw body against the App
// webhook secret, then dispatches `installation` and
// `installation_repositories` events into our KV registry. Anything we
// don't recognize is acked with 204 so GitHub doesn't keep retrying.
app.post('/webhooks/github', async (c) => {
  const rawBody = await c.req.text()
  const sig = c.req.header('x-hub-signature-256') ?? ''
  const ok = await verifyWebhookSignature(c.env, rawBody, sig)
  if (!ok) return c.json(err('Invalid signature'), 401)
  const event = c.req.header('x-github-event') ?? ''
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json(err('Bad JSON'), 400)
  }
  if (event === 'installation') {
    await handleInstallationEvent(c.env, payload)
  } else if (event === 'installation_repositories') {
    await handleInstallationRepositoriesEvent(c.env, payload)
  }
  return c.body(null, 204)
})

interface GhInstallation { id: number; account: { login: string; type: 'User' | 'Organization' } }
interface GhInstallationEvent {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted'
  installation: GhInstallation
  repositories?: { full_name: string }[]
}
interface GhInstallationReposEvent {
  action: 'added' | 'removed'
  installation: GhInstallation
  repositories_added?: { full_name: string }[]
  repositories_removed?: { full_name: string }[]
}

async function handleInstallationEvent(env: Env, payload: Record<string, unknown>): Promise<void> {
  const e = payload as unknown as GhInstallationEvent
  if (!e.installation) return
  if (e.action === 'deleted') {
    await forgetInstallation(env, e.installation.id)
    return
  }
  const rec: InstallationRecord = {
    installationId: e.installation.id,
    accountLogin: e.installation.account.login,
    accountType: e.installation.account.type,
    repositories: (e.repositories ?? []).slice(0, 200).map((r) => r.full_name),
    installedAt: Date.now(),
    suspended: e.action === 'suspend',
  }
  await rememberInstallation(env, rec)
}

async function handleInstallationRepositoriesEvent(env: Env, payload: Record<string, unknown>): Promise<void> {
  const e = payload as unknown as GhInstallationReposEvent
  if (!e.installation) return
  // For added/removed events, refresh the full repository list. We model
  // the existing record then mutate — simpler than incremental diff.
  const prior = await getInstallation(env, e.installation.id)
  const repoSet = new Set<string>(prior?.repositories ?? [])
  for (const r of e.repositories_added ?? []) repoSet.add(r.full_name)
  for (const r of e.repositories_removed ?? []) repoSet.delete(r.full_name)
  const rec: InstallationRecord = {
    installationId: e.installation.id,
    accountLogin: e.installation.account.login,
    accountType: e.installation.account.type,
    repositories: [...repoSet],
    installedAt: prior?.installedAt ?? Date.now(),
    suspended: prior?.suspended ?? false,
  }
  await rememberInstallation(env, rec)
}

// Server-side post-as-app: same idempotent comment flow as the CLI's
// PAT path, but using the App's bot identity. Caller authenticates with
// an Unwrap API token; we look up the GitHub installation for the repo,
// mint an installation token, post or PATCH the comment.
app.post('/api/github/comment', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.json(err('Not authenticated'), 401)
  const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; repo?: string; pullNumber?: number }
  if (!body.sessionId || !body.repo || !body.pullNumber) {
    return c.json(err('sessionId, repo, pullNumber required'), 400)
  }
  const record = await getStoredSession(c.env, email, body.sessionId)
  if (!record) return c.json(err('Session not found'), 404)
  const host = record.summary.meta.host
  const items = await listSessions(c.env, email)
  const allIds = items.filter((s) => s.host === host).map((s) => s.id)
  const allRecords = (await Promise.all(allIds.map((id) => getStoredSession(c.env, email, id))))
    .filter((r): r is StoredSession => r !== null)
  const baselineSessions = allRecords.filter((s) => s.uploadedAt < record.uploadedAt)
  const md = buildSessionPrComment({
    origin: originOf(c.req.url),
    current: record,
    baselineSessions,
    currentSessions: [record],
  })
  try {
    const result = await postOrUpdateCommentAsApp({
      env: c.env,
      repo: body.repo,
      pullNumber: body.pullNumber,
      body: md,
    })
    return c.json(result)
  } catch (e) {
    return c.json(err('GitHub comment failed', String(e)), 500)
  }
})

// Returns a markdown PR comment summarizing what changed in this session
// vs. every prior capture of the same host. The CLI fetches this after
// uploading and POSTs it to GitHub (or any other commenter).
app.get('/api/sessions/:id/comment.md', async (c) => {
  const email = await readEmail(c)
  if (!email) return c.json(err('Not authenticated'), 401)
  const record = await getStoredSession(c.env, email, c.req.param('id'))
  if (!record) return c.json(err('Not found'), 404)
  const host = record.summary.meta.host
  const items = await listSessions(c.env, email)
  const allIds = items.filter((s) => s.host === host).map((s) => s.id)
  const allRecords = (await Promise.all(allIds.map((id) => getStoredSession(c.env, email, id))))
    .filter((r): r is StoredSession => r !== null)
  const baselineSessions = allRecords.filter((s) => s.uploadedAt < record.uploadedAt)
  // Compare the JUST-uploaded session against the prior union. Including
  // the current session in `currentSessions` would mask removals because
  // prior captures still contribute their endpoints. The "what changed
  // in this PR" question is per-session, not per-project-snapshot.
  const md = buildSessionPrComment({
    origin: originOf(c.req.url),
    current: record,
    baselineSessions,
    currentSessions: [record],
  })
  return new Response(md, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
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
  return new Response(bytes as BodyInit, {
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
  if (!baseline || !current) return ssr(<LoginPage />, { title: 'Sign in', status: 404 })
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
  return ssr(<ComparePage {...({ email, diff, visual, currentSessionId: current.id, baselineSessionId: baseline.id })} />, { title: "Compare" })
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
