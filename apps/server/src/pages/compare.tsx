import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Badge } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { CrossSessionVisualDiff, CrossSessionVisualDiffPair } from '@unwrap/protocol'
import type { SessionDiff, ActionOp, NetworkDiff } from '../sessiondiff'

interface ComparePageProps {
  email: string
  diff: SessionDiff
  visual: CrossSessionVisualDiff | null
  currentSessionId: string
  baselineSessionId: string
}

export function ComparePage({ email, diff, visual, currentSessionId, baselineSessionId }: ComparePageProps) {
  const a = diff.baseline
  const b = diff.current
  const added = diff.actions.ops.filter((o) => o.kind === 'add').length
  const removed = diff.actions.ops.filter((o) => o.kind === 'remove').length
  const kept = diff.actions.ops.filter((o) => o.kind === 'keep').length
  const consoleDelta = diff.console.currentCount - diff.console.baselineCount
  const exceptionDelta = diff.exceptions.currentCount - diff.exceptions.baselineCount
  const netDelta = diff.network.onlyInCurrent.length - diff.network.onlyInBaseline.length

  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/sessions/${b.id}`} className="text-primary text-sm">← back to session {b.id.slice(0, 8)}</a></p>
      <h2 className="m-0 text-xl font-bold">Session diff · {b.host || '(no host)'}</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">Comparing the action trace, network responses, and error counts of two captured sessions.</p>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Summary</h2>
        <div className="grid grid-cols-2 gap-2">
          <DigestCard label="Baseline (A)" d={a} />
          <DigestCard label="Current (B)" d={b} />
        </div>
        <Card className="mt-3">
          <CardContent className="p-4">
            <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
              <Kpi label="Actions kept" value={kept} color="text-muted-foreground" />
              <Kpi label="Actions added" value={added} color={added > 0 ? 'text-success' : 'text-muted-foreground'} />
              <Kpi label="Actions removed" value={removed} color={removed > 0 ? 'text-danger' : 'text-muted-foreground'} />
              <Kpi label="Console errors" value={`${diff.console.baselineCount} → ${diff.console.currentCount}`} color={consoleDelta > 0 ? 'text-danger' : 'text-muted-foreground'} />
              <Kpi label="Exceptions" value={`${diff.exceptions.baselineCount} → ${diff.exceptions.currentCount}`} color={exceptionDelta > 0 ? 'text-danger' : 'text-muted-foreground'} />
              <Kpi label="Net responses Δ" value={netDelta > 0 ? `+${netDelta}` : `${netDelta}`} color={Math.abs(netDelta) > 0 ? 'text-warning' : 'text-muted-foreground'} />
              <Kpi label="Final URL" value={diff.finalUrl.match ? '✓ match' : '✗ diverged'} color={diff.finalUrl.match ? 'text-success' : 'text-danger'} />
            </div>
            {!diff.finalUrl.match && (
              <div className="text-xs text-muted-foreground mt-3 space-y-1">
                <div>baseline ends at <code>{diff.finalUrl.baseline}</code></div>
                <div>current ends at <code>{diff.finalUrl.current}</code></div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {visual && <VisualDiffSection visual={visual} baselineSessionId={baselineSessionId} currentSessionId={currentSessionId} />}

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Action sequence</h2>
        <Card><CardContent className="p-4">
          {diff.actions.ops.length === 0
            ? <div className="text-xs text-muted-foreground">Neither session has user actions.</div>
            : (
              <div className="flex flex-col gap-0.5 font-mono text-xs">
                {diff.actions.ops.map((op, i) => <ActionRow key={i} op={op} />)}
              </div>
            )}
        </CardContent></Card>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Network responses</h2>
        <NetworkDiffView n={diff.network} />
      </section>

      {diff.console.sampleNew.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-3">New console errors</h2>
          <Card><CardContent className="p-4">
            <ul className="my-0 pl-5 text-xs space-y-1">
              {diff.console.sampleNew.map((m, i) => <li key={i}><code>{truncate(m, 200)}</code></li>)}
            </ul>
          </CardContent></Card>
        </section>
      )}

      {diff.exceptions.sampleNew.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-3">New exceptions</h2>
          <Card><CardContent className="p-4">
            <ul className="my-0 pl-5 text-xs space-y-1">
              {diff.exceptions.sampleNew.map((m, i) => <li key={i}><code>{truncate(m, 200)}</code></li>)}
            </ul>
          </CardContent></Card>
        </section>
      )}
    </Layout>
  )
}

function DigestCard({ label, d }: { label: string; d: SessionDiff['baseline'] }) {
  return (
    <Card><CardContent className="p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1"><a href={`/sessions/${d.id}`} className="text-primary"><code>{d.id.slice(0, 12)}</code></a></div>
      <div className="text-xs text-muted-foreground mt-0.5">uploaded {new Date(d.uploadedAt).toLocaleString()} · duration {formatDuration(d.durationMs)}</div>
    </CardContent></Card>
  )
}

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className={cn('text-base font-semibold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function ActionRow({ op }: { op: ActionOp }) {
  const sign = op.kind === 'add' ? '+' : op.kind === 'remove' ? '−' : ' '
  const a = op.kind === 'remove' ? op.baseline : op.current
  return (
    <div className={cn('flex items-baseline gap-2 px-2 py-1 rounded',
      op.kind === 'add' && 'bg-success/10',
      op.kind === 'remove' && 'bg-danger/10',
    )}>
      <span className={cn('w-3 text-center font-bold',
        op.kind === 'add' && 'text-success',
        op.kind === 'remove' && 'text-danger',
        op.kind === 'keep' && 'text-muted-foreground',
      )}>{sign}</span>
      <code className="text-primary min-w-[50px]">{a.type}</code>
      <code className="text-foreground flex-1 break-all">{truncate(a.selector.primary, 80)}</code>
      {op.kind === 'keep' && op.baseline.selector.primary !== op.current.selector.primary && (
        <span className="text-[10px] text-muted-foreground">· selector text drifted</span>
      )}
    </div>
  )
}

function NetworkDiffView({ n }: { n: NetworkDiff }) {
  const hasAny = n.onlyInCurrent.length > 0 || n.onlyInBaseline.length > 0 || n.statusChanged.length > 0
  if (!hasAny) {
    return <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">No differences in significant responses ({n.common.length} shared).</div></CardContent></Card>
  }
  return (
    <Card><CardContent className="p-4 space-y-3">
      {n.statusChanged.length > 0 && (
        <div>
          <strong className="text-xs">Status changed ({n.statusChanged.length})</strong>
          <ul className="my-1 pl-5 text-xs space-y-0.5">
            {n.statusChanged.map((s, i) => (
              <li key={i}>
                <code>{s.method ?? 'GET'}</code> <code>{truncate(s.url, 80)}</code> ·{' '}
                <span className="text-muted-foreground">{s.baselineStatus}</span> →{' '}
                <span className={s.currentStatus >= 500 ? 'text-danger' : s.currentStatus >= 400 ? 'text-warning' : 'text-success'}>{s.currentStatus}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {n.onlyInCurrent.length > 0 && (
        <div>
          <strong className="text-xs text-success">New in current ({n.onlyInCurrent.length})</strong>
          <ul className="my-1 pl-5 text-xs space-y-0.5">
            {n.onlyInCurrent.map((r, i) => <li key={i}><code>{r.status}</code> <code>{truncate(r.url, 80)}</code></li>)}
          </ul>
        </div>
      )}
      {n.onlyInBaseline.length > 0 && (
        <div>
          <strong className="text-xs text-danger">Missing in current ({n.onlyInBaseline.length})</strong>
          <ul className="my-1 pl-5 text-xs space-y-0.5">
            {n.onlyInBaseline.map((r, i) => <li key={i}><code>{r.status}</code> <code>{truncate(r.url, 80)}</code></li>)}
          </ul>
        </div>
      )}
    </CardContent></Card>
  )
}

function VisualDiffSection({ visual, baselineSessionId, currentSessionId }: { visual: CrossSessionVisualDiff; baselineSessionId: string; currentSessionId: string }) {
  if (visual.pairs.length === 0 && visual.skipped.length === 0) {
    return (
      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Visual diff</h2>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">No captured screenshots on one or both sessions — re-record to enable.</div></CardContent></Card>
      </section>
    )
  }
  const pct = (visual.totals.ratio * 100).toFixed(2)
  const drift = visual.totals.ratio < 0.005 ? 'minimal drift' : visual.totals.ratio < 0.03 ? 'visible differences' : 'major drift'
  const variant = visual.totals.ratio < 0.005 ? 'success' : visual.totals.ratio < 0.03 ? 'warning' : 'danger'
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold m-0 mb-3">Visual diff</h2>
      <Card><CardContent className="p-4">
        <div className="mb-3 text-xs text-muted-foreground flex gap-2 items-center flex-wrap">
          <Badge variant={variant}>{pct}% changed</Badge>
          <span>· {drift}</span>
          <span>· {visual.totals.diffPixels.toLocaleString()} / {visual.totals.totalPixels.toLocaleString()} pixels across {visual.pairs.length} matched pair{visual.pairs.length === 1 ? '' : 's'}</span>
          {visual.skipped.length > 0 && <span>· {visual.skipped.length} skipped</span>}
        </div>
        <div className="flex flex-col gap-3.5">
          {visual.pairs.map((p, i) => <VisualPair key={i} pair={p} index={i} baselineSessionId={baselineSessionId} currentSessionId={currentSessionId} />)}
        </div>
        {visual.skipped.length > 0 && (
          <div className="text-xs text-muted-foreground mt-3">Skipped pairs: {visual.skipped.map((s) => s.reason).join(' · ')}</div>
        )}
      </CardContent></Card>
    </section>
  )
}

function VisualPair({ pair, index, baselineSessionId, currentSessionId }: { pair: CrossSessionVisualDiffPair; index: number; baselineSessionId: string; currentSessionId: string }) {
  const pct = (pair.diffRatio * 100).toFixed(2)
  const variant = pair.diffRatio < 0.005 ? 'success' : pair.diffRatio < 0.03 ? 'warning' : 'danger'
  const baseSrc = `/api/sessions/${baselineSessionId}/screenshots/${pair.baselineRef}`
  const curSrc = `/api/sessions/${currentSessionId}/screenshots/${pair.currentRef}`
  const diffSrc = `/api/sessions/${currentSessionId}/screenshots/${pair.diffRef}`
  return (
    <div className="rounded-md border p-2.5">
      <div className="text-xs text-muted-foreground flex gap-2 items-center flex-wrap mb-2">
        <strong className="text-foreground">Pair {index + 1}</strong>
        <Badge variant={variant}>{pct}%</Badge>
        <span>· {pair.width}×{pair.height}</span>
        <span>· matched within {pair.matchTimeDeltaMs}ms</span>
        {pair.baselineUrl && <span>· <code className="text-[11px]">{truncate(pair.baselineUrl, 60)}</code></span>}
      </div>
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        <Cell label="Baseline (A)" src={baseSrc} />
        <Cell label="Current (B)" src={curSrc} />
        <Cell label="Diff" src={diffSrc} dark />
      </div>
    </div>
  )
}

function Cell({ label, src, dark }: { label: string; src: string; dark?: boolean }) {
  return (
    <div>
      <a href={src} target="_blank" rel="noreferrer" className="block">
        <img src={src} alt={label} loading="lazy" className={cn('w-full h-auto rounded border', dark && 'bg-black')} />
      </a>
      <div className="text-[10px] text-muted-foreground mt-1 text-center">{label}</div>
    </div>
  )
}

function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n - 1) + '…' }
function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
