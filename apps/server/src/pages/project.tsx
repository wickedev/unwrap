import * as React from 'react'
import { Layout } from './_layout'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Select } from '../components/ui/input'
import { cn } from '../components/lib/cn'
import type { ProjectDigest, EndpointEntry } from '../project-aggregate'
import { inferType } from '../schema-infer'
import { buildRouteForest, renderRouteForestHtml } from '../route-tree'

export function ProjectPage({
  email,
  digest,
  otherHosts = [],
  share,
  shareUrl,
}: {
  email: string
  digest: ProjectDigest
  otherHosts?: string[]
  share?: { token: string }
  shareUrl?: { url: string; createdAt: number } | null
}) {
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const graphqlEndpoints = digest.endpoints.filter((e) => e.graphql)
  const isShareView = !!share
  const link = (subPath: string) =>
    isShareView
      ? `/share/${share!.token}${subPath}`
      : `/projects/${encodeURIComponent(digest.host)}${subPath}`

  return (
    <Layout email={email} wide>
      {isShareView
        ? (
          <div className="rounded-lg border px-4 py-3 mb-4 bg-[hsl(var(--primary))]/5 border-[hsl(var(--primary))]/35">
            <strong className="text-sm">🔗 Shared read-only view</strong>
            <div className="text-xs text-muted-foreground mt-0.5">Sign in for full access if you have an Unwrap account.</div>
          </div>
        )
        : <p className="m-0 mb-4"><a href="/" className="text-primary text-sm">← back to sessions</a></p>}

      {/* Hero */}
      <Card className="mb-6">
        <CardContent className="p-5">
          <div className="flex justify-between items-start flex-wrap gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="m-0 text-2xl font-bold">{digest.host}</h2>
              <p className="m-0 text-xs text-muted-foreground mt-1">
                Aggregated across {digest.sessionCount} session{digest.sessionCount === 1 ? '' : 's'}. Type inference, GraphQL widening, and route maps merge samples from all sessions.
              </p>
            </div>
            <Button asChild>
              <a href={link('/narrative')}>📋 AI service brief →</a>
            </Button>
          </div>
          <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(110px,1fr))]">
            <Kpi label="Sessions" value={digest.sessionCount} />
            <Kpi label="Routes" value={digest.routes.length} color="text-[hsl(var(--primary))]" />
            <Kpi label="Endpoints" value={restEndpoints.length} color="text-[hsl(var(--success))]" />
            <Kpi label="GraphQL" value={graphqlEndpoints.length} color="text-purple-500" />
            <Kpi label="Assets" value={digest.staticAssets.length} color="text-muted-foreground" />
          </div>
        </CardContent>
      </Card>

      <Section title="🔍 Analyze" subtitle="How the service is shaped and how it performs.">
        <MiniCard href={link('/graph')} title="🕸 Dependency graph" sub="Page → API edges weighted by call count" />
        <MiniCard href={link('/heatmap')} title="🎯 Click heatmap" sub="Click positions overlaid on captured screenshots" />
        <MiniCard href={link('/performance')} title="⚡ Performance" sub="Per-endpoint p50/p95/max + N+1 detection" />
        <MiniCard href={link('/websockets')} title="📡 WebSockets" sub="Realtime channels + message-type schemas" />
        <MiniCard href={link('/coverage')} title="🧹 Dead code" sub="V8 + CSS coverage; bundle chunks unused" />
        {!isShareView && otherHosts.length > 0 && (
          <CompareCard linkFn={link} otherHosts={otherHosts} />
        )}
      </Section>

      <Section title="🛡 Quality" subtitle="Heuristic audits derived from captured runtime data.">
        <MiniCard href={link('/security')} title="🔒 Security" sub="Auth scheme matrix, secrets in URLs, mixed content, cookies" />
        <MiniCard href={link('/a11y')} title="♿ Accessibility" sub="Missing names, alt text, labels — from CDP AX trees" />
      </Section>

      <Section title="🧪 Test" subtitle="Generate, curate, and evaluate tests for this service.">
        <MiniCard href={link('/test-plan')} title="📋 AI test plan" sub="Gemini proposes scenarios from coverage gaps" primary />
        <MiniCard href={link('/test-coverage')} title="✅ Test coverage map" sub="Untested routes/endpoints prioritized by traffic" />
        <MiniCard href={link('/tests')} title="🧪 Canonical test suite" sub="Curate canonical specs; CI-ready Playwright project" />
        <MiniCard href={link('/test-runs')} title="📈 Test runs" sub="Pass/fail history from CI · flaky + failing detection" />
      </Section>

      <Section title="📦 Export & integrate" subtitle="Take Unwrap data into your existing tooling.">
        <MiniDownload href={link('/clone.zip')} title="↓ Local clone bundle" sub="Frontend + mock + run.sh — the runnable deliverable" primary />
        {restEndpoints.length > 0 && <MiniDownload href={link('/api/mock')} title="↓ Mock server" sub="Stateful zero-dep Node.js mock for every endpoint" />}
        {restEndpoints.length > 0 && <MiniDownload href={link('/openapi.json')} title="↓ OpenAPI 3.0" sub="Drop into Postman, openapi-typescript, etc." />}
        {restEndpoints.length > 0 && <MiniDownload href={link('/postman.json')} title="↓ Postman collection" sub="v2.1 — folders by tag, sample responses" />}
        {digest.graphqlOps.length > 0 && <MiniDownload href={link('/graphql.txt')} title="↓ GraphQL operations" sub={`${digest.graphqlOps.length} ops merged across sessions`} />}
        {!isShareView && <MiniCard href={link('/sentry')} title="🐞 Sentry correlation" sub="Match Sentry issues to user flows" />}
        {!isShareView && <MiniCard href={link('/integrations')} title="🔌 Linear / Slack" sub="File issues from findings, ping on regression" />}
      </Section>

      {!isShareView && (
        <Section title="🔗 Share" subtitle="Send a read-only link to anyone — no Unwrap account required.">
          <ShareCard shareUrl={shareUrl} createPath={link('/share')} revokePath={link('/share/revoke')} />
        </Section>
      )}

      <details className="mt-8" open>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <h2 className="inline text-sm font-semibold m-0">📊 Details <span className="text-muted-foreground font-normal text-xs ml-2">Sessions, route tree, full endpoint list.</span></h2>
        </summary>

        <div className="mt-4 space-y-6">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Sessions ({digest.sessions.length})</h3>
            <div className="flex gap-1.5 flex-wrap">
              {digest.sessions.slice().sort((a, b) => b.uploadedAt - a.uploadedAt).map((s) =>
                isShareView
                  ? <Badge key={s.id} variant="outline" title={s.startedAt}>{s.id.slice(0, 8)} · {formatAgo(s.uploadedAt)}</Badge>
                  : <a key={s.id} href={`/sessions/${s.id}`} className="no-underline" title={s.startedAt}><Badge variant="outline">{s.id.slice(0, 8)} · {formatAgo(s.uploadedAt)}</Badge></a>,
              )}
            </div>
          </div>

          {digest.routes.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Route tree ({digest.routes.length})</h3>
              <Card><CardContent className="p-4" dangerouslySetInnerHTML={{ __html: renderRouteForestHtml(buildRouteForest(digest.routes)) }} /></Card>
            </div>
          )}

          {graphqlEndpoints.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">GraphQL operations ({graphqlEndpoints.length})</h3>
              <div className="space-y-3">{graphqlEndpoints.map((e) => <EndpointBlock key={e.key} e={e} digest={digest} />)}</div>
            </div>
          )}

          {restEndpoints.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">REST / RPC endpoints ({restEndpoints.length})</h3>
              <div className="space-y-3">{restEndpoints.map((e) => <EndpointBlock key={e.key} e={e} digest={digest} />)}</div>
            </div>
          )}
        </div>
      </details>
    </Layout>
  )
}

