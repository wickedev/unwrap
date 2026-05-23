import { html, raw } from 'hono/html'
import type { StoredSession } from '@unwrap/protocol'
import type { Renderable } from './layout'

// One row on the chronological timeline. `kind` drives the icon + tint
// and the filter chip the row sits behind.
interface Row {
  kind: 'navigation' | 'action' | 'response' | 'console' | 'exception' | 'screenshot'
  ts: number
  title: string
  body?: string
  url?: string
  status?: 'ok' | 'warn' | 'error'
  raw?: unknown
}

const KIND_META: Record<Row['kind'], { label: string; symbol: string; color: string; bg: string }> = {
  navigation: { label: 'nav', symbol: '↗', color: '#2f6feb', bg: 'rgba(47,111,235,0.08)' },
  action:     { label: 'act', symbol: '◉', color: '#1f9d55', bg: 'rgba(31,157,85,0.08)' },
  response:   { label: 'net', symbol: '⇄', color: '#8c8c8c', bg: 'rgba(140,140,140,0.06)' },
  console:    { label: 'log', symbol: '✎', color: '#b88300', bg: 'rgba(184,131,0,0.08)' },
  exception:  { label: 'err', symbol: '!', color: '#d64545', bg: 'rgba(214,69,69,0.08)' },
  screenshot: { label: 'shot', symbol: '◳', color: '#7c4ac2', bg: 'rgba(124,74,194,0.08)' },
}

export function renderTimeline(session: StoredSession): Renderable {
  const sessionStart = new Date(session.summary.meta.startedAt).getTime()
  const rows: Row[] = []

  for (const n of session.summary.navigations) {
    rows.push({
      kind: 'navigation',
      ts: n.ts,
      title: 'Navigated',
      body: n.url,
      url: n.url,
    })
  }

  for (const a of session.summary.actions) {
    const d = a.details ?? {}
    let body = a.selector?.primary ?? ''
    if (a.type === 'input' && typeof d['value'] === 'string') {
      body = `${body}\n→ value: ${truncate(String(d['value']), 80)}`
    } else if (a.type === 'input' && d['redacted']) {
      body = `${body}\n→ [REDACTED]`
    } else if (a.type === 'change' && 'checked' in d) {
      body = `${body}\n→ checked: ${d['checked']}`
    } else if (a.type === 'key' && typeof d['key'] === 'string') {
      body = `${body}\n→ key: ${d['key']}`
    }
    rows.push({
      kind: 'action',
      ts: a.ts,
      title: `${a.type}`,
      body,
      url: a.url,
    })
  }

  for (const r of session.summary.significantResponses) {
    rows.push({
      kind: 'response',
      ts: r.ts ?? sessionStart,
      title: `${r.status} · ${r.mimeType || '?'}`,
      body: r.url,
      url: r.url,
      status: r.status >= 500 ? 'error' : r.status >= 400 ? 'warn' : 'ok',
    })
  }

  for (const c of session.summary.consoleErrors) {
    rows.push({
      kind: 'console',
      ts: c.ts,
      title: 'console.error',
      body: c.message,
      status: 'error',
    })
  }

  for (const e of session.summary.exceptions) {
    rows.push({
      kind: 'exception',
      ts: e.ts,
      title: 'exception',
      body: e.stack ? `${e.message}\n${e.stack}` : e.message,
      status: 'error',
    })
  }

  for (const s of session.verifyScreenshotMeta ?? []) {
    rows.push({
      kind: 'screenshot',
      ts: s.originalTs,
      title: 'Screenshot captured',
      body: `${s.width}×${s.height} · ${s.url}`,
      url: s.url,
      raw: s.storedRef,
    })
  }

  // Sort ascending by ts (stable insertion order keeps same-ts rows
  // grouped by the kind iteration above).
  rows.sort((a, b) => a.ts - b.ts)

  if (rows.length === 0) {
    return html`
      <div class="card">
        <div class="muted">No timeline events captured.</div>
      </div>
    `
  }

  const totalDuration = (rows[rows.length - 1]!.ts - sessionStart) || 1
  const kindCounts: Record<Row['kind'], number> = {
    navigation: 0, action: 0, response: 0, console: 0, exception: 0, screenshot: 0,
  }
  for (const r of rows) kindCounts[r.kind]++

  const screenshotBase = `/api/sessions/${session.id}/screenshots`

  return html`
    <div class="card" style="padding: 12px;">
      <div class="timeline-toolbar">
        <div class="meta" style="font-size:11px;">
          ${rows.length} event${rows.length === 1 ? '' : 's'} ·
          spans ${formatDuration(totalDuration)} ·
          ${new Date(rows[0]!.ts).toLocaleTimeString()} → ${new Date(rows[rows.length - 1]!.ts).toLocaleTimeString()}
        </div>
        <div class="timeline-filters">
          ${(Object.keys(KIND_META) as Row['kind'][]).map((k) => {
            const m = KIND_META[k]
            return html`<button class="timeline-chip" data-kind="${k}"
              style="border-color:${m.color}; color:${m.color}; background:${m.bg};">
              <span style="margin-right:4px;">${m.symbol}</span>${m.label} · ${kindCounts[k]}
            </button>`
          })}
        </div>
      </div>

      <ol class="timeline">
        ${rows.map((row) => {
          const m = KIND_META[row.kind]
          const rel = row.ts - sessionStart
          const pct = ((rel / totalDuration) * 100).toFixed(1)
          const statusColor = row.status === 'error'
            ? '#d64545'
            : row.status === 'warn'
              ? '#b88300'
              : row.status === 'ok'
                ? '#1f9d55'
                : m.color
          const isShot = row.kind === 'screenshot' && typeof row.raw === 'string'
          return html`<li class="timeline-row" data-kind="${row.kind}">
            <div class="timeline-marker" style="color:${m.color};" title="${m.label}">
              <span class="timeline-symbol">${m.symbol}</span>
              <span class="timeline-rel" title="${formatTime(new Date(row.ts))}">
                ${formatRelative(rel)}
              </span>
              <span class="timeline-bar"><span style="width:${pct}%; background:${m.color};"></span></span>
            </div>
            <div class="timeline-body">
              <div class="timeline-title" style="color:${statusColor};">${row.title}</div>
              ${row.body
                ? html`<div class="timeline-detail">${row.body}</div>`
                : ''}
              ${isShot
                ? html`<a href="${screenshotBase}/${row.raw}" target="_blank" style="display:inline-block; margin-top:4px;">
                    <img src="${screenshotBase}/${row.raw}" alt="screenshot" loading="lazy"
                         style="max-width: 240px; max-height: 160px; border-radius:4px; border:1px solid var(--border); background:#fff;" />
                  </a>`
                : ''}
            </div>
          </li>`
        })}
      </ol>
    </div>

    <style>${raw(TIMELINE_CSS)}</style>
    <script>${raw(TIMELINE_JS)}</script>
  `
}

