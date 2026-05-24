import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Input } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { SentryCorrelation } from '../sentry'
import type { SentryConfig } from '../storage/sentry-config'

export function ProjectSentryPage({ email, host, config, correlations, error }: {
  email: string
  host: string
  config: SentryConfig | null
  correlations: SentryCorrelation[]
  error?: string
}) {
  const matched = correlations.filter((c) => c.matchedSessions.length > 0)
  const unmatched = correlations.filter((c) => c.matchedSessions.length === 0)

  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Sentry correlation</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Cross-references recent Sentry issues against console errors / exceptions captured during this project's sessions.
        When a Sentry issue matches a captured error, you get the user flow that produced it.
      </p>

      {error && <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger mb-4">{error}</div>}

      {!config
        ? (
          <Card><CardContent className="p-4">
            <strong>Connect Sentry</strong>
            <p className="text-xs text-muted-foreground mt-1.5 mb-3">
              Create an Internal Integration in Sentry (Organization Settings → Custom Integrations) with <code className="rounded bg-muted px-1.5 py-0.5">event:read</code> and <code className="rounded bg-muted px-1.5 py-0.5">project:read</code> scopes. Paste the token below.
            </p>
            <form method="post" action={`/projects/${encodeURIComponent(host)}/sentry/config`} className="grid gap-2 max-w-xl">
              <Input type="text" name="org" required placeholder="org slug (e.g. acme)" />
              <Input type="text" name="project" required placeholder="project slug (e.g. cloud-frontend)" />
              <Input type="password" name="apiToken" required placeholder="API token" />
              <Input type="text" name="baseUrl" placeholder="Base URL — leave empty for sentry.io" />
              <Button type="submit" className="justify-self-start">Connect</Button>
            </form>
          </CardContent></Card>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 flex justify-between items-baseline gap-3 flex-wrap">
                <div>
                  <strong>Connected to</strong>
                  <code className="ml-1.5">{config.org}/{config.project}</code>
                  <span className="text-muted-foreground ml-1">on {config.baseUrl ?? 'sentry.io'}</span>
                </div>
                <form method="post" action={`/projects/${encodeURIComponent(host)}/sentry/disconnect`} onSubmit={"return confirm('Disconnect Sentry?')" as never}>
                  <Button type="submit" variant="destructive" size="sm">Disconnect</Button>
                </form>
              </CardContent>
            </Card>

            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
                <Kpi label="Recent issues" value={correlations.length} color="text-primary" />
                <Kpi label="Matched sessions" value={matched.length} color="text-success" />
                <Kpi label="Unmatched issues" value={unmatched.length} color={unmatched.length === 0 ? 'text-muted-foreground' : 'text-warning'} />
              </CardContent>
            </Card>

            {matched.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-2">Issues with matching captured sessions</h2>
                <p className="text-xs text-muted-foreground mb-3">These Sentry events fired during your captures — click into the session to see the user flow that produced them.</p>
                <div className="space-y-2">{matched.map((c, i) => <IssueRow key={i} c={c} />)}</div>
              </section>
            )}

            {unmatched.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-2">Issues without a matching session</h2>
                <p className="text-xs text-muted-foreground mb-3">Sentry sees these but our captures don't. Either they happened outside the captures we have, or our fingerprint match was too conservative.</p>
                <div className="space-y-2">{unmatched.slice(0, 30).map((c, i) => <IssueRow key={i} c={c} />)}</div>
              </section>
            )}
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

function IssueRow({ c }: { c: SentryCorrelation }) {
  const issue = c.issue
  return (
    <div className={cn('rounded-lg border p-3', c.matchedSessions.length > 0 && 'border-success/35 bg-success/5')}>
      <div className="flex justify-between gap-2 items-baseline flex-wrap">
        <a href={issue.permalink} target="_blank" rel="noreferrer" className="font-semibold text-foreground hover:underline">{issue.title}</a>
        <span className="text-xs text-muted-foreground">
          {issue.shortId}{issue.metadata?.type ? ` · ${issue.metadata.type}` : ''} · {issue.count} event{issue.count === '1' ? '' : 's'}{issue.userCount ? ` · ${issue.userCount} user${issue.userCount === 1 ? '' : 's'}` : ''} · last seen {new Date(issue.lastSeen).toISOString().slice(0, 16).replace('T', ' ')}
        </span>
      </div>
      {issue.metadata?.value && <div className="mt-1.5 text-xs text-muted-foreground break-words"><code className="text-[11px]">{issue.metadata.value}</code></div>}
      {c.matchedSessions.length > 0 && (
        <div className="mt-2 text-xs">
          <strong>Matched sessions ({c.matchedSessions.length}):</strong>
          <ul className="mt-1 pl-0 list-none space-y-0.5">
            {c.matchedSessions.slice(0, 8).map((m, i) => (
              <li key={i} className="text-xs">
                <a href={`/sessions/${m.sessionId}`} className="text-primary">{m.sessionId.slice(0, 8)}</a> — <code className="text-[11px]">{m.matchedMessage.slice(0, 120)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
