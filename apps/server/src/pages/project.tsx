import * as React from 'react'
import { Layout } from './_layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Select,
  TabsBar,
  cn,
  type TabDef,
} from '@unwrap/ui'
import type { ProjectDigest, EndpointEntry } from '../project-aggregate'
import type { MonitorConfig, MonitorRunSummary } from '../storage/monitor'
import type { LinearConfig } from '../storage/linear-config'
import type { SlackConfig } from '../storage/slack-config'
import type { SentryConfig } from '../storage/sentry-config'
import type { ProjectRepoBinding } from '../storage/project-repo'
import { inferType } from '../schema-infer'
import { buildRouteForest, renderRouteForestHtml } from '../route-tree'

export type ProjectTab = 'overview' | 'tests' | 'monitor' | 'insights' | 'settings'

const PROJECT_TABS: TabDef[] = [
  { key: 'overview', label: 'Overview', hint: 'Sessions + narrative + API surface' },
  { key: 'tests', label: 'Tests', hint: 'Plan, coverage, canonical suite, CI runs' },
  { key: 'monitor', label: 'Monitor', hint: 'Synthetic checks on a cron' },
  { key: 'insights', label: 'Insights', hint: 'Performance, security, a11y, dead code' },
  { key: 'settings', label: 'Settings', hint: 'Integrations, exports, share link' },
]

export interface ProjectPageProps {
  email: string
  digest: ProjectDigest
  otherHosts?: string[]
  share?: { token: string }
  shareUrl?: { url: string; createdAt: number } | null
  activeTab?: ProjectTab
  monitor?: {
    config: MonitorConfig | null
    runs: MonitorRunSummary[]
    slackConfigured: boolean
  }
  integrations?: {
    linear: LinearConfig | null
    slack: SlackConfig | null
    sentry: SentryConfig | null
    repo: ProjectRepoBinding | null
  }
}

export function ProjectPage({
  email,
  digest,
  otherHosts = [],
  share,
  shareUrl,
  activeTab = 'overview',
  monitor,
  integrations,
}: ProjectPageProps) {
  const isShareView = !!share
  const link = (subPath: string) =>
    isShareView
      ? `/share/${share!.token}${subPath}`
      : `/projects/${encodeURIComponent(digest.host)}${subPath}`
  const basePath = link('')
  // Share view hides Settings — there's nothing meaningful to configure
  // from a read-only link.
  const tabs = isShareView ? PROJECT_TABS.filter((t) => t.key !== 'settings') : PROJECT_TABS
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const graphqlEndpoints = digest.endpoints.filter((e) => e.graphql)
  const latestSession = [...digest.sessions].sort((a, b) => b.uploadedAt - a.uploadedAt)[0]
  return (
    <Layout email={email} wide>
      {isShareView
        ? (
          <div className="rounded-lg border bg-primary/5 border-primary/30 px-4 py-2.5 mb-4 text-xs">
            <strong>🔗 Shared read-only view.</strong>
            <span className="text-muted-foreground ml-1">Sign in for full access if you have an Unwrap account.</span>
          </div>
        )
        : <p className="m-0 mb-3"><a href="/" className="text-primary text-sm no-underline hover:underline">← all sessions</a></p>}

      <ProjectHero digest={digest} latestSession={latestSession} link={link} isShareView={isShareView} />

      <div className="mt-6">
        <TabsBar tabs={tabs} activeKey={activeTab} basePath={basePath} />
      </div>

      <div className="mt-6">
        {activeTab === 'overview' && (
          <OverviewTab
            digest={digest}
            link={link}
            isShareView={isShareView}
            restEndpoints={restEndpoints}
            graphqlEndpoints={graphqlEndpoints}
          />
        )}
        {activeTab === 'tests' && <TestsTab link={link} />}
        {activeTab === 'monitor' && <MonitorTab monitor={monitor ?? null} link={link} isShareView={isShareView} />}
        {activeTab === 'insights' && <InsightsTab link={link} />}
        {activeTab === 'settings' && !isShareView && (
          <SettingsTab
            link={link}
            digest={digest}
            shareUrl={shareUrl ?? null}
            integrations={integrations}
            otherHosts={otherHosts}
            restEndpoints={restEndpoints}
          />
        )}
      </div>
    </Layout>
  )
}

