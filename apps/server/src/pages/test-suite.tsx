import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Input } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
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
  candidates: { sessionId: string; uploadedAt: number }[]
  share?: { token: string }
}) {
  const isShareView = !!share
  const link = (subPath: string) => isShareView ? `/share/${share!.token}${subPath}` : `/projects/${encodeURIComponent(host)}${subPath}`
  const withSpec = canonical.filter((c) => sessionsById.get(c.sessionId)?.generated?.spec)
  const missing = canonical.length - withSpec.length
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={isShareView ? `/share/${share!.token}` : `/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Canonical test suite</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Sessions you've marked as the project's "golden flows." Bundle exports as a runnable Playwright project
        (npm install → npx playwright test) so CI can pin against the same captured behavior on every PR.
      </p>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          <Kpi label="Canonical specs" value={withSpec.length} color="text-success" />
          <Kpi label="Candidates" value={candidates.length} color="text-primary" />
          {missing > 0 && <Kpi label="Missing spec" value={missing} color="text-danger" />}
        </CardContent>
      </Card>

      {withSpec.length > 0 && !isShareView && (
        <Card className="mb-4 border-primary/40">
          <CardContent className="p-4 flex gap-3 items-center justify-between flex-wrap">
            <div className="min-w-0">
              <strong className="text-sm">↓ Test suite bundle</strong>
              <div className="text-xs text-muted-foreground mt-0.5">
                Single zip with playwright.config.ts + package.json + one .spec.ts per canonical test + README. Drop into CI as a self-contained Playwright project.
              </div>
            </div>
            <Button asChild><a href={link('/tests.zip')} download>↓ Download tests.zip</a></Button>
          </CardContent>
        </Card>
      )}

      {isShareView && withSpec.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <Button asChild><a href={link('/tests.zip')} download>↓ Download tests.zip</a></Button>
          </CardContent>
        </Card>
      )}

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-2">Canonical tests ({canonical.length})</h2>
        {canonical.length === 0
          ? (
            <div className="text-center text-muted-foreground py-12">
              <p>No canonical tests yet.</p>
              <p className="text-xs mt-3">Open any session with a generated spec and click "Mark as canonical test." Candidates are listed below.</p>
            </div>
          )
          : (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Source session</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                    {!isShareView && <TableHead></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>{canonical.map((c) => <CanonicalRow key={c.sessionId} c={c} sessionsById={sessionsById} host={host} isShareView={isShareView} />)}</TableBody>
              </Table>
            </Card>
          )}
      </section>

      {!isShareView && candidates.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-2">Candidates — sessions with a spec, not yet canonical ({candidates.length})</h2>
          <p className="text-xs text-muted-foreground mb-2">Each has a Gemini-generated Playwright spec ready to promote.</p>
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Start URL</TableHead>
                  <TableHead className="text-right">Uploaded</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{candidates.map((c) => <CandidateRow key={c.sessionId} c={c} sessionsById={sessionsById} host={host} />)}</TableBody>
            </Table>
          </Card>
        </section>
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

function CanonicalRow({ c, sessionsById, host, isShareView }: { c: CanonicalTestRecord; sessionsById: Map<string, StoredSession>; host: string; isShareView: boolean }) {
  const session = sessionsById.get(c.sessionId)
  const hasSpec = !!session?.generated?.spec
  return (
    <TableRow>
      <TableCell>{hasSpec ? c.name : <span className="text-danger" title="Source session lacks a generated spec — regenerate from its detail page">{c.name} ⚠</span>}</TableCell>
      <TableCell>
        {c.tags.length > 0
          ? c.tags.map((t, i) => <span key={i} className="inline-block px-2 py-0.5 bg-muted rounded-full text-xs mr-1">{t}</span>)
          : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell><a href={`/sessions/${c.sessionId}`} className="font-mono text-xs text-primary">{c.sessionId.slice(0, 8)}</a></TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">{new Date(c.addedAt).toISOString().slice(0, 10)}</TableCell>
      {!isShareView && (
        <TableCell>
          <form method="post" action={`/projects/${encodeURIComponent(host)}/tests/${encodeURIComponent(c.sessionId)}/remove`} className="m-0" data-confirm={`Remove ${c.name} from the canonical suite?`}>
            <Button variant="destructive" size="sm" type="submit">Remove</Button>
          </form>
        </TableCell>
      )}
    </TableRow>
  )
}

function CandidateRow({ c, sessionsById, host }: { c: { sessionId: string; uploadedAt: number }; sessionsById: Map<string, StoredSession>; host: string }) {
  const session = sessionsById.get(c.sessionId)
  const startUrl = session?.summary.meta.url ?? ''
  return (
    <TableRow>
      <TableCell><a href={`/sessions/${c.sessionId}`} className="font-mono text-xs text-primary">{c.sessionId.slice(0, 8)}</a></TableCell>
      <TableCell><code className="text-xs">{truncate(startUrl, 64)}</code></TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">{relativeTime(c.uploadedAt)}</TableCell>
      <TableCell>
        <form method="post" action={`/projects/${encodeURIComponent(host)}/tests`} className="flex gap-1.5 items-center m-0">
          <input type="hidden" name="sessionId" value={c.sessionId} />
          <Input type="text" name="name" required maxLength={80} placeholder="test name" className="h-7 text-xs flex-1" />
          <Button variant="secondary" size="sm" type="submit">Promote</Button>
        </form>
      </TableCell>
    </TableRow>
  )
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
