import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Badge } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { MethodPill } from './project'
import { cn } from '@unwrap/ui'
import type { SecurityReport, SecurityFinding, AuthMatrixRow } from '../project-security'

const SEV_VARIANT: Record<SecurityFinding['severity'], 'danger' | 'warning' | 'muted'> = {
  high: 'danger', warn: 'warning', info: 'muted',
}
const SEV_GLYPH: Record<SecurityFinding['severity'], string> = { high: '⚠', warn: '!', info: 'i' }

export function ProjectSecurityPage({ email, report, linearConnected = false }: {
  email: string
  report: SecurityReport
  linearConnected?: boolean
}) {
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(report.host)}`} className="text-primary text-sm">← back to {report.host}</a></p>
      <h2 className="m-0 text-xl font-bold">Security overview</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Heuristic findings derived from captured network, navigation, and storage data. This is signal for further investigation — not a conformance check.
        The extension redacts sensitive header VALUES but preserves NAMES, so auth-scheme detection is possible without ever shipping the secrets.
      </p>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          <Kpi label="Sessions" value={report.sessionCount} color="text-foreground" />
          <Kpi label="Endpoints" value={report.totals.endpoints} color="text-primary" />
          <Kpi label="Auth-protected" value={report.totals.authedEndpoints} color="text-success" />
          <Kpi label="Cookies seen" value={report.totals.cookies} color="text-purple-500" />
          <Kpi label="Cross-origin" value={report.totals.crossOriginRequests} color="text-warning" />
          <Kpi label="Findings" value={report.findings.length} color={kpiColor(report.findings)} />
        </CardContent>
      </Card>

      {report.findings.length === 0
        ? <div className="text-center text-muted-foreground py-12">No findings — nothing matched the heuristics. Could also mean the captures didn't include enough data.</div>
        : (
          <section className="mb-6">
            <h2 className="text-sm font-semibold m-0 mb-3">Findings ({report.findings.length})</h2>
            <div className="space-y-2">
              {report.findings.map((f, i) => <Finding key={i} f={f} host={report.host} linearConnected={linearConnected} />)}
            </div>
          </section>
        )}

      {report.authMatrix.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-3">Auth matrix (per endpoint)</h2>
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Auth scheme</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">401</TableHead>
                  <TableHead className="text-right">403</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.authMatrix.map((r, i) => <MatrixRow key={i} r={r} />)}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      {linearConnected && <script dangerouslySetInnerHTML={{ __html: LINEAR_BTN_JS }} />}
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

function Finding({ f, host, linearConnected }: { f: SecurityFinding; host: string; linearConnected: boolean }) {
  const body = JSON.stringify({
    title: `[security] ${f.title}`,
    description: `**Severity:** ${f.severity}\n\n${f.description}\n\n**Evidence:**\n${f.evidence.map((e) => '- `' + e + '`').join('\n')}`,
    sourcePath: `/projects/${encodeURIComponent(host)}/security`,
  }).replace(/'/g, "\\'")
  return (
    <div className={cn(
      'rounded-lg border p-3.5',
      f.severity === 'high' && 'border-danger/35 bg-danger/5',
      f.severity === 'warn' && 'border-warning/35 bg-warning/5',
    )}>
      <div className="flex gap-2 items-center mb-1.5 flex-wrap">
        <Badge variant={SEV_VARIANT[f.severity]}>{SEV_GLYPH[f.severity]} {f.severity}</Badge>
        <strong>{f.title}</strong>
        {linearConnected && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="ml-auto text-[10px] linear-btn"
            data-body={body}
            data-host={encodeURIComponent(host)}
          >📥 Linear issue</Button>
        )}
      </div>
      <p className="m-0 text-xs text-muted-foreground mb-2">{f.description}</p>
      {f.evidence.length > 0 && (
        <ul className="list-none p-0 m-0 space-y-0.5">
          {f.evidence.map((e, i) => <li key={i} className="text-xs"><code>{e}</code></li>)}
        </ul>
      )}
    </div>
  )
}

function MatrixRow({ r }: { r: AuthMatrixRow }) {
  const schemeColor = r.scheme === '(none)' ? 'text-muted-foreground' : r.scheme === 'Mixed' ? 'text-warning' : 'text-success'
  return (
    <TableRow>
      <TableCell><MethodPill method={r.method} /></TableCell>
      <TableCell><code>{r.normalizedPath}</code></TableCell>
      <TableCell className={cn('font-semibold', schemeColor)}>{r.scheme}</TableCell>
      <TableCell className="text-right">{r.callCount}</TableCell>
      <TableCell className={cn('text-right', r.unauthorizedHits > 0 ? 'text-danger' : 'text-muted-foreground')}>{r.unauthorizedHits || ''}</TableCell>
      <TableCell className={cn('text-right', r.forbiddenHits > 0 ? 'text-danger' : 'text-muted-foreground')}>{r.forbiddenHits || ''}</TableCell>
    </TableRow>
  )
}

function kpiColor(findings: SecurityFinding[]): string {
  if (findings.some((f) => f.severity === 'high')) return 'text-danger'
  if (findings.some((f) => f.severity === 'warn')) return 'text-warning'
  return 'text-muted-foreground'
}

const LINEAR_BTN_JS = `
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.linear-btn');
  if (!btn) return;
  const bodyJson = btn.dataset.body;
  const hostEnc = btn.dataset.host;
  if (!bodyJson || !hostEnc) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const body = JSON.parse(bodyJson);
    const resp = await fetch('/projects/' + hostEnc + '/integrations/linear/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 120));
    const issue = await resp.json();
    btn.textContent = '✓ ' + issue.identifier;
    const link = document.createElement('a');
    link.href = issue.url; link.target = '_blank'; link.rel = 'noopener';
    link.style.marginLeft = '6px'; link.style.fontSize = '11px';
    link.textContent = 'open ↗';
    btn.parentNode.insertBefore(link, btn.nextSibling);
  } catch (e) {
    btn.textContent = 'Failed — see console';
    console.error('createLinearIssue failed', e);
    btn.disabled = false;
    setTimeout(() => { btn.textContent = original }, 2400);
  }
});
`