// ---------- Hero ----------

function ProjectHero({
  digest,
  latestSession,
  link,
  isShareView,
}: {
  digest: ProjectDigest
  latestSession: ProjectDigest['sessions'][number] | undefined
  link: (p: string) => string
  isShareView: boolean
}) {
  const restCount = digest.endpoints.filter((e) => !e.graphql).length
  const gqlCount = digest.endpoints.filter((e) => e.graphql).length
  return (
    <div className="flex justify-between items-end flex-wrap gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-2xl font-bold tracking-tight">{digest.host}</h1>
        <p className="m-0 text-xs text-muted-foreground mt-1">
          {digest.sessionCount} session{digest.sessionCount === 1 ? '' : 's'}
          {latestSession && <> · last captured {formatAgo(latestSession.uploadedAt)}</>}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-3">
          <KpiChip label="Routes" value={digest.routes.length} />
          <KpiChip label="Endpoints" value={restCount} />
          {gqlCount > 0 && <KpiChip label="GraphQL ops" value={gqlCount} />}
          {digest.staticAssets.length > 0 && <KpiChip label="Assets" value={digest.staticAssets.length} />}
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        {latestSession && (
          <Button asChild>
            <a href={`/sessions/${latestSession.id}`}>Open latest session →</a>
          </Button>
        )}
        {!isShareView && (
          <Button asChild variant="secondary">
            <a href={link('/narrative')}>📋 AI service brief</a>
          </Button>
        )}
      </div>
    </div>
  )
}

function KpiChip({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="inline-flex items-baseline gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
      <span className="text-sm font-semibold tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  )
}

// ---------- Tab: Overview ----------

function OverviewTab({
  digest,
  isShareView,
  restEndpoints,
  graphqlEndpoints,
}: {
  digest: ProjectDigest
  link: (p: string) => string
  isShareView: boolean
  restEndpoints: EndpointEntry[]
  graphqlEndpoints: EndpointEntry[]
}) {
  const sessions = digest.sessions.slice().sort((a, b) => b.uploadedAt - a.uploadedAt)
  return (
    <div className="space-y-6">
      <Subsection title="Sessions" caption={`${sessions.length} capture${sessions.length === 1 ? '' : 's'}, newest first`}>
        <div className="flex gap-1.5 flex-wrap">
          {sessions.map((s) =>
            isShareView
              ? <Badge key={s.id} variant="outline" title={s.startedAt}>{s.id.slice(0, 8)} · {formatAgo(s.uploadedAt)}</Badge>
              : <a key={s.id} href={`/sessions/${s.id}`} className="no-underline" title={s.startedAt}>
                  <Badge variant="outline" className="hover:border-primary cursor-pointer">{s.id.slice(0, 8)} · {formatAgo(s.uploadedAt)}</Badge>
                </a>,
          )}
        </div>
      </Subsection>

      {digest.routes.length > 0 && (
        <Subsection title="Route tree" caption={`${digest.routes.length} unique route${digest.routes.length === 1 ? '' : 's'} captured`}>
          <Card><CardContent className="p-4" dangerouslySetInnerHTML={{ __html: renderRouteForestHtml(buildRouteForest(digest.routes)) }} /></Card>
        </Subsection>
      )}

      {graphqlEndpoints.length > 0 && (
        <Subsection title={`GraphQL operations (${graphqlEndpoints.length})`}>
          <div className="space-y-3">{graphqlEndpoints.slice(0, 6).map((e) => <EndpointBlock key={e.key} e={e} digest={digest} />)}</div>
          {graphqlEndpoints.length > 6 && <p className="text-xs text-muted-foreground mt-2">…and {graphqlEndpoints.length - 6} more. Open the API inventory on any session for the full list.</p>}
        </Subsection>
      )}

      {restEndpoints.length > 0 && (
        <Subsection title={`REST / RPC endpoints (${restEndpoints.length})`}>
          <div className="space-y-3">{restEndpoints.slice(0, 8).map((e) => <EndpointBlock key={e.key} e={e} digest={digest} />)}</div>
          {restEndpoints.length > 8 && <p className="text-xs text-muted-foreground mt-2">…and {restEndpoints.length - 8} more.</p>}
        </Subsection>
      )}
    </div>
  )
}

// ---------- Tab: Tests ----------

function TestsTab({ link }: { link: (p: string) => string }) {
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
      <FeatureCard
        href={link('/test-plan')}
        title="AI test plan"
        description="Gemini reads coverage gaps and proposes prioritized test scenarios with evidence."
        cta="Open"
        primary
      />
      <FeatureCard
        href={link('/test-coverage')}
        title="Coverage map"
        description="Cross-reference captured routes + endpoints against the generated test suite to surface what's untested."
        cta="View"
      />
      <FeatureCard
        href={link('/tests')}
        title="Canonical suite"
        description="Curate specs as the project's golden flows. Bundle as a runnable Playwright project for CI."
        cta="Manage"
      />
      <FeatureCard
        href={link('/test-runs')}
        title="CI run history"
        description="Stability rollup from canonical specs run in CI. Flaky vs. consistently-failing detection."
        cta="View"
      />
    </div>
  )
}

