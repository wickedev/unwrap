import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { ProjectWsChannel } from '../project-websockets'
import type { WsMessageType } from '@unwrap/protocol'

export function ProjectWebSocketsPage({ email, host, channels }: { email: string; host: string; channels: ProjectWsChannel[] }) {
  const totalMessages = channels.reduce((n, c) => n + c.totalSendCount + c.totalRecvCount, 0)
  const totalBytes = channels.reduce((n, c) => n + c.totalSendBytes + c.totalRecvBytes, 0)
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">WebSocket channels</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Realtime traffic captured during the recorded sessions, grouped by endpoint and message-type discriminator
        (Socket.IO <code className="rounded bg-muted px-1.5 py-0.5">event</code>, GraphQL-WS <code className="rounded bg-muted px-1.5 py-0.5">type</code>, JSON-RPC <code className="rounded bg-muted px-1.5 py-0.5">method</code>).
      </p>

      {channels.length === 0
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No WebSocket traffic captured for this project.</p>
            <p className="text-xs mt-2">Either this service doesn't use WebSockets, or the captures were made before the WS collector shipped.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
                <Kpi label="Channels" value={channels.length} color="text-purple-500" />
                <Kpi label="Messages" value={totalMessages} color="text-primary" />
                <Kpi label="Bytes" value={formatBytes(totalBytes)} color="text-foreground" />
                <Kpi label="Distinct types" value={channels.reduce((n, c) => n + c.messageTypes.length, 0)} color="text-success" />
              </CardContent>
            </Card>
            {channels.map((ch, i) => <Channel key={i} ch={ch} />)}
          </>
        )}
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

function Channel({ ch }: { ch: ProjectWsChannel }) {
  return (
    <Card className="mb-3.5">
      <CardContent className="p-3">
        <div className="pb-2 mb-2 border-b">
          <code className="text-xs break-all">{ch.url}</code>
          <div className="text-xs text-muted-foreground mt-0.5">
            <span className="text-success">↑ {ch.totalSendCount} sent</span> · <span className="text-primary">↓ {ch.totalRecvCount} received</span> · {formatBytes(ch.totalSendBytes + ch.totalRecvBytes)} total · {ch.sessionCount} session{ch.sessionCount === 1 ? '' : 's'}
          </div>
        </div>
        {ch.messageTypes.length === 0
          ? <div className="text-xs text-muted-foreground py-2">No text frames captured (binary-only channel?).</div>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Message key</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                  <TableHead>Inferred shape · sample</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ch.messageTypes.map((t, i) => <MessageRow key={i} t={t} />)}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  )
}

function MessageRow({ t }: { t: WsMessageType }) {
  return (
    <TableRow>
      <TableCell><code>{t.key}</code></TableCell>
      <TableCell>
        <span className={cn('inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase',
          t.direction === 'send' && 'bg-success/20 text-success',
          t.direction === 'recv' && 'bg-primary/20 text-primary',
          t.direction === 'both' && 'bg-purple-500/20 text-purple-500',
        )}>{t.direction}</span>
      </TableCell>
      <TableCell className="text-right">{t.count}</TableCell>
      <TableCell className="text-right">{formatBytes(t.bytes)}</TableCell>
      <TableCell>
        {t.inferredShape
          ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">show shape + sample</summary>
              <pre className="mt-1.5 text-xs"><code>{t.inferredShape}</code></pre>
              {t.sample && <pre className="mt-1 text-xs bg-muted/30"><code>{truncate(prettyJson(t.sample), 1500)}</code></pre>}
            </details>
          )
          : <span className="text-xs text-muted-foreground">no JSON payload</span>}
      </TableCell>
    </TableRow>
  )
}

function prettyJson(s: string) { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }
function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)` }
function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
