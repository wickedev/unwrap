import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { SentryCorrelation } from '../sentry'
import type { SentryConfig } from '../storage/sentry-config'

export function ProjectSentryPage({
  email,
  host,
  config,
  correlations,
  error,
}: {
  email: string
  host: string
  config: SentryConfig | null
  correlations: SentryCorrelation[]
  error?: string
}): Renderable {
  const matched = correlations.filter((c) => c.matchedSessions.length > 0)
  const unmatched = correlations.filter((c) => c.matchedSessions.length === 0)

  return Layout({
    title: `${host} · Sentry`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Sentry correlation</h2>
      <p class="muted">
        Cross-references recent Sentry issues against console errors / exceptions captured
        during this project's sessions. When a Sentry issue matches a captured error, you
        get the user flow that produced it.
      </p>

      ${error ? html`<div class="error">${error}</div>` : ''}

      ${!config
        ? html`<div class="card">
            <strong>Connect Sentry</strong>
            <p class="meta" style="font-size: 12px; margin: 6px 0 10px;">
              Create an Internal Integration in Sentry (Organization Settings → Custom Integrations)
              with <code>event:read</code> and <code>project:read</code> scopes. Paste the token below.
            </p>
            <form method="post" action="/projects/${encodeURIComponent(host)}/sentry/config" style="display: grid; gap: 8px; max-width: 540px;">
              <input type="text" name="org" required placeholder="org slug (e.g. acme)"
                style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
              <input type="text" name="project" required placeholder="project slug (e.g. cloud-frontend)"
                style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
              <input type="password" name="apiToken" required placeholder="API token"
                style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
              <input type="text" name="baseUrl" placeholder="Base URL — leave empty for sentry.io"
                style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
              <button class="btn" type="submit">Connect</button>
            </form>
          </div>`
        : html`
          <div class="card" style="display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px;">
            <div>
              <strong>Connected to</strong>
              <code style="margin-left: 6px;">${config.org}/${config.project}</code>
              ${config.baseUrl ? html` <span class="meta">on ${config.baseUrl}</span>` : html` <span class="meta">on sentry.io</span>`}
            </div>
            <form method="post" action="/projects/${encodeURIComponent(host)}/sentry/disconnect" style="margin: 0;"
              onsubmit="return confirm('Disconnect Sentry?')">
              <button class="btn danger" type="submit" style="font-size: 11px;">Disconnect</button>
            </form>
          </div>

          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('Recent issues', correlations.length, '#2f6feb')}
            ${kpi('Matched sessions', matched.length, '#1f9d55')}
            ${kpi('Unmatched issues', unmatched.length, unmatched.length === 0 ? 'var(--muted)' : '#b88300')}
          </div>

          ${matched.length > 0
            ? html`<div class="section">
                <h2>Issues with matching captured sessions</h2>
                <p class="muted" style="font-size: 12px;">These Sentry events fired during your captures — click into the session to see the user flow that produced them.</p>
                ${matched.map((c) => renderCorrelation(c))}
              </div>`
            : ''}

          ${unmatched.length > 0
            ? html`<div class="section">
                <h2>Issues without a matching session</h2>
                <p class="muted" style="font-size: 12px;">Sentry sees these but our captures don't. Either they happened outside the captures we have, or our fingerprint match was too conservative — record a session that reproduces them to bridge.</p>
                ${unmatched.slice(0, 30).map((c) => renderCorrelation(c))}
              </div>`
            : ''}
        `}

      <style>${raw(SENTRY_CSS)}</style>
    `,
  })
}

function renderCorrelation(c: SentryCorrelation): Renderable {
  const issue = c.issue
  return html`<div class="sentry-issue ${c.matchedSessions.length > 0 ? 'matched' : ''}">
    <div class="head">
      <a href="${issue.permalink}" target="_blank" rel="noopener" class="title">${issue.title}</a>
      <span class="meta">${issue.shortId}${issue.metadata?.type ? ` · ${issue.metadata.type}` : ''} · ${issue.count} event${issue.count === '1' ? '' : 's'}${issue.userCount ? ` · ${issue.userCount} user${issue.userCount === 1 ? '' : 's'}` : ''} · last seen ${new Date(issue.lastSeen).toISOString().slice(0, 16).replace('T', ' ')}</span>
    </div>
    ${issue.metadata?.value
      ? html`<div class="value"><code>${issue.metadata.value}</code></div>`
      : ''}
    ${c.matchedSessions.length > 0
      ? html`<div class="matches">
          <strong>Matched sessions (${c.matchedSessions.length}):</strong>
          <ul>${c.matchedSessions.slice(0, 8).map((m) => html`<li><a href="/sessions/${m.sessionId}">${m.sessionId.slice(0, 8)}</a> — <code>${m.matchedMessage.slice(0, 120)}</code></li>`)}</ul>
        </div>`
      : ''}
  </div>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

const SENTRY_CSS = `
.sentry-issue { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.sentry-issue.matched { border-color: color-mix(in oklab, #1f9d55 35%, var(--border)); background: color-mix(in oklab, #1f9d55 4%, transparent); }
.sentry-issue .head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.sentry-issue .title { color: var(--fg); text-decoration: none; font-weight: 600; }
.sentry-issue .title:hover { text-decoration: underline; }
.sentry-issue .value { margin-top: 6px; font-size: 12px; color: var(--muted); word-break: break-word; }
.sentry-issue .value code { font-size: 11px; }
.sentry-issue .matches { margin-top: 8px; font-size: 12px; }
.sentry-issue .matches ul { list-style: none; padding-left: 0; margin: 4px 0 0; }
.sentry-issue .matches li { padding: 2px 0; font-size: 11px; }
.sentry-issue .matches code { font-size: 11px; }
`