const TIMELINE_CSS = `
.timeline-toolbar { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom: 14px; }
.timeline-filters { display:flex; gap:6px; flex-wrap:wrap; }
.timeline-chip {
  padding: 3px 8px; border-radius: 999px; border: 1px solid; font-size: 11px;
  cursor: pointer; font-family: inherit; line-height: 1.6; background: transparent;
  opacity: 1; transition: opacity 120ms;
}
.timeline-chip.off { opacity: 0.3; }
.timeline { list-style: none; padding: 0; margin: 0; display:flex; flex-direction: column; gap: 6px; }
.timeline-row { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 8px 10px; border-radius: 6px; border: 1px solid transparent; }
.timeline-row:hover { background: rgba(127,127,127,0.05); border-color: var(--border); }
.timeline-row.hidden { display: none; }
.timeline-marker { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; font-size: 11px; }
.timeline-marker .timeline-symbol { font-size: 13px; font-weight: 700; }
.timeline-rel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.timeline-bar { width: 100%; height: 3px; background: rgba(127,127,127,0.15); border-radius: 999px; overflow: hidden; }
.timeline-bar span { display: block; height: 100%; min-width: 2px; }
.timeline-body { min-width: 0; }
.timeline-title { font-weight: 600; font-size: 12px; word-break: break-word; }
.timeline-detail {
  margin-top: 2px; font-size: 11px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-word;
}
`

const TIMELINE_JS = `
(function(){
  const chips = document.querySelectorAll('.timeline-chip');
  const rows = document.querySelectorAll('.timeline-row');
  const off = new Set();
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const k = chip.getAttribute('data-kind');
      if (!k) return;
      if (off.has(k)) { off.delete(k); chip.classList.remove('off'); }
      else { off.add(k); chip.classList.add('off'); }
      rows.forEach((row) => {
        const rk = row.getAttribute('data-kind');
        if (!rk) return;
        row.classList.toggle('hidden', off.has(rk));
      });
    });
  });
})();
`

function formatRelative(ms: number): string {
  if (ms < 0) return '-' + formatRelative(-ms)
  if (ms < 1000) return `+${ms}ms`
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `+${m}m${s.toString().padStart(2, '0')}s`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString()
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
