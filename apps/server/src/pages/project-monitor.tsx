import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Input, Select } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { MonitorConfig, MonitorRunSummary } from '../storage/monitor'

const STATUS_CHIP: Record<MonitorRunSummary['status'], string> = {
  ok: 'bg-success/20 text-success',
  regression: 'bg-danger/20 text-danger',
  error: 'bg-warning/20 text-warning',
}

const INTERVAL_LABEL: Record<MonitorConfig['interval'], string> = {
  '15m': 'Every 15 minutes',
  '1h': 'Hourly',
  '6h': 'Every 6 hours',
  '24h': 'Daily',
}

export function ProjectMonitorPage({
  email,
  host,
  config,
  runs,
  slackConfigured,
  defaultEntryUrl,
}: {
  email: string
  host: string
  config: MonitorConfig | null
  runs: MonitorRunSummary[]
  slackConfigured: boolean
  defaultEntryUrl: string
}) {
  const totalRuns = runs.length
  const passCount = runs.filter((r) => r.status === 'ok').length
  const regressionCount = runs.filter((r) => r.status === 'regression').length
  const errorCount = runs.filter((r) => r.status === 'error').length
  const lastRun = runs[0]
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Synthetic monitoring</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        A scheduled worker visits this project's entry URL on a cadence you pick, captures the API surface +
        console errors, and diffs against the most recent extension capture. Drift triggers a Slack alert
        (if the project's Slack webhook is configured).
      </p>

      <Card className="mb-4">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold m-0 mb-3">Configuration</h3>
          <form method="post" action={`/projects/${encodeURIComponent(host)}/monitor/config`} className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Status</span>
              <Select name="enabled" defaultValue={config?.enabled ? 'on' : 'off'}>
                <option value="on">Enabled</option>
                <option value="off">Disabled</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Interval</span>
              <Select name="interval" defaultValue={config?.interval ?? '1h'}>
                {(Object.keys(INTERVAL_LABEL) as MonitorConfig['interval'][]).map((k) => <option key={k} value={k}>{INTERVAL_LABEL[k]}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 col-span-2">
              <span className="text-xs font-medium">Entry URL <span className="text-muted-foreground font-normal">(defaults to latest capture's start URL)</span></span>
              <Input name="entryUrl" type="url" placeholder={defaultEntryUrl} defaultValue={config?.entryUrl ?? ''} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="alertSlack" defaultChecked={config?.alertSlack ?? false} disabled={!slackConfigured} />
              <span>Slack alert on drift{!slackConfigured && <span className="text-muted-foreground"> · <a href={`/projects/${encodeURIComponent(host)}/integrations`} className="text-primary underline">connect Slack</a></span>}</span>
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit">Save</Button>
              {config?.enabled && (
                <Button type="submit" variant="secondary" formAction={`/projects/${encodeURIComponent(host)}/monitor/run`}>Run now</Button>
              )}
            </div>
          </form>
          {config?.lastCheckAt && (
            <div className="text-xs text-muted-foreground mt-3">Last check: {new Date(config.lastCheckAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          <Kpi label="Runs (90d)" value={totalRuns} color="text-primary" />
          <Kpi label="Clean" value={passCount} color="text-success" />
          <Kpi label="Regressions" value={regressionCount} color={regressionCount > 0 ? 'text-danger' : 'text-muted-foreground'} />
          <Kpi label="Errors" value={errorCount} color={errorCount > 0 ? 'text-warning' : 'text-muted-foreground'} />
          {lastRun && <Kpi label="Last status" value={lastRun.status} color={lastRun.status === 'ok' ? 'text-success' : lastRun.status === 'regression' ? 'text-danger' : 'text-warning'} />}
        </CardContent>
      </Card>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-2">Recent runs</h2>
        {runs.length === 0
          ? (
            <div className="text-center text-muted-foreground py-12">
              <p>No runs yet.</p>
              <p className="text-xs mt-2">Enable monitoring above; the first run will fire on the next cron tick (up to one hour).</p>
            </div>
          )
          : (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Headline</TableHead>
                    <TableHead className="text-right">Final HTTP</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>{runs.map((r) => <RunRow key={r.id} r={r} />)}</TableBody>
              </Table>
            </Card>
          )}
      </section>
    </Layout>
  )
}

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className={cn('text-lg font-semibold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function RunRow({ r }: { r: MonitorRunSummary }) {
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground">{new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 16)}</TableCell>
      <TableCell><span className={cn('inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase', STATUS_CHIP[r.status])}>{r.status}</span></TableCell>
      <TableCell className="text-xs">{r.headline}</TableCell>
      <TableCell className={cn('text-right text-xs', r.finalStatus && r.finalStatus >= 400 ? 'text-danger font-semibold' : 'text-muted-foreground')}>{r.finalStatus ?? '—'}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">{formatMs(r.durationMs)}</TableCell>
    </TableRow>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