// ---------- Tab: Monitor ----------

function MonitorTab({
  monitor,
  link,
  isShareView,
}: {
  monitor: { config: MonitorConfig | null; runs: MonitorRunSummary[]; slackConfigured: boolean } | null
  link: (p: string) => string
  isShareView: boolean
}) {
  if (isShareView) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Synthetic monitoring isn't visible from share links.
        </CardContent>
      </Card>
    )
  }
  const config = monitor?.config ?? null
  const runs = monitor?.runs ?? []
  const lastRun = runs[0]
  const enabled = config?.enabled === true
  const statusTone = lastRun?.status === 'ok' ? 'success' : lastRun?.status === 'regression' ? 'danger' : lastRun?.status === 'error' ? 'warning' : 'muted'
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 flex justify-between items-center gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={enabled ? 'success' : 'muted'}>{enabled ? 'On' : 'Off'}</Badge>
              {config && <span className="text-xs text-muted-foreground">interval: {config.interval}</span>}
              {lastRun && <Badge variant={statusTone}>last run: {lastRun.status}</Badge>}
            </div>
            <p className="m-0 text-sm">
              {enabled
                ? <>Cron worker visits this project on a schedule and diffs against the latest baseline capture.</>
                : <>Not running. Enable to get drift alerts when the API surface or console-error count moves.</>}
            </p>
          </div>
          <Button asChild>
            <a href={link('/monitor')}>{enabled ? 'Configure →' : 'Set up'}</a>
          </Button>
        </CardContent>
      </Card>

      {lastRun && (
        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline mb-2">
              <h3 className="text-sm font-semibold m-0">Recent runs</h3>
              <a href={link('/monitor')} className="text-xs text-primary no-underline hover:underline">Full history →</a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {runs.slice(0, 6).map((r) => (
                <div key={r.id} className="rounded-md border p-2.5 text-xs">
                  <div className="flex items-center justify-between mb-1">
                    <Badge variant={r.status === 'ok' ? 'success' : r.status === 'regression' ? 'danger' : 'warning'}>{r.status}</Badge>
                    <span className="text-muted-foreground">{new Date(r.startedAt).toISOString().slice(11, 16)}</span>
                  </div>
                  <div className="text-muted-foreground line-clamp-2">{r.headline}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ---------- Tab: Insights ----------

function InsightsTab({ link }: { link: (p: string) => string }) {
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      <FeatureCard
        href={link('/performance')}
        title="Performance"
        description="Per-endpoint p50/p90/p95 latency, slowest individual calls, N+1 detection."
        cta="View"
        primary
      />
      <FeatureCard
        href={link('/security')}
        title="Security"
        description="Auth scheme matrix, secrets in URLs, mixed content, cookie scoping."
        cta="View"
      />
      <FeatureCard
        href={link('/a11y')}
        title="Accessibility"
        description="Heuristic audit from captured CDP accessibility trees."
        cta="View"
      />
      <FeatureCard
        href={link('/coverage')}
        title="Dead code"
        description="V8 + CSS coverage. Per-file used vs. total bytes across every session."
        cta="View"
      />
      <FeatureCard
        href={link('/graph')}
        title="Dependency graph"
        description="Page → API edges weighted by call count."
        cta="View"
      />
      <FeatureCard
        href={link('/heatmap')}
        title="Click heatmap"
        description="Click positions overlaid on captured screenshots."
        cta="View"
      />
      <FeatureCard
        href={link('/websockets')}
        title="WebSockets"
        description="Realtime channels grouped by endpoint + inferred message-type schemas."
        cta="View"
      />
    </div>
  )
}

// ---------- Tab: Settings ----------

function SettingsTab({
  link,
  digest,
  shareUrl,
  integrations,
  otherHosts,
  restEndpoints,
}: {
  link: (p: string) => string
  digest: ProjectDigest
  shareUrl: { url: string; createdAt: number } | null
  integrations: ProjectPageProps['integrations']
  otherHosts: string[]
  restEndpoints: EndpointEntry[]
}) {
  return (
    <div className="space-y-6">
      <Subsection title="Exports" caption="Take this project's data into your own tooling.">
        <div className="grid gap-2 grid-cols-1 md:grid-cols-2">
          <DownloadCard
            href={link('/clone.zip')}
            title="Local clone bundle"
            description="Captured frontend + mock server + run.sh as one zip. Unzip → ./run.sh → http://localhost:8080."
            primary
          />
          {restEndpoints.length > 0 && <DownloadCard href={link('/api/mock')} title="Mock server" description="Stateful zero-dep Node.js mock for every captured endpoint." />}
          {restEndpoints.length > 0 && <DownloadCard href={link('/openapi.json')} title="OpenAPI 3.0" description="Drop into Postman, openapi-typescript, etc." />}
          {restEndpoints.length > 0 && <DownloadCard href={link('/postman.json')} title="Postman collection" description="v2.1 — folders by tag, sample responses." />}
          {digest.graphqlOps.length > 0 && <DownloadCard href={link('/graphql.txt')} title="GraphQL operations" description={`${digest.graphqlOps.length} ops merged across sessions.`} />}
        </div>
      </Subsection>

      <Subsection title="Integrations" caption="Push findings out to where your team already works.">
        <div className="grid gap-2 grid-cols-1 md:grid-cols-2">
          <IntegrationCard
            href={link('/integrations')}
            title="Linear / Slack / GitHub repo"
            description={
              integrations
                ? formatIntegrationStatus(integrations)
                : 'File issues from findings, post regression pings, wire the GitHub PR bot.'
            }
          />
          <IntegrationCard
            href={link('/sentry')}
            title="Sentry"
            description={integrations?.sentry ? `Connected · ${integrations.sentry.org}/${integrations.sentry.project}` : 'Match Sentry issues to captured user flows.'}
          />
        </div>
      </Subsection>

      <Subsection title="Share" caption="Send a read-only link to anyone — no Unwrap account required.">
        <ShareCard shareUrl={shareUrl} createPath={link('/share')} revokePath={link('/share/revoke')} />
      </Subsection>

      {otherHosts.length > 0 && (
        <Subsection title="Compare against another project">
          <CompareCard linkFn={link} otherHosts={otherHosts} />
        </Subsection>
      )}
    </div>
  )
}

function formatIntegrationStatus(i: NonNullable<ProjectPageProps['integrations']>): string {
  const connected: string[] = []
  if (i.linear) connected.push('Linear')
  if (i.slack) connected.push('Slack')
  if (i.repo) connected.push(`GitHub (${i.repo.repo})`)
  if (connected.length === 0) return 'Not connected. Configure to file issues from findings, post regression pings, wire the GitHub PR bot.'
  return `Connected: ${connected.join(', ')}.`
}

// ---------- Generic blocks ----------

function Subsection({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold m-0">{title}</h2>
        {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      </div>
      {children}
    </section>
  )
}

function FeatureCard({ href, title, description, cta, primary }: { href: string; title: string; description: string; cta: string; primary?: boolean }) {
  return (
    <a
      href={href}
      className={cn(
        'group block rounded-lg border p-4 no-underline text-foreground bg-card transition-colors',
        primary ? 'border-primary/40 bg-primary/[0.04] hover:border-primary' : 'hover:border-primary',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-sm">{title}</div>
        <span className={cn('text-xs shrink-0', primary ? 'text-primary' : 'text-muted-foreground group-hover:text-primary')}>{cta} →</span>
      </div>
      <div className="text-xs text-muted-foreground mt-2 leading-relaxed">{description}</div>
    </a>
  )
}

function DownloadCard({ href, title, description, primary }: { href: string; title: string; description: string; primary?: boolean }) {
  return (
    <a
      href={href}
      download
      className={cn(
        'block rounded-lg border p-4 no-underline text-foreground bg-card transition-colors',
        primary ? 'border-primary/40 bg-primary/[0.04] hover:border-primary' : 'hover:border-primary',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-sm">{title}</div>
        <span className={cn('text-xs shrink-0', primary ? 'text-primary' : 'text-muted-foreground')}>↓ download</span>
      </div>
      <div className="text-xs text-muted-foreground mt-2 leading-relaxed">{description}</div>
    </a>
  )
}

function IntegrationCard({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <a
      href={href}
      className="block rounded-lg border p-4 no-underline text-foreground bg-card transition-colors hover:border-primary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-sm">{title}</div>
        <span className="text-xs shrink-0 text-muted-foreground">Configure →</span>
      </div>
      <div className="text-xs text-muted-foreground mt-2 leading-relaxed">{description}</div>
    </a>
  )
}

function CompareCard({ linkFn, otherHosts }: { linkFn: (p: string) => string; otherHosts: string[] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <form
          method="get"
          action={linkFn('/diff/__placeholder__')}
          onSubmit={`event.preventDefault(); const t = this.querySelector('select').value; if (t) window.location.href = '${linkFn('/diff/')}' + encodeURIComponent(t)` as never}
          className="flex gap-2 flex-wrap items-center"
        >
          <span className="text-xs text-muted-foreground mr-1">Diff this project against:</span>
          <Select required defaultValue="" className="flex-1 h-8 text-xs min-w-[180px]">
            <option value="">— pick another host —</option>
            {otherHosts.map((h) => <option key={h} value={h}>{h}</option>)}
          </Select>
          <Button type="submit" variant="secondary" size="sm">Compare →</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ShareCard({ shareUrl, createPath, revokePath }: { shareUrl: { url: string; createdAt: number } | null; createPath: string; revokePath: string }) {
  if (!shareUrl) {
    return (
      <Card>
        <CardContent className="p-4">
          <form method="post" action={createPath}>
            <Button type="submit">Create share link</Button>
          </form>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <input type="text" readOnly value={shareUrl.url} id="share-url-input" className="flex-1 min-w-[240px] h-8 px-2.5 rounded-md border border-input bg-background font-mono text-xs" onClick={"this.select()" as never} />
          <Button type="button" variant="secondary" size="sm" onClick={"navigator.clipboard.writeText(document.getElementById('share-url-input').value); this.textContent='Copied'; setTimeout(()=>this.textContent='Copy',1500)" as never}>Copy</Button>
          <form method="post" action={revokePath} className="m-0" data-confirm="Revoke this share link?">
            <Button type="submit" variant="destructive" size="sm">Revoke</Button>
          </form>
        </div>
        {shareUrl.createdAt > 0 && (
          <div className="text-xs text-muted-foreground">Created {new Date(shareUrl.createdAt).toISOString().slice(0, 16).replace('T', ' ')}.</div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- Endpoint detail block (used by Overview tab) ----------

function EndpointBlock({ e, digest }: { e: EndpointEntry; digest: ProjectDigest }) {
  const requestJson = e.requestSamples.map(tryParse).filter((j) => j !== null)
  const responseJson = e.responseSamples.map(tryParse).filter((j) => j !== null)
  const requestSchema = requestJson.length > 0 ? inferType(requestJson, 'Request') : null
  const responseSchema = responseJson.length > 0 ? inferType(responseJson, 'Response') : null
  const matchingGqlOp = e.graphql?.operationName ? digest.graphqlOps.find((op) => op.name === e.graphql!.operationName) : undefined
  const statusList = Object.entries(e.statuses).sort(([a], [b]) => Number(a) - Number(b)).map(([s, n]) => `${s}×${n}`).join(' · ')
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex justify-between gap-3 flex-wrap items-baseline mb-2">
          <div className="flex items-baseline gap-2 flex-wrap min-w-0">
            <MethodPill method={e.method} />
            <code className="text-xs break-all">{e.normalizedPath}</code>
            {e.graphql?.operationName && (
              <span className="text-xs text-purple-500 font-mono">{e.graphql.operationType ?? 'query'} {e.graphql.operationName}</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            <span title="host">{e.hostname}</span> · {e.callCount} call{e.callCount === 1 ? '' : 's'} · {e.sessionCount} session{e.sessionCount === 1 ? '' : 's'} · {statusList}
          </div>
        </div>

        {matchingGqlOp && (
          <details className="mt-2 border-t pt-2" open>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">GraphQL operation — {matchingGqlOp.operationType} {matchingGqlOp.name}{matchingGqlOp.typenames.length > 0 ? ` · returns ${matchingGqlOp.typenames.join(', ')}` : ''}</summary>
            {Object.keys(matchingGqlOp.variableTypes).length > 0 && (
              <pre className="mt-1.5 mb-1.5 text-xs"><code>{Object.entries(matchingGqlOp.variableTypes).map(([k, t]) => `$${k}: ${t}`).join('\n')}</code></pre>
            )}
            <pre className="mt-1.5 text-xs"><code>{truncate(matchingGqlOp.query, 4000)}</code></pre>
          </details>
        )}

        {requestSchema && (
          <details className="mt-2 border-t pt-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">Request type — {requestJson.length} sample{requestJson.length === 1 ? '' : 's'}</summary>
            <pre className="mt-1.5 text-xs"><code>{requestSchema}</code></pre>
          </details>
        )}

        {responseSchema && (
          <details className="mt-2 border-t pt-2" open>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">Response type — {responseJson.length} sample{responseJson.length === 1 ? '' : 's'}</summary>
            <pre className="mt-1.5 text-xs"><code>{responseSchema}</code></pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

export function MethodPill({ method }: { method: string }) {
  const m = method.toLowerCase()
  const cls =
    m === 'get' ? 'bg-blue-500'
    : m === 'post' ? 'bg-green-600'
    : m === 'put' || m === 'patch' ? 'bg-amber-600'
    : m === 'delete' ? 'bg-red-500'
    : 'bg-gray-500'
  return <span className={cn('inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase font-mono text-white', cls)}>{method}</span>
}

function tryParse(s: string) {
  try { return JSON.parse(s) } catch { return null }
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)`
}
function formatAgo(ts: number) {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
