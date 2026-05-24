import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectDigest, EndpointEntry } from '../project-aggregate'
import { inferType } from '../schema-infer'
import { buildRouteForest, renderRouteForestHtml, ROUTE_TREE_CSS } from '../route-tree'

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
}): Renderable {
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const graphqlEndpoints = digest.endpoints.filter((e) => e.graphql)
  const isShareView = !!share
  // Internal link helper — keeps share-mode navigation inside /share/<token>/...
  const link = (subPath: string) =>
    isShareView
      ? `/share/${share!.token}${subPath}`
      : `/projects/${encodeURIComponent(digest.host)}${subPath}`

  return Layout({
    title: `Project · ${digest.host}`,
    email,
    body: html`
      ${isShareView
        ? html`<div class="share-banner">
            <strong>🔗 Shared read-only view</strong>
            <span class="meta">Sign in for full access if you have an Unwrap account.</span>
          </div>`
        : html`<p style="margin-top: 0;"><a href="/">← back to sessions</a></p>`}

      <!-- Hero: host + KPI strip + AI brief CTA in one prominent card -->
      <div class="hero">
        <div class="hero-head">
          <div>
            <h2 class="hero-title">${digest.host}</h2>
            <div class="muted hero-sub">Aggregated across ${digest.sessionCount} session${digest.sessionCount === 1 ? '' : 's'}. Type inference, GraphQL widening, and route maps merge samples from all sessions.</div>
          </div>
          <a class="btn hero-cta" href="${link('/narrative')}">📋 AI service brief →</a>
        </div>
        <div class="kpis">
          ${kpi('Sessions', digest.sessionCount, 'var(--fg)')}
          ${kpi('Routes', digest.routes.length, '#2f6feb')}
          ${kpi('Endpoints', restEndpoints.length, '#1f9d55')}
          ${kpi('GraphQL', graphqlEndpoints.length, '#7c4ac2')}
          ${kpi('Assets', digest.staticAssets.length, 'var(--muted)')}
        </div>
      </div>

      <!-- ANALYZE section: visual + structural insight -->
      ${section('🔍 Analyze', 'How the service is shaped and how it performs.', [
        miniCard(link('/graph'), '🕸 Dependency graph', 'Page → API edges weighted by call count'),
        miniCard(link('/heatmap'), '🎯 Click heatmap', 'Click positions overlaid on captured screenshots'),
        miniCard(link('/performance'), '⚡ Performance', 'Per-endpoint p50/p95/max + N+1 detection'),
        miniCard(link('/websockets'), '📡 WebSockets', 'Realtime channels + message-type schemas'),
        miniCard(link('/coverage'), '🧹 Dead code', 'V8 + CSS coverage; which chunks of the bundle are unused'),
        !isShareView && otherHosts.length > 0
          ? compareCard(link, otherHosts)
          : null,
      ])}

      <!-- QUALITY section: security + a11y -->
      ${section('🛡 Quality', 'Heuristic audits derived from captured runtime data.', [
        miniCard(link('/security'), '🔒 Security', 'Auth scheme matrix, secrets in URLs, mixed content, cookie audit'),
        miniCard(link('/a11y'), '♿ Accessibility', 'Missing names, alt text, labels — from CDP AX trees'),
      ])}

      <!-- TEST section: spec lifecycle -->
      ${section('🧪 Test', 'Generate, curate, and evaluate tests for this service.', [
        miniCard(link('/test-plan'), '📋 AI test plan', 'Gemini proposes prioritized scenarios from coverage gaps', { primary: true }),
        miniCard(link('/test-coverage'), '✅ Test coverage map', 'Untested routes/endpoints prioritized by traffic'),
        miniCard(link('/tests'), '🧪 Canonical test suite', 'Curate canonical specs; download as runnable Playwright project'),
        miniCard(link('/test-runs'), '📈 Test runs', 'Pass/fail history from CI · flaky + failing detection'),
      ])}

      <!-- EXPORT & INTEGRATE section -->
      ${section('📦 Export & integrate', 'Take Unwrap data into your existing tooling.', [
        miniDownload(link('/clone.zip'), '↓ Local clone bundle', 'Frontend + mock server + run.sh — the runnable deliverable', { primary: true }),
        restEndpoints.length > 0 ? miniDownload(link('/api/mock'), '↓ Mock server', 'Stateful zero-dep Node.js mock for every endpoint') : null,
        restEndpoints.length > 0 ? miniDownload(link('/openapi.json'), '↓ OpenAPI 3.0', 'Drop into Postman, openapi-typescript, etc.') : null,
        restEndpoints.length > 0 ? miniDownload(link('/postman.json'), '↓ Postman collection', 'v2.1 — folders by tag, sample responses') : null,
        digest.graphqlOps.length > 0 ? miniDownload(link('/graphql.txt'), '↓ GraphQL operations', `${digest.graphqlOps.length} ops merged across sessions`) : null,
        !isShareView ? miniCard(link('/sentry'), '🐞 Sentry correlation', 'Match Sentry issues to the user flow that produced them') : null,
        !isShareView ? miniCard(link('/integrations'), '🔌 Linear / Slack', 'File issues from findings, ping Slack on regression') : null,
      ])}

      <!-- SHARE section (owner only) -->
      ${!isShareView
        ? html`<div class="proj-section">
            <h2 class="proj-section-head">🔗 Share <span class="muted">Send a read-only link to anyone — no Unwrap account required.</span></h2>
            <div class="card share-card">
              ${shareUrl
                ? html`<div class="share-controls">
                    <input type="text" readonly value="${shareUrl.url}" id="share-url-input"
                      onclick="this.select()" class="share-input" />
                    <button type="button" class="btn secondary" onclick="navigator.clipboard.writeText(document.getElementById('share-url-input').value); this.textContent='Copied'; setTimeout(()=>this.textContent='Copy',1500)">Copy</button>
                    <form method="post" action="${link('/share/revoke')}" style="margin: 0;" onsubmit="return confirm('Revoke this share link?')">
                      <button type="submit" class="btn danger">Revoke</button>
                    </form>
                  </div>
                  ${shareUrl.createdAt > 0
                    ? html`<div class="meta share-meta">Created ${new Date(shareUrl.createdAt).toISOString().slice(0, 16).replace('T', ' ')}.</div>`
                    : ''}`
                : html`<form method="post" action="${link('/share')}" class="share-create">
                    <button type="submit" class="btn">Create share link</button>
                  </form>`}
            </div>
          </div>`
        : ''}

      <!-- DETAILS — collapsed by default since this is the bulky stuff -->
      <details class="proj-details" open>
        <summary><h2 class="proj-section-head" style="display: inline; cursor: pointer;">📊 Details <span class="muted">Sessions, route tree, full endpoint list.</span></h2></summary>

        <div class="proj-section">
          <h3 class="proj-sub-head">Sessions (${digest.sessions.length})</h3>
          <div class="session-badges">
            ${digest.sessions
              .slice()
              .sort((a, b) => b.uploadedAt - a.uploadedAt)
              .map((s) => isShareView
                ? html`<span class="badge" title="${s.startedAt}">${s.id.slice(0, 8)} · ${formatAgo(s.uploadedAt)}</span>`
                : html`<a class="badge" style="text-decoration: none;" href="/sessions/${s.id}" title="${s.startedAt}">${s.id.slice(0, 8)} · ${formatAgo(s.uploadedAt)}</a>`)}
          </div>
        </div>

        ${digest.routes.length > 0
          ? html`<div class="proj-section">
              <h3 class="proj-sub-head">Route tree (${digest.routes.length})</h3>
              <div class="card">${raw(renderRouteForestHtml(buildRouteForest(digest.routes)))}</div>
            </div>`
          : ''}

        ${graphqlEndpoints.length > 0
          ? html`<div class="proj-section">
              <h3 class="proj-sub-head">GraphQL operations (${graphqlEndpoints.length})</h3>
              ${graphqlEndpoints.map((e) => renderEndpoint(e, digest))}
            </div>`
          : ''}

        ${restEndpoints.length > 0
          ? html`<div class="proj-section">
              <h3 class="proj-sub-head">REST / RPC endpoints (${restEndpoints.length})</h3>
              ${restEndpoints.map((e) => renderEndpoint(e, digest))}
            </div>`
          : ''}
      </details>

      <style>${raw(PROJECT_CSS)}${raw(ROUTE_TREE_CSS)}</style>
    `,
  })
}

