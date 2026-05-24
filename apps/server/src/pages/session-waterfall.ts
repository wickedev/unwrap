import { html, raw } from 'hono/html'
import type { StoredSession } from '@unwrap/protocol'
import type { Renderable } from './layout'

// A compact horizontal waterfall view of the session. Complements (not
// replaces) the chronological event list in timeline.ts. Where the list
// is good for "show me each event with detail", the waterfall reveals
// temporal density — clusters of network activity after each nav, dead
// air between user actions, where errors fell in the timeline. Useful
// for the "what shape was this session" question at a glance.
//
// Lanes (top → bottom):
//   nav       — page navigations (also vertical guides across all lanes)
//   action    — user clicks / inputs / submits
//   api       — captured API calls (from summary.apiCalls)
//   asset     — static asset loads (from summary.staticAssets — if present
//                with ts; otherwise omitted)
//   screen    — screenshot captures (also clickable thumbnails)
//   error     — console errors + exceptions
interface LaneEvent {
  ts: number
  color: string
  title: string
}

const LANE_COLORS = {
  nav: '#2f6feb',
  action: '#1f9d55',
  api: '#8c8c8c',
  asset: '#7c4ac2',
  screen: '#b88300',
  error: '#d64545',
} as const

type LaneKey = keyof typeof LANE_COLORS

const LANE_LABELS: Record<LaneKey, string> = {
  nav: 'navigations',
  action: 'user actions',
  api: 'API calls',
  asset: 'static assets',
  screen: 'screenshots',
  error: 'errors',
}

export function renderSessionWaterfall(session: StoredSession): Renderable {
  const sessionStart = new Date(session.summary.meta.startedAt).getTime()
  const summary = session.summary
  const lanes: Record<LaneKey, LaneEvent[]> = {
    nav: [],
    action: [],
    api: [],
    asset: [],
    screen: [],
    error: [],
  }

  for (const n of summary.navigations ?? []) {
    lanes.nav.push({ ts: n.ts, color: LANE_COLORS.nav, title: `nav → ${n.url}` })
  }
  for (const a of summary.actions ?? []) {
    lanes.action.push({ ts: a.ts, color: LANE_COLORS.action, title: `${a.type} on ${a.selector?.primary ?? '?'}` })
  }
  for (const c of summary.apiCalls ?? []) {
    if (typeof c.ts !== 'number') continue
    const color = c.status >= 500 ? '#d64545' : c.status >= 400 ? '#b88300' : LANE_COLORS.api
    lanes.api.push({ ts: c.ts, color, title: `${c.method} ${c.url} → ${c.status}` })
  }
  // staticAssets in the protocol doesn't carry a ts — derive from significantResponses
  // when the URL matches (rough approximation; we don't have a direct timestamp).
  for (const r of summary.significantResponses ?? []) {
    if (typeof r.ts !== 'number') continue
    if (!/\.(html?|css|js|svg|png|jpg|jpeg|gif|woff2?|ttf|webp|ico)(?:\?|$)/i.test(r.url)) continue
    lanes.asset.push({ ts: r.ts, color: LANE_COLORS.asset, title: `${r.status} ${r.url}` })
  }
  for (const s of session.verifyScreenshotMeta ?? []) {
    lanes.screen.push({ ts: s.originalTs, color: LANE_COLORS.screen, title: `screenshot ${s.width}×${s.height}` })
  }
  for (const c of summary.consoleErrors ?? []) {
    lanes.error.push({ ts: c.ts, color: LANE_COLORS.error, title: `console.error: ${c.message.slice(0, 120)}` })
  }
  for (const e of summary.exceptions ?? []) {
    lanes.error.push({ ts: e.ts, color: LANE_COLORS.error, title: `exception: ${e.message.slice(0, 120)}` })
  }

  // Bound the time axis to actual event range, falling back to the
  // session's declared duration so empty lanes still have something to
  // draw against.
  const allTs = (Object.values(lanes) as LaneEvent[][]).flat().map((e) => e.ts)
  const firstTs = allTs.length > 0 ? Math.min(...allTs, sessionStart) : sessionStart
  const lastTs = allTs.length > 0 ? Math.max(...allTs) : sessionStart + summary.meta.durationMs
  const totalMs = Math.max(1, lastTs - firstTs)

  const laneOrder: LaneKey[] = ['nav', 'action', 'api', 'asset', 'screen', 'error']
  const laneHeight = 28
  const tickH = 16
  const labelW = 110
  const rightPad = 16
  const topPad = 24 // for axis labels
  const bottomPad = 4
  const usedLanes = laneOrder.filter((k) => lanes[k].length > 0)
  if (usedLanes.length === 0) return html``

  const width = 1100
  const innerW = width - labelW - rightPad
  const height = topPad + usedLanes.length * laneHeight + bottomPad
  const x = (ts: number) => labelW + ((ts - firstTs) / totalMs) * innerW
  const laneY = (i: number) => topPad + i * laneHeight + laneHeight / 2

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMin meet" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">`)

  // Time axis ticks (5 evenly-spaced relative timestamps)
  for (let i = 0; i <= 5; i++) {
    const ts = firstTs + (totalMs * i) / 5
    const xPos = x(ts)
    const rel = ts - firstTs
    out.push(`<text x="${xPos}" y="14" text-anchor="middle" fill="currentColor" opacity="0.55">${formatRel(rel)}</text>`)
    out.push(`<line x1="${xPos}" y1="${topPad}" x2="${xPos}" y2="${height - bottomPad}" stroke="currentColor" stroke-opacity="0.08"/>`)
  }

  // Navigation vertical guides (full-height anchors at each nav ts)
  for (const n of lanes.nav) {
    const xPos = x(n.ts)
    out.push(`<line x1="${xPos}" y1="${topPad}" x2="${xPos}" y2="${height - bottomPad}" stroke="${LANE_COLORS.nav}" stroke-opacity="0.18" stroke-dasharray="2,3"/>`)
  }

  // Lane rows
  for (let li = 0; li < usedLanes.length; li++) {
    const laneKey = usedLanes[li]!
    const y = laneY(li)
    out.push(`<text x="${labelW - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="currentColor" opacity="0.7">${LANE_LABELS[laneKey]} (${lanes[laneKey].length})</text>`)
    out.push(`<line x1="${labelW}" y1="${y}" x2="${width - rightPad}" y2="${y}" stroke="currentColor" stroke-opacity="0.06"/>`)
    for (const ev of lanes[laneKey]) {
      const xPos = x(ev.ts)
      out.push(`<rect x="${(xPos - 1).toFixed(1)}" y="${y - tickH / 2}" width="2" height="${tickH}" fill="${ev.color}" rx="1"><title>${esc(formatRel(ev.ts - firstTs))} · ${esc(ev.title)}</title></rect>`)
    }
  }

  out.push(`</svg>`)

  const totalEvents = (Object.values(lanes) as LaneEvent[][]).reduce((n, l) => n + l.length, 0)

  return html`
    <div class="card" style="padding: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
        <strong style="font-size: 13px;">Session waterfall</strong>
        <span class="meta" style="font-size: 11px;">${totalEvents} events across ${usedLanes.length} lane${usedLanes.length === 1 ? '' : 's'} · ${formatRel(totalMs)} span · dotted lines mark navigations</span>
      </div>
      <div style="overflow-x: auto;">${raw(out.join(''))}</div>
    </div>
  `
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatRel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
