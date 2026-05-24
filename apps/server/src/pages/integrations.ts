import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { InstallationRecord } from '../github-app'

export function IntegrationsPage({
  email,
  installations,
  appSlug,
  origin,
}: {
  email: string
  // Installations across all of GitHub the App has been added to. We
  // can't filter to "yours" without an email→org mapping the user hasn't
  // configured yet, so we show every install the App has — useful while
  // bootstrapping, but the listing will get filtered once we add a
  // claim step.
  installations: InstallationRecord[]
  // The App's slug — used to build the install URL. Falls back to a
  // generic "configure your GitHub App" hint.
  appSlug?: string
  origin: string
}): Renderable {
  return Layout({
    title: 'Integrations',
    email,
    body: html`
      <p><a href="/sessions">← back to sessions</a></p>
      <h2 style="margin-top: 4px;">Integrations</h2>
      <p class="muted">External services Unwrap can talk to on your behalf. Each integration is opt-in and uses scoped credentials.</p>

      <div class="section">
        <h2>GitHub App</h2>
        <div class="card">
          <p style="margin-top: 0;">
            <strong>What it does:</strong> after a CI capture, post (or edit) a PR comment
            from the bot identity <code>@${appSlug ?? 'unwrap'}[bot]</code>.
            Replaces the per-developer PAT path — install once at the org level, every
            CI job can comment without secrets.
          </p>
          ${appSlug
            ? html`<a class="btn" href="https://github.com/apps/${appSlug}/installations/new" target="_blank" rel="noopener">
                Install Unwrap GitHub App →
              </a>`
            : html`<div class="muted" style="font-size: 12px;">
                The Unwrap GitHub App isn't configured for this server yet. Ask the operator
                to set <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>,
                <code>GITHUB_APP_WEBHOOK_SECRET</code>, and <code>GITHUB_APP_SLUG</code> env vars,
                and point the webhook at <code>${origin}/webhooks/github</code>.
              </div>`}

          <h3 style="margin-top: 16px; font-size: 13px;">Installations seen by this server (${installations.length})</h3>
          ${installations.length === 0
            ? html`<div class="muted" style="font-size: 12px;">No installations yet.</div>`
            : html`<table class="int-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Type</th>
                    <th>Repositories</th>
                    <th>Installed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${installations.map((i) => html`<tr>
                    <td><strong>${i.accountLogin}</strong>${i.suspended ? html` <span class="meta">(suspended)</span>` : ''}</td>
                    <td><span class="meta">${i.accountType}</span></td>
                    <td>${i.repositories.length === 0
                      ? html`<span class="meta">all (or none yet synced)</span>`
                      : html`<details><summary class="meta">${i.repositories.length} repo${i.repositories.length === 1 ? '' : 's'}</summary>
                          <ul style="margin: 4px 0 0; padding-left: 18px; font-size: 11px;">
                            ${i.repositories.slice(0, 25).map((r) => html`<li><code>${r}</code></li>`)}
                            ${i.repositories.length > 25 ? html`<li class="meta">…+${i.repositories.length - 25} more</li>` : ''}
                          </ul>
                        </details>`}</td>
                    <td class="meta">${new Date(i.installedAt).toISOString().slice(0, 10)}</td>
                    <td><span class="meta" style="font-family: ui-monospace, monospace; font-size: 11px;">id ${i.installationId}</span></td>
                  </tr>`)}
                </tbody>
              </table>`}
        </div>
      </div>

      <div class="section">
        <h2>API tokens</h2>
        <div class="card">
          <p style="margin-top: 0; font-size: 12px;">Long-lived bearer tokens for CLI / scripted uploads.</p>
          <a class="btn secondary" href="/settings/tokens">Manage tokens →</a>
        </div>
      </div>

      <style>${raw(INT_CSS)}</style>
    `,
  })
}

const INT_CSS = `
.int-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.int-table th, .int-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.int-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.int-table tr:last-child td { border-bottom: 0; }
.int-table code { font-size: 11px; }
`
