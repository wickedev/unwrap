import type { StoredSession } from '@unwrap/protocol'
import { cn } from '@unwrap/ui'

interface Row {
  kind: 'navigation' | 'action' | 'response' | 'console' | 'exception' | 'screenshot'
  ts: number
  title: string
  body?: string
  url?: string
  status?: 'ok' | 'warn' | 'error'
  raw?: unknown
}

const KIND_META: Record<Row['kind'], { label: string; symbol: string; classes: string }> = {
  navigation: { label: 'nav', symbol: '↗', classes: 'text-primary bg-primary/10' },
  action: { label: 'act', symbol: '◉', classes: 'text-success bg-success/10' },
  response: { label: 'net', symbol: '⇄', classes: 'text-muted-foreground bg-muted' },
  console: { label: 'log', symbol: '✎', classes: 'text-warning bg-warning/10' },
  exception: { label: 'err', symbol: '!', classes: 'text-danger bg-danger/10' },
  screenshot: { label: 'shot', symbol: '◳', classes: 'text-purple-500 bg-purple-500/10' },
}

export function Timeline({ session }: { session: StoredSession }) {
  const sessionStart = new Date(session.summary.meta.startedAt).getTime()
  const rows: Row[] = []
  for (const n of session.summary.navigations) rows.push({ kind: 'navigation', ts: n.ts, title: 'Navigated', body: n.url, url: n.url })
  for (const a of session.summary.actions) {
    const d = a.details ?? {}
    let body = a.selector?.primary ?? ''
    if (a.type === 'input' && typeof d['value'] === 'string') body += `\n→ value: ${truncate(String(d['value']), 80)}`
    else if (a.type === 'input' && d['redacted']) body += '\n→ [REDACTED]'
    else if (a.type === 'change' && 'checked' in d) body += `\n→ checked: ${d['checked']}`
    else if (a.type === 'key' && typeof d['key'] === 'string') body += `\n→ key: ${d['key']}`
    rows.push({ kind: 'action', ts: a.ts, title: a.type, body, url: a.url })
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
  for (const c of session.summary.consoleErrors) rows.push({ kind: 'console', ts: c.ts, title: 'console.error', body: c.message, status: 'error' })
  for (const e of session.summary.exceptions) rows.push({ kind: 'exception', ts: e.ts, title: 'exception', body: e.stack ? `${e.message}\n${e.stack}` : e.message, status: 'error' })
  for (const s of session.verifyScreenshotMeta ?? []) rows.push({ kind: 'screenshot', ts: s.originalTs, title: 'Screenshot captured', body: `${s.width}×${s.height} · ${s.url}`, url: s.url, raw: s.storedRef })

  rows.sort((a, b) => a.ts - b.ts)
  if (rows.length === 0) return <div className="text-xs text-muted-foreground p-3 border rounded-md">No timeline events captured.</div>

  const totalDuration = (rows[rows.length - 1]!.ts - sessionStart) || 1
  const screenshotBase = `/api/sessions/${session.id}/screenshots`

  return (
    <div className="rounded-lg border bg-card p-3">
      <ol className="list-none p-0 m-0 flex flex-col gap-1.5">
        {rows.map((row, i) => {
          const m = KIND_META[row.kind]
          const rel = row.ts - sessionStart
          const isShot = row.kind === 'screenshot' && typeof row.raw === 'string'
          const statusColor =
            row.status === 'error' ? 'text-danger'
            : row.status === 'warn' ? 'text-warning'
            : row.status === 'ok' ? 'text-success'
            : 'text-foreground'
          return (
            <li key={i} className="grid grid-cols-[120px_1fr] gap-3 px-2.5 py-2 rounded-md border border-transparent hover:bg-muted/40 hover:border-border">
              <div className={cn('flex flex-col items-start gap-1 text-[11px] rounded px-1.5 py-1', m.classes)}>
                <span className="text-[13px] font-bold">{m.symbol} {m.label}</span>
                <span className="font-mono opacity-70">{formatRelative(rel)}</span>
              </div>
              <div className="min-w-0">
                <div className={cn('font-semibold text-xs break-words', statusColor)}>{row.title}</div>
                {row.body && <div className="mt-0.5 text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-words">{row.body}</div>}
                {isShot && (
                  <a href={`${screenshotBase}/${row.raw}`} target="_blank" rel="noreferrer" className="inline-block mt-1">
                    <img src={`${screenshotBase}/${row.raw}`} alt="screenshot" loading="lazy" className="max-w-[240px] max-h-[160px] rounded border border-border bg-white" />
                  </a>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <div className="text-[11px] text-muted-foreground mt-3">
        {rows.length} event{rows.length === 1 ? '' : 's'} · spans {formatRelative(totalDuration)}
      </div>
    </div>
  )
}

function formatRelative(ms: number): string {
  if (ms < 0) return '-' + formatRelative(-ms)
  if (ms < 1000) return `+${ms}ms`
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `+${m}m${s.toString().padStart(2, '0')}s`
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