// ---- Building blocks for the grouped layout ---------------------------------

interface MiniCardOpts {
  primary?: boolean
}

// Compact menu card — title + one-liner + chevron — used inside each section.
// Renders as an <a> so the whole tile is clickable.
function miniCard(href: string, title: string, sub: string, opts: MiniCardOpts = {}): Renderable {
  return html`<a class="mini-card ${opts.primary ? 'primary' : ''}" href="${href}">
    <div class="mini-card-title">${title}</div>
    <div class="mini-card-sub">${sub}</div>
    <span class="mini-card-arrow">→</span>
  </a>`
}

function miniDownload(href: string, title: string, sub: string, opts: MiniCardOpts = {}): Renderable {
  return html`<a class="mini-card ${opts.primary ? 'primary' : ''}" href="${href}" download>
    <div class="mini-card-title">${title}</div>
    <div class="mini-card-sub">${sub}</div>
    <span class="mini-card-arrow">↓</span>
  </a>`
}

function compareCard(link: (p: string) => string, otherHosts: string[]): Renderable {
  return html`<form class="mini-card mini-card-form" method="get" action="${link('/diff/__placeholder__')}"
    onsubmit="event.preventDefault(); const t = this.querySelector('select').value; if (t) window.location.href = '${link('/diff/')}' + encodeURIComponent(t)">
    <div class="mini-card-title">⇄ Compare projects</div>
    <div class="mini-card-sub">Diff against another captured host</div>
    <div class="mini-card-form-row">
      <select required>
        <option value="">— pick —</option>
        ${otherHosts.map((h) => html`<option value="${h}">${h}</option>`)}
      </select>
      <button type="submit" class="btn secondary">Diff →</button>
    </div>
  </form>`
}

