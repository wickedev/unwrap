import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectWsChannel } from '../project-websockets'

export function ProjectWebSocketsPage({
  email,
  host,
  channels,
}: {
  email: string
  host: string
  channels: ProjectWsChannel[]
}): Renderable {
  const totalMessages = channels.reduce((n, c) => n + c.totalSendCount + c.totalRecvCount, 0)
  const totalBytes = channels.reduce((n, c) => n + c.totalSendBytes + c.totalRecvBytes, 0)

  return Layout({
    title: `${host} · WebSockets`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">WebSocket channels</h2>
      <p class="muted">
        Realtime traffic captured during the recorded sessions, grouped by endpoint and message-type
        discriminator (Socket.IO <code>event</code>, GraphQL-WS <code>type</code>, JSON-RPC <code>method</code>, …).
        Reveals the parallel realtime protocol that the REST/GraphQL inventory misses.
      </p>

      ${channels.length === 0
        ? html`<div class="empty">
            <p>No WebSocket traffic captured for this project.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              Either this service doesn't use WebSockets, or the captures were made before the WS
              collector shipped. Reload the extension and record a fresh session if you expect to see
              something here.
            </p>
          </div>`
        : html`
          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('Channels', channels.length, '#7c4ac2')}
            ${kpi('Messages', totalMessages, '#2f6feb')}
            ${kpi('Bytes', formatBytes(totalBytes), 'var(--fg)')}
            ${kpi('Distinct types', channels.reduce((n, c) => n + c.messageTypes.length, 0), '#1f9d55')}
          </div>

          ${channels.map((ch) => renderChannel(ch))}
        `}

      <style>${raw(WS_CSS)}</style>
    `,
  })
}

function renderChannel(ch: ProjectWsChannel): Renderable {
  return html`<div class="ws-channel">
    <div class="ws-head">
      <div>
        <code style="font-size: 12px; word-break: break-all;">${ch.url}</code>
        <div class="meta" style="font-size: 11px; margin-top: 2px;">
          <span style="color: #1f9d55;">↑ ${ch.totalSendCount} sent</span> ·
          <span style="color: #2f6feb;">↓ ${ch.totalRecvCount} received</span> ·
          ${formatBytes(ch.totalSendBytes + ch.totalRecvBytes)} total ·
          ${ch.sessionCount} session${ch.sessionCount === 1 ? '' : 's'}
        </div>
      </div>
    </div>
    ${ch.messageTypes.length === 0
      ? html`<div class="muted" style="font-size: 11px; padding: 8px 0;">No text frames captured (binary-only channel?).</div>`
      : html`<table class="ws-table">
          <thead>
            <tr>
              <th>Message key</th>
              <th>Direction</th>
              <th style="text-align: right;">Count</th>
              <th style="text-align: right;">Bytes</th>
              <th>Inferred shape · sample</th>
            </tr>
          </thead>
          <tbody>
            ${ch.messageTypes.map((t) => html`<tr>
              <td><code>${t.key}</code></td>
              <td><span class="dir dir-${t.direction}">${t.direction}</span></td>
              <td style="text-align: right;">${t.count}</td>
              <td style="text-align: right;">${formatBytes(t.bytes)}</td>
              <td>
                ${t.inferredShape
                  ? html`<details><summary class="muted" style="font-size: 11px;">show shape + sample</summary>
                      <pre style="margin: 6px 0 0; font-size: 11px;"><code>${t.inferredShape}</code></pre>
                      ${t.sample
                        ? html`<pre style="margin-top: 4px; font-size: 11px; background: rgba(127,127,127,0.05);"><code>${truncate(prettyJson(t.sample), 1500)}</code></pre>`
                        : ''}
                    </details>`
                  : html`<span class="muted" style="font-size: 11px;">no JSON payload</span>`}
              </td>
            </tr>`)}
          </tbody>
        </table>`}
  </div>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const WS_CSS = `
.ws-channel { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 14px; background: var(--bg); }
.ws-head { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.ws-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ws-table th, .ws-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.ws-table th { font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.ws-table tr:last-child td { border-bottom: 0; }
.ws-table code { font-size: 11px; }
.dir { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.dir-send { background: color-mix(in oklab, #1f9d55 18%, transparent); color: #1f9d55; }
.dir-recv { background: color-mix(in oklab, #2f6feb 18%, transparent); color: #2f6feb; }
.dir-both { background: color-mix(in oklab, #7c4ac2 18%, transparent); color: #7c4ac2; }
`