function Kpi({ label, value, color = 'text-foreground' }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className={cn('text-xl font-bold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold m-0 mb-3">
        {title} <span className="text-xs text-muted-foreground font-normal ml-2">{subtitle}</span>
      </h2>
      <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
        {children}
      </div>
    </section>
  )
}

function MiniCard({ href, title, sub, primary }: { href: string; title: string; sub: string; primary?: boolean }) {
  return (
    <a
      href={href}
      className={cn(
        'group rounded-lg border p-3.5 no-underline text-foreground bg-card transition-all hover:-translate-y-0.5',
        primary ? 'border-primary bg-primary/5 hover:bg-primary/10' : 'hover:border-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-sm">{title}</div>
        <span className={cn('text-base shrink-0', primary ? 'text-primary' : 'text-muted-foreground')}>→</span>
      </div>
      <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{sub}</div>
    </a>
  )
}

function MiniDownload({ href, title, sub, primary }: { href: string; title: string; sub: string; primary?: boolean }) {
  return (
    <a
      href={href}
      download
      className={cn(
        'group rounded-lg border p-3.5 no-underline text-foreground bg-card transition-all hover:-translate-y-0.5',
        primary ? 'border-primary bg-primary/5 hover:bg-primary/10' : 'hover:border-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-sm">{title}</div>
        <span className={cn('text-base shrink-0', primary ? 'text-primary' : 'text-muted-foreground')}>↓</span>
      </div>
      <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{sub}</div>
    </a>
  )
}

function CompareCard({ linkFn, otherHosts }: { linkFn: (p: string) => string; otherHosts: string[] }) {
  return (
    <form
      method="get"
      action={linkFn('/diff/__placeholder__')}
      className="rounded-lg border p-3.5 bg-card"
      onSubmit={`event.preventDefault(); const t = this.querySelector('select').value; if (t) window.location.href = '${linkFn('/diff/')}' + encodeURIComponent(t)` as never}
    >
      <div className="font-semibold text-sm">⇄ Compare projects</div>
      <div className="text-xs text-muted-foreground mt-1 mb-2">Diff against another captured host</div>
      <div className="flex gap-1.5 flex-wrap items-center">
        <Select required defaultValue="" className="flex-1 h-8 text-xs">
          <option value="">— pick —</option>
          {otherHosts.map((h) => <option key={h} value={h}>{h}</option>)}
        </Select>
        <Button type="submit" variant="secondary" size="sm">Diff →</Button>
      </div>
    </form>
  )
}

function ShareCard({ shareUrl, createPath, revokePath }: { shareUrl?: { url: string; createdAt: number } | null; createPath: string; revokePath: string }) {
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
          <form method="post" action={revokePath} className="m-0" onSubmit={"return confirm('Revoke this share link?')" as never}>
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
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">Request type — inferred from {requestJson.length} sample{requestJson.length === 1 ? '' : 's'}</summary>
            <pre className="mt-1.5 text-xs"><code>{requestSchema}</code></pre>
          </details>
        )}

        {responseSchema && (
          <details className="mt-2 border-t pt-2" open>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">Response type — inferred from {responseJson.length} sample{responseJson.length === 1 ? '' : 's'}</summary>
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
