import type { SessionListItem } from '@unwrap/protocol'
import { Layout } from './_layout'
import { groupSessionsByHost } from '../project-aggregate'
import { Card, CardContent, CardHeader, CardTitle } from '@unwrap/ui'
import { Badge } from '@unwrap/ui'
import { Button } from '@unwrap/ui'

export function LoginPage() {
  const features: { icon: string; title: string; body: string }[] = [
    { icon: '🔍', title: 'Analyze', body: 'Aggregated route map, API inventory with TS types, GraphQL ops, page → API dependency graph, code coverage, WebSocket inventory.' },
    { icon: '🧪', title: 'Test', body: 'AI-generated Playwright specs per session. Test coverage gap analysis. Canonical suite exports as a CI-ready Playwright project.' },
    { icon: '🛡', title: 'Audit', body: 'Security findings, runtime AX-tree accessibility, performance percentiles + N+1 detection.' },
    { icon: '📦', title: 'Export', body: 'OpenAPI 3.0. Postman v2.1. Stateful Node.js mock server. Runnable clone bundle with frontend + mock + run.sh.' },
    { icon: '🔌', title: 'Integrate', body: 'GitHub App posts PR comments with surface diff. CLI captures from CI. Sentry correlation. Linear issue filing. Slack regression pings.' },
    { icon: '🤖', title: 'AI', body: 'Gemini writes a service brief from screenshots + API surface + actions. Proposes a test plan from coverage gaps. Auto-repairs broken selectors.' },
  ]
  return (
    <Layout>
      <div className="text-center py-12">
        <h1 className="text-5xl font-bold m-0">Unwrap</h1>
        <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
          Capture a browser session. Get every analysis, test, and integration artifact a service
          reverse-engineer or QA engineer would build by hand — without building any of them.
        </p>
        <div className="mt-6">
          <Button asChild>
            <a href="/auth/google/start?mode=web">Sign in with Google →</a>
          </Button>
        </div>
      </div>
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
        {features.map((f) => (
          <Card key={f.title}>
            <CardHeader>
              <div className="text-xl">{f.icon}</div>
              <CardTitle>{f.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="m-0 text-xs text-muted-foreground leading-relaxed">{f.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </Layout>
  )
}

export function SessionsPage({ email, sessions }: { email: string; sessions: SessionListItem[] }) {
  const projects = groupSessionsByHost(sessions.map((s) => ({ host: s.host, uploadedAt: s.uploadedAt })))
  return (
    <Layout email={email}>
      {projects.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3">Projects</h2>
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {projects.map((p) => (
              <a key={p.host} href={`/projects/${encodeURIComponent(p.host)}`} className="no-underline text-foreground">
                <Card className="hover:border-primary transition-colors">
                  <CardContent className="p-4">
                    <div className="font-semibold text-sm mb-1">{p.host || '(no host)'}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} · last {relativeTime(p.latestUploadedAt)}
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold m-0">Uploaded sessions</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
      </div>

      {sessions.length === 0
        ? <Onboarding />
        : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <Card key={s.id}>
                <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="m-0 mb-1 text-sm font-semibold">
                      <a href={`/sessions/${s.id}`} className="text-foreground hover:text-primary">{s.host || '(no host)'}</a>
                    </h3>
                    <div className="text-xs text-muted-foreground truncate" title={s.startUrl}>{truncate(s.startUrl, 70)}</div>
                    <div className="text-xs text-muted-foreground">
                      uploaded {relativeTime(s.uploadedAt)} · duration {formatDuration(s.durationMs)}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {s.regressionLevel && s.regressionBaselineId
                      ? (
                        <a href={`/sessions/${s.id}/compare/${s.regressionBaselineId}`} title={`${s.regressionHeadline ?? ''} (vs previous capture)`} className="no-underline">
                          <Badge variant={regressionVariant(s.regressionLevel)}>
                            {regressionGlyph(s.regressionLevel)} {regressionLabel(s.regressionLevel)}
                          </Badge>
                        </a>
                      )
                      : null}
                    {s.verificationStatus === 'pass' && <Badge variant="success">✓ verified</Badge>}
                    {s.verificationStatus === 'fail' && <Badge variant="danger">✗ replay fail</Badge>}
                    {s.verificationStatus === 'error' && <Badge variant="danger">⚠ replay error</Badge>}
                    {s.hasGeneratedSpec ? <Badge variant="success">spec</Badge> : <Badge variant="muted">no spec</Badge>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
    </Layout>
  )
}

function Onboarding() {
  return (
    <Card>
      <CardContent className="p-6">
        <h3 className="m-0 mb-2 text-base font-semibold">Welcome — let's capture your first session</h3>
        <p className="text-xs text-muted-foreground m-0 mb-3">Two paths:</p>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
          <Card>
            <CardContent className="p-4">
              <div className="text-xl mb-2">🖱</div>
              <h4 className="m-0 mb-2 text-sm font-semibold">Interactive (Chrome extension)</h4>
              <ol className="my-0 pl-5 text-xs space-y-1.5 leading-relaxed">
                <li>Build + load the Unwrap extension (<code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">pnpm --filter @unwrap/extension build</code> → load <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">apps/extension/dist</code> at <a href="chrome://extensions" className="text-primary">chrome://extensions</a>).</li>
                <li>Open the side panel on any page you want to analyze.</li>
                <li>Click Record. Use the site normally. Click Stop. The session uploads here automatically.</li>
              </ol>
              <p className="m-0 mt-2 text-[11px] text-muted-foreground">Captures everything: clicks, network, DOM, screenshots, AX trees, coverage, WebSockets.</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-xl mb-2">🤖</div>
              <h4 className="m-0 mb-2 text-sm font-semibold">Headless (CI / scripts)</h4>
              <ol className="my-0 pl-5 text-xs space-y-1.5 leading-relaxed">
                <li>Mint a token at <a href="/settings/tokens" className="text-primary">Settings → API tokens</a>.</li>
                <li>Run <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">npx @unwrap/cli capture --server=&lt;origin&gt; --token=&lt;token&gt; &lt;urls...&gt;</code>.</li>
                <li>The CLI uploads here when done.</li>
              </ol>
              <p className="m-0 mt-2 text-[11px] text-muted-foreground">Lighter than the extension (no clicks/DOM/AX/coverage) but enough for surface change detection. <a href="/settings/integrations" className="text-primary">Add the GitHub App</a> for auto PR comments.</p>
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  )
}

function regressionVariant(l: 'pass' | 'minor' | 'fail') {
  return l === 'pass' ? 'success' : l === 'minor' ? 'warning' : 'danger'
}
function regressionGlyph(l: 'pass' | 'minor' | 'fail') {
  return l === 'pass' ? '✓' : l === 'minor' ? '⚠' : '✗'
}
function regressionLabel(l: 'pass' | 'minor' | 'fail') {
  return l === 'pass' ? 'no regression' : l === 'minor' ? 'changed' : 'regression'
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}
function relativeTime(ts: number) {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

