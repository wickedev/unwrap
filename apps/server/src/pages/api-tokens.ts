import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ApiTokenRecord } from '../storage/api-tokens'

export function ApiTokensPage({
  email,
  tokens,
  // When present, this is a freshly-minted token — we show it ONCE here
  // because the KV-stored copy is hashed-shaped (full string) but UX-wise
  // we treat it as "view once" so users learn to copy it immediately.
  // (Implementation still stores the full token; this is just convention.)
  freshlyMinted,
  origin,
}: {
  email: string
  tokens: ApiTokenRecord[]
  freshlyMinted?: ApiTokenRecord
  origin: string
}): Renderable {
  return Layout({
    title: 'API tokens',
    email,
    body: html`
      <p><a href="/sessions">← back to sessions</a></p>
      <h2 style="margin-top: 4px;">API tokens</h2>
      <p class="muted">Long-lived bearer tokens for uploading captures from CI or scripts. Use them with the <code>unwrap-cli</code> package or in any HTTP client.</p>

      ${freshlyMinted
        ? html`<div class="card" style="border-color: #1f9d55; background: color-mix(in oklab, #1f9d55 4%, transparent); margin-bottom: 16px;">
            <strong>New token created — copy it now.</strong>
            <div class="meta" style="font-size: 11px; margin-top: 4px;">This is the only time the full token is shown in the UI. Treat it like a password.</div>
            <pre style="margin: 8px 0 0;"><code>${freshlyMinted.token}</code></pre>
          </div>`
        : ''}

      <div class="card" style="margin-bottom: 16px;">
        <form method="post" action="/api/tokens" style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
          <input type="text" name="label" required maxlength="80" placeholder="Label (e.g. github-actions, local-dev)"
            style="flex: 1; min-width: 240px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;" />
          <button type="submit" class="btn">Mint token</button>
        </form>
      </div>

      <div class="section">
        <h2>Existing tokens (${tokens.length})</h2>
        ${tokens.length === 0
          ? html`<div class="muted">No tokens yet.</div>`
          : html`<div class="card" style="padding: 0;">
              <table class="tk-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Token</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${tokens.map((t) => html`<tr>
                    <td>${t.label}</td>
                    <td><code>${t.token.slice(0, 10)}…${t.token.slice(-4)}</code></td>
                    <td class="meta">${new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td>
                      <form method="post" action="/api/tokens/${encodeURIComponent(t.token)}/revoke" style="margin: 0;"
                        onsubmit="return confirm('Revoke this token? Any caller using it will get 401.')">
                        <button type="submit" class="btn danger" style="font-size: 11px; padding: 4px 10px;">Revoke</button>
                      </form>
                    </td>
                  </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>

      <div class="section">
        <h2>Usage</h2>
        <div class="card">
          <p style="margin-top: 0;">Capture a list of URLs with the CLI (drives headless Chromium via Playwright):</p>
          <pre><code>npx @unwrap/cli capture \\
  --server=${origin} \\
  --token=&lt;your token&gt; \\
  --host=staging.example.com \\
  https://staging.example.com/login \\
  https://staging.example.com/dashboard</code></pre>
          <p>Or upload a session blob from any HTTP client:</p>
          <pre><code>curl -X POST ${origin}/api/sessions \\
  -H "Authorization: Bearer &lt;your token&gt;" \\
  -H "Content-Type: application/json" \\
  -d @session.json</code></pre>
          <p class="meta" style="font-size: 11px;">Uploads landing on a host that already has prior captures auto-diff against the most recent one — surface the diff on the project page or fetch via <code>GET /projects/&lt;host&gt;/diff/&lt;other&gt;</code>.</p>
        </div>
      </div>

      <style>${raw(TK_CSS)}</style>
    `,
  })
}

const TK_CSS = `
.tk-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.tk-table th, .tk-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.tk-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.tk-table tr:last-child td { border-bottom: 0; }
.tk-table code { font-size: 11px; }
`
