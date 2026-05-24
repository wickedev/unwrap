import type { StoredSession } from '@unwrap/protocol'

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
  nav: 'navigations', action: 'user actions', api: 'API calls', asset: 'static assets', screen: 'screenshots', error: 'errors',
}

export function SessionWaterfall({ session }: { session: StoredSession }) {
  const sessionStart = new Date(session.summary.meta.startedAt).getTime()
  const summary = session.summary
  const lanes: Record<LaneKey, { ts: number; color: string; title: string }[]> = {
    nav: [], action: [], api: [], asset: [], screen: [], error: [],
  }
  for (const n of summary.navigations ?? []) lanes.nav.push({ ts: n.ts, color: LANE_COLORS.nav, title: `nav → ${n.url}` })
  for (const a of summary.actions ?? []) lanes.action.push({ ts: a.ts, color: LANE_COLORS.action, title: `${a.type} on ${a.selector?.primary ?? '?'}` })
  for (const c of summary.apiCalls ?? []) {
    if (typeof c.ts !== 'number') continue
    const color = c.status >= 500 ? '#d64545' : c.status >= 400 ? '#b88300' : LANE_COLORS.api
    lanes.api.push({ ts: c.ts, color, title: `${c.method} ${c.url} → ${c.status}` })
  }
  for (const r of summary.significantResponses ?? []) {
    if (typeof r.ts !== 'number') continue
    if (!/\.(html?|css|js|svg|png|jpg|jpeg|gif|woff2?|ttf|webp|ico)(?:\?|$)/i.test(r.url)) continue
    lanes.asset.push({ ts: r.ts, color: LANE_COLORS.asset, title: `${r.status} ${r.url}` })
  }
  for (const s of session.verifyScreenshotMeta ?? []) lanes.screen.push({ ts: s.originalTs, color: LANE_COLORS.screen, title: `screenshot ${s.width}×${s.height}` })
  for (const c of summary.consoleErrors ?? []) lanes.error.push({ ts: c.ts, color: LANE_COLORS.error, title: `console.error: ${c.message.slice(0, 120)}` })
  for (const e of summary.exceptions ?? []) lanes.error.push({ ts: e.ts, color: LANE_COLORS.error, title: `exception: ${e.message.slice(0, 120)}` })

  const allTs = (Object.values(lanes) as { ts: number }[][]).flat().map((e) => e.ts)
  const firstTs = allTs.length > 0 ? Math.min(...allTs, sessionStart) : sessionStart
  const lastTs = allTs.length > 0 ? Math.max(...allTs) : sessionStart + summary.meta.durationMs
  const totalMs = Math.max(1, lastTs - firstTs)

  const laneOrder: LaneKey[] = ['nav', 'action', 'api', 'asset', 'screen', 'error']
  const usedLanes = laneOrder.filter((k) => lanes[k].length > 0)
  if (usedLanes.length === 0) return null

  const width = 1100
  const laneHeight = 28
  const tickH = 16
  const labelW = 110
  const rightPad = 16
  const topPad = 24
  const bottomPad = 4
  const innerW = width - labelW - rightPad
  const height = topPad + usedLanes.length * laneHeight + bottomPad
  const x = (ts: number) => labelW + ((ts - firstTs) / totalMs) * innerW
  const laneY = (i: number) => topPad + i * laneHeight + laneHeight / 2
  const totalEvents = (Object.values(lanes) as { ts: number }[][]).reduce((n, l) => n + l.length, 0)

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex justify-between items-baseline flex-wrap gap-2 mb-2">
        <strong className="text-sm">Session waterfall</strong>
        <span className="text-xs text-muted-foreground">{totalEvents} events across {usedLanes.length} lane{usedLanes.length === 1 ? '' : 's'} · {formatRel(totalMs)} span · dotted lines mark navigations</span>
      </div>
      <div className="overflow-x-auto">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          preserveAspectRatio="xMidYMin meet"
          fontFamily="ui-monospace, monospace"
          fontSize={10}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const ts = firstTs + (totalMs * i) / 5
            const xPos = x(ts)
            return (
              <g key={i}>
                <text x={xPos} y={14} textAnchor="middle" fill="currentColor" opacity={0.55}>{formatRel(ts - firstTs)}</text>
                <line x1={xPos} y1={topPad} x2={xPos} y2={height - bottomPad} stroke="currentColor" strokeOpacity={0.08} />
              </g>
            )
          })}
          {lanes.nav.map((n, i) => {
            const xPos = x(n.ts)
            return <line key={`nv${i}`} x1={xPos} y1={topPad} x2={xPos} y2={height - bottomPad} stroke={LANE_COLORS.nav} strokeOpacity={0.18} strokeDasharray="2,3" />
          })}
          {usedLanes.map((laneKey, li) => {
            const y = laneY(li)
            return (
              <g key={laneKey}>
                <text x={labelW - 8} y={y} textAnchor="end" dominantBaseline="middle" fill="currentColor" opacity={0.7}>
                  {LANE_LABELS[laneKey]} ({lanes[laneKey].length})
                </text>
                <line x1={labelW} y1={y} x2={width - rightPad} y2={y} stroke="currentColor" strokeOpacity={0.06} />
                {lanes[laneKey].map((ev, i) => {
                  const xPos = x(ev.ts)
                  return (
                    <rect
                      key={i}
                      x={(xPos - 1).toFixed(1)}
                      y={y - tickH / 2}
                      width={2}
                      height={tickH}
                      fill={ev.color}
                      rx={1}
                    >
                      <title>{formatRel(ev.ts - firstTs)} · {ev.title}</title>
                    </rect>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function formatRel(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
