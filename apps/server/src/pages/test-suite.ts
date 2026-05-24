import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { CanonicalTestRecord } from '../storage/canonical-tests'
import type { StoredSession } from '@unwrap/protocol'

export function TestSuitePage({
  email,
  host,
  canonical,
  sessionsById,
  candidates,
  share,
}: {
  email: string
  host: string
  canonical: CanonicalTestRecord[]
  sessionsById: Map<string, StoredSession>
  // Sessions WITH a generated spec that aren't yet canonical — surfaced
  // as add-candidates so the user can promote them in one click.
  candidates: { sessionId: string; uploadedAt: number }[]
  share?: { token: string }
}): Renderable {
  const isShareView = !!share
  const link = (subPath: string) =>
    isShareView
      ? `/share/${share!.token}${subPath}`
      : `/projects/${encodeURIComponent(host)}${subPath}`
  const withSpec = canonical.filter((c) => sessionsById.get(c.sessionId)?.generated?.spec)
  const missing = canonical.length - withSpec.length

  return Layout({
    title: `${host} · canonical tests`,
    email,
    body: html`
      <p><a href="${isShareView ? `/share/${share!.token}` : `/projects/${encodeURIComponent(host)}`}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Canonical test suite</h2>
      <p class="muted">
        Sessions you've marked as the project's "golden flows." Bundle exports as a runnable
        Playwright project (npm install → npx playwright test) so CI can pin against the same
        captured behavior on every PR.
      </p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Canonical specs', withSpec.length, '#1f9d55')}
        ${kpi('Candidates', candidates.length, '#2f6feb')}
        ${missing > 0 ? kpi('Missing spec', missing, '#d64545') : ''}
      </div>

      ${withSpec.length > 0 && !isShareView
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; border-color: var(--accent);">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">↓ Test suite bundle</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                Single zip with playwright.config.ts + package.json + one .spec.ts per canonical
                test + README. Drop into CI as a self-contained Playwright project.
              </div>
            </div>
            <a class="btn" href="${link('/tests.zip')}" download>↓ Download tests.zip</a>
          </div>`
        : isShareView && withSpec.length > 0
          ? html`<div class="card" style="margin-bottom: 16px;">
              <a class="btn" href="${link('/tests.zip')}" download>↓ Download tests.zip</a>
            </div>`
          : ''}

      <div class="section">
        <h2>Canonical tests (${canonical.length})</h2>
        ${canonical.length === 0
          ? html`<div class="empty">
              <p>No canonical tests yet.</p>
              <p style="margin-top: 12px; font-size: 12px;">
                Open any session with a generated spec and click "Mark as canonical test."
                Candidates are listed below.
              </p>
            </div>`
          : html`<div class="card" style="padding: 0; overflow: hidden;">
              <table class="ts-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Tags</th>
                    <th>Source session</th>
                    <th style="text-align: right;">Added</th>
                    ${isShareView ? '' : html`<th></th>`}
                  </tr>
                </thead>
                <tbody>
                  ${canonical.map((c) => renderCanonicalRow(c, sessionsById, host, isShareView))}
                </tbody>
              </table>
            </div>`}
      </div>

      ${!isShareView && candidates.length > 0
        ? html`<div class="section">
            <h2>Candidates — sessions with a spec, not yet canonical (${candidates.length})</h2>
            <p class="muted" style="font-size: 12px;">Each has a Gemini-generated Playwright spec ready to promote.</p>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="ts-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Start URL</th>
                    <th style="text-align: right;">Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${candidates.map((c) => renderCandidateRow(c, sessionsById, host))}
                </tbody>
              </table>
            </div>
          </div>`
        : ''}

      <style>${raw(TS_CSS)}</style>
    `,
  })
}

function renderCanonicalRow(
  c: CanonicalTestRecord,
  sessionsById: Map<string, StoredSession>,
  host: string,
  isShareView: boolean,
): Renderable {
  const session = sessionsById.get(c.sessionId)
  const hasSpec = !!session?.generated?.spec
  return html`<tr>
    <td>${hasSpec ? c.name : html`<span style="color: #d64545;" title="Source session lacks a generated spec — regenerate from its detail page">${c.name} ⚠</span>`}</td>
    <td>${c.tags.length > 0 ? html`${c.tags.map((t) => html`<span class="tag-pill">${t}</span>`)}` : html`<span class="meta">—</span>`}</td>
    <td><a href="/sessions/${c.sessionId}" style="font-family: ui-monospace, monospace; font-size: 11px;">${c.sessionId.slice(0, 8)}</a></td>
    <td style="text-align: right;" class="meta">${new Date(c.addedAt).toISOString().slice(0, 10)}</td>
    ${isShareView
      ? ''
      : html`<td>
          <form method="post" action="/projects/${encodeURIComponent(host)}/tests/${encodeURIComponent(c.sessionId)}/remove" style="margin: 0;"
            onsubmit="return confirm('Remove ${c.name} from the canonical suite?')">
            <button class="btn danger" type="submit" style="font-size: 11px; padding: 4px 10px;">Remove</button>
          </form>
        </td>`}
  </tr>`
}

function renderCandidateRow(
  c: { sessionId: string; uploadedAt: number },
  sessionsById: Map<string, StoredSession>,
  host: string,
): Renderable {
  const session = sessionsById.get(c.sessionId)
  const startUrl = session?.summary.meta.url ?? ''
  return html`<tr>
    <td><a href="/sessions/${c.sessionId}" style="font-family: ui-monospace, monospace; font-size: 11px;">${c.sessionId.slice(0, 8)}</a></td>
    <td><code style="font-size: 11px;">${truncate(startUrl, 64)}</code></td>
    <td style="text-align: right;" class="meta">${relativeTime(c.uploadedAt)}</td>
    <td>
      <form method="post" action="/projects/${encodeURIComponent(host)}/tests" style="display: flex; gap: 6px; align-items: center; margin: 0;">
        <input type="hidden" name="sessionId" value="${c.sessionId}" />
        <input type="text" name="name" required maxlength="80" placeholder="test name"
          style="flex: 1; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); font: inherit; font-size: 12px;" />
        <button type="submit" class="btn secondary" style="font-size: 11px; padding: 4px 10px;">Promote</button>
      </form>
    </td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const TS_CSS = `
.ts-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ts-table th, .ts-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ts-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.ts-table tr:last-child td { border-bottom: 0; }
.tag-pill { display: inline-block; padding: 1px 8px; background: rgba(127,127,127,0.1); border-radius: 999px; font-size: 11px; margin-right: 4px; }
`
