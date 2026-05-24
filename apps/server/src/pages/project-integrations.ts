import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { LinearConfig } from '../storage/linear-config'
import type { SlackConfig } from '../storage/slack-config'
import type { SentryConfig } from '../storage/sentry-config'

// Per-project integrations: Linear (create issues from findings), Slack
// (regression / first-capture notifications), and a quick link to the
// per-project Sentry view (which has its own dedicated page).
export function ProjectIntegrationsPage({
  email,
  host,
  linear,
  slack,
  sentry,
  message,
  error,
}: {
  email: string
  host: string
  linear: LinearConfig | null
  slack: SlackConfig | null
  sentry: SentryConfig | null
  message?: string
  error?: string
}): Renderable {
  return Layout({
    title: `${host} · integrations`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Per-project integrations</h2>
      <p class="muted">External services this project can post to: file Linear issues from findings, ping Slack on regression, see Sentry errors correlated to captured user flows.</p>

      ${message ? html`<div class="card" style="border-color: #1f9d55; background: color-mix(in oklab, #1f9d55 6%, transparent);">${message}</div>` : ''}
      ${error ? html`<div class="error">${error}</div>` : ''}

      <!-- Linear -->
      <div class="section">
        <h2>🟪 Linear</h2>
        <div class="card">
          ${linear
            ? html`<div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px;">
                <div>
                  <strong>Connected</strong> ·
                  <span class="meta">team ${linear.teamKey ?? linear.teamId.slice(0, 8)}</span>
                </div>
                <form method="post" action="/projects/${encodeURIComponent(host)}/integrations/linear/disconnect" style="margin: 0;"
                  onsubmit="return confirm('Disconnect Linear?')">
                  <button class="btn danger" type="submit" style="font-size: 11px;">Disconnect</button>
                </form>
              </div>
              <p class="meta" style="font-size: 11px; margin: 8px 0 0;">
                Every security / a11y / performance finding now gets a "📥 Create Linear issue" button — title + evidence
                prefilled with a link back to the finding.
              </p>`
            : html`<p style="margin-top: 0;"><strong>Create Linear issues from findings.</strong></p>
              <p class="meta" style="font-size: 12px; margin: 6px 0 10px;">
                Create a personal API key in Linear (Settings → API → New personal API key) with default scopes.
                Then pick the team issues should land under.
              </p>
              <form method="post" action="/projects/${encodeURIComponent(host)}/integrations/linear" style="display: grid; gap: 8px; max-width: 540px;">
                <input type="password" name="apiKey" required placeholder="lin_api_..."
                  style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
                <input type="text" name="teamId" required placeholder="Team UUID (from Linear team settings URL)"
                  style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
                <input type="text" name="teamKey" placeholder="Team key (display only, e.g. ENG)"
                  style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
                <button class="btn" type="submit">Connect Linear</button>
              </form>`}
        </div>
      </div>

      <!-- Slack -->
      <div class="section">
        <h2>💬 Slack</h2>
        <div class="card">
          ${slack
            ? html`<div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px;">
                <div>
                  <strong>Connected</strong> · webhook configured
                  ${slack.notifyOnRegression ? html`<span class="badge ok" style="margin-left: 6px;">regression</span>` : ''}
                  ${slack.notifyOnFirstCapture ? html`<span class="badge ok" style="margin-left: 6px;">first capture</span>` : ''}
                </div>
                <div style="display: flex; gap: 6px;">
                  <form method="post" action="/projects/${encodeURIComponent(host)}/integrations/slack/test" style="margin: 0;">
                    <button class="btn secondary" type="submit" style="font-size: 11px;">Send test message</button>
                  </form>
                  <form method="post" action="/projects/${encodeURIComponent(host)}/integrations/slack/disconnect" style="margin: 0;"
                    onsubmit="return confirm('Disconnect Slack?')">
                    <button class="btn danger" type="submit" style="font-size: 11px;">Disconnect</button>
                  </form>
                </div>
              </div>`
            : html`<p style="margin-top: 0;"><strong>Ping Slack when something changes.</strong></p>
              <p class="meta" style="font-size: 12px; margin: 6px 0 10px;">
                Create an Incoming Webhook in your Slack workspace and paste the URL below.
                Notifications fire on new uploads where regression detection finds drift.
              </p>
              <form method="post" action="/projects/${encodeURIComponent(host)}/integrations/slack" style="display: grid; gap: 8px; max-width: 540px;">
                <input type="url" name="webhookUrl" required placeholder="https://hooks.slack.com/services/..."
                  style="padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
                <label style="font-size: 12px; display: flex; gap: 6px; align-items: center;">
                  <input type="checkbox" name="notifyOnRegression" checked /> Notify on regression detected
                </label>
                <label style="font-size: 12px; display: flex; gap: 6px; align-items: center;">
                  <input type="checkbox" name="notifyOnFirstCapture" /> Notify on each new capture (first or otherwise)
                </label>
                <button class="btn" type="submit">Connect Slack</button>
              </form>`}
        </div>
      </div>

      <!-- Sentry (link to existing dedicated page) -->
      <div class="section">
        <h2>🐞 Sentry</h2>
        <div class="card" style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px;">
          <div>
            ${sentry
              ? html`<strong>Connected</strong> · <code>${sentry.org}/${sentry.project}</code>`
              : html`<strong>Not connected</strong> · <span class="meta">Correlate Sentry issues with captured sessions</span>`}
          </div>
          <a class="btn secondary" href="/projects/${encodeURIComponent(host)}/sentry">→ Open Sentry view</a>
        </div>
      </div>

      <style>${raw(INT_CSS)}</style>
    `,
  })
}

const INT_CSS = `
.section h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; text-transform: none; letter-spacing: 0; color: var(--fg); }
`