function section(title: string, subtitle: string, cards: (Renderable | null)[]): Renderable {
  const filtered = cards.filter((c): c is Renderable => c !== null)
  if (filtered.length === 0) return html``
  return html`<div class="proj-section">
    <h2 class="proj-section-head">${title} <span class="muted">${subtitle}</span></h2>
    <div class="mini-card-grid">${filtered}</div>
  </div>`
}

// ---- Endpoint render (unchanged from before) --------------------------------

function renderEndpoint(e: EndpointEntry, digest: ProjectDigest): Renderable {
  const requestJson = e.requestSamples.map(tryParse).filter((j) => j !== null)
  const responseJson = e.responseSamples.map(tryParse).filter((j) => j !== null)
  const requestSchema = requestJson.length > 0 ? inferType(requestJson, 'Request') : null
  const responseSchema = responseJson.length > 0 ? inferType(responseJson, 'Response') : null

  const matchingGqlOp = e.graphql?.operationName
    ? digest.graphqlOps.find((op) => op.name === e.graphql!.operationName)
    : undefined

  const statusList = Object.entries(e.statuses)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([s, n]) => `${s}×${n}`)
    .join(' · ')

  return html`<div class="endpoint">
    <div class="endpoint-head">
      <div class="endpoint-id">
        <span class="method m-${e.method.toLowerCase()}">${e.method}</span>
        <code>${e.normalizedPath}</code>
        ${e.graphql?.operationName
          ? html`<span class="gql-op">${e.graphql.operationType ?? 'query'} ${e.graphql.operationName}</span>`
          : ''}
      </div>
      <div class="endpoint-meta">
        <span title="host">${e.hostname}</span>
        · ${e.callCount} call${e.callCount === 1 ? '' : 's'}
        · ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}
        · ${statusList}
      </div>
    </div>

    ${matchingGqlOp
      ? html`<details class="endpoint-section" open>
          <summary>GraphQL operation — ${matchingGqlOp.operationType} ${matchingGqlOp.name}${matchingGqlOp.typenames.length > 0 ? ` · returns ${matchingGqlOp.typenames.join(', ')}` : ''}</summary>
          ${Object.keys(matchingGqlOp.variableTypes).length > 0
            ? html`<pre style="margin-bottom: 6px;"><code>${Object.entries(matchingGqlOp.variableTypes).map(([k, t]) => `$${k}: ${t}`).join('\n')}</code></pre>`
            : ''}
          <pre><code>${truncate(matchingGqlOp.query, 4000)}</code></pre>
        </details>`
      : ''}

    ${requestSchema
      ? html`<details class="endpoint-section">
          <summary>Request type — inferred from ${requestJson.length} sample${requestJson.length === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}</summary>
          <pre><code>${requestSchema}</code></pre>
        </details>`
      : ''}

    ${responseSchema
      ? html`<details class="endpoint-section" open>
          <summary>Response type — inferred from ${responseJson.length} sample${responseJson.length === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}</summary>
          <pre><code>${responseSchema}</code></pre>
        </details>`
      : ''}
  </div>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div class="kpi-tile">
    <div class="kpi-value" style="color: ${color};">${value}</div>
    <div class="kpi-label">${label}</div>
  </div>`
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)`
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const PROJECT_CSS = `
.share-banner { background: color-mix(in oklab, #7c4ac2 6%, transparent); border: 1px solid color-mix(in oklab, #7c4ac2 35%, var(--border)); border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
.share-banner .meta { display: block; font-size: 11px; margin-top: 2px; }

.hero { border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }
.hero-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.hero-title { margin: 0; font-size: 22px; font-weight: 700; }
.hero-sub { font-size: 12px; margin-top: 2px; }
.hero-cta { white-space: nowrap; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.kpi-tile { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.kpi-value { font-size: 20px; font-weight: 700; }
.kpi-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }

.proj-section { margin-bottom: 22px; }
.proj-section-head { font-size: 14px; font-weight: 600; margin: 0 0 10px; text-transform: none; letter-spacing: 0; color: var(--fg); }
.proj-section-head .muted { font-weight: 400; font-size: 12px; margin-left: 8px; }
.proj-sub-head { font-size: 12px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }

.mini-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.mini-card {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 4px 8px;
  align-items: start;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  text-decoration: none;
  color: var(--fg);
  background: var(--bg);
  transition: border-color 120ms, transform 120ms;
}
.mini-card:hover { border-color: var(--accent); transform: translateY(-1px); }
.mini-card.primary { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 6%, transparent); }
.mini-card.primary:hover { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 10%, transparent); }
.mini-card-title { font-weight: 600; font-size: 13px; grid-column: 1; }
.mini-card-sub { color: var(--muted); font-size: 11px; grid-column: 1 / -1; line-height: 1.4; }
.mini-card-arrow { color: var(--muted); font-size: 16px; grid-column: 2; grid-row: 1; }
.mini-card.primary .mini-card-arrow { color: var(--accent); }
.mini-card-form { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.mini-card-form-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mini-card-form-row select { flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; }
.mini-card-form-row button { font-size: 12px; padding: 6px 12px; }

.share-card { display: flex; flex-direction: column; gap: 6px; }
.share-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.share-input { flex: 1; min-width: 240px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-family: ui-monospace, monospace; font-size: 12px; }
.share-meta { font-size: 11px; }
.share-create { margin: 0; }

.proj-details { margin-top: 24px; }
.proj-details summary { list-style: none; cursor: pointer; }
.proj-details summary::-webkit-details-marker { display: none; }
.proj-details summary::before { content: '▸ '; font-size: 11px; color: var(--muted); }
.proj-details[open] summary::before { content: '▾ '; }
.session-badges { display: flex; gap: 6px; flex-wrap: wrap; }

.endpoint { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: var(--bg); }
.endpoint-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; margin-bottom: 8px; }
.endpoint-id { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.endpoint-id code { font-size: 12px; word-break: break-all; }
.endpoint-meta { color: var(--muted); font-size: 11px; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: white; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
.gql-op { font-size: 11px; color: #7c4ac2; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.endpoint-section { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.endpoint-section summary { cursor: pointer; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.endpoint-section pre { margin: 6px 0 0; font-size: 11px; max-height: 400px; }
`
