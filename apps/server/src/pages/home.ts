import { html } from 'hono/html'
import type { SessionListItem } from '@unwrap/protocol'
import { Layout, type Renderable } from './layout'

export function LoginPage(): Renderable {
  return Layout({
    title: 'Sign in',
    body: html`
      <div class="empty">
        <h2 style="font-size: 18px; margin-bottom: 8px;">Welcome to Unwrap</h2>
        <p class="muted">Sign in with Google to view and generate Playwright specs for the sessions your extension uploads.</p>
        <p style="margin-top: 28px;"><a class="btn" href="/auth/google/start?mode=web">Sign in with Google</a></p>
      </div>
    `,
  })
}

export function SessionsPage({ email, sessions }: { email: string; sessions: SessionListItem[] }): Renderable {
  return Layout({
    title: 'Sessions',
    email,
    body: html`
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: 16px;">
        <h2 style="margin:0;">Uploaded sessions</h2>
        <span class="muted">${sessions.length} session${sessions.length === 1 ? '' : 's'}</span>
      </div>
      ${sessions.length === 0
        ? html`
            <div class="empty">
              No sessions uploaded yet. In the Unwrap extension, record a session and click
              <strong>⤴ Upload &amp; open</strong>.
            </div>
          `
        : html`<div>
            ${sessions.map((s) => html`
              <div class="card">
                <div class="row">
                  <div style="min-width:0;">
                    <h3><a href="/sessions/${s.id}">${s.host || '(no host)'}</a></h3>
                    <div class="meta" title="${s.startUrl}">${truncate(s.startUrl, 70)}</div>
                    <div class="meta">
                      uploaded ${relativeTime(s.uploadedAt)} · duration ${formatDuration(s.durationMs)}
                    </div>
                  </div>
                  <div>
                    ${s.hasGeneratedSpec
                      ? html`<span class="badge ok">spec ready</span>`
                      : html`<span class="badge">not generated</span>`}
                  </div>
                </div>
              </div>
            `)}
          </div>`}
    `,
  })
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
