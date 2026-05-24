import { Layout } from './_layout'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table'
import type { InstallationRecord } from '../github-app'

export function IntegrationsPage({
  email,
  installations,
  appSlug,
  origin,
}: {
  email: string
  installations: InstallationRecord[]
  appSlug?: string
  origin: string
}) {
  return (
    <Layout email={email}>
      <p className="m-0 mb-2"><a href="/" className="text-primary text-sm">← back to sessions</a></p>
      <h2 className="m-0 text-xl font-bold">Integrations</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">External services Unwrap can talk to on your behalf. Each integration is opt-in and uses scoped credentials.</p>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">GitHub App</h2>
        <Card>
          <CardContent className="p-4">
            <p className="m-0 mb-3 text-sm">
              <strong>What it does:</strong> after a CI capture, post (or edit) a PR comment from the bot identity
              <code className="rounded bg-muted px-1.5 py-0.5 mx-1">@{appSlug ?? 'unwrap'}[bot]</code>.
              Replaces the per-developer PAT path — install once at the org level, every CI job can comment without secrets.
            </p>
            {appSlug
              ? <Button asChild><a href={`https://github.com/apps/${appSlug}/installations/new`} target="_blank" rel="noopener noreferrer">Install Unwrap GitHub App →</a></Button>
              : (
                <div className="text-xs text-muted-foreground">
                  The Unwrap GitHub App isn't configured for this server yet. Ask the operator to set
                  <code className="rounded bg-muted px-1.5 py-0.5 mx-1">GITHUB_APP_ID</code>,
                  <code className="rounded bg-muted px-1.5 py-0.5 mx-1">GITHUB_APP_PRIVATE_KEY</code>,
                  <code className="rounded bg-muted px-1.5 py-0.5 mx-1">GITHUB_APP_WEBHOOK_SECRET</code>,
                  and <code className="rounded bg-muted px-1.5 py-0.5 mx-1">GITHUB_APP_SLUG</code> env vars,
                  and point the webhook at <code className="rounded bg-muted px-1.5 py-0.5 mx-1">{origin}/webhooks/github</code>.
                </div>
              )}

            <h3 className="mt-4 mb-2 text-sm font-semibold">Installations seen by this server ({installations.length})</h3>
            {installations.length === 0
              ? <div className="text-xs text-muted-foreground">No installations yet.</div>
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Repositories</TableHead>
                      <TableHead>Installed</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {installations.map((i) => (
                      <TableRow key={i.installationId}>
                        <TableCell>
                          <strong>{i.accountLogin}</strong>
                          {i.suspended && <span className="text-muted-foreground ml-1">(suspended)</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{i.accountType}</TableCell>
                        <TableCell>
                          {i.repositories.length === 0
                            ? <span className="text-muted-foreground">all (or none yet synced)</span>
                            : (
                              <details>
                                <summary className="text-muted-foreground cursor-pointer">{i.repositories.length} repo{i.repositories.length === 1 ? '' : 's'}</summary>
                                <ul className="mt-1 pl-5 text-xs space-y-0.5">
                                  {i.repositories.slice(0, 25).map((r) => <li key={r}><code>{r}</code></li>)}
                                  {i.repositories.length > 25 && <li className="text-muted-foreground">…+{i.repositories.length - 25} more</li>}
                                </ul>
                              </details>
                            )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{new Date(i.installedAt).toISOString().slice(0, 10)}</TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">id {i.installationId}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </CardContent>
        </Card>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">API tokens</h2>
        <Card>
          <CardContent className="p-4">
            <p className="m-0 mb-3 text-xs text-muted-foreground">Long-lived bearer tokens for CLI / scripted uploads.</p>
            <Button asChild variant="secondary"><a href="/settings/tokens">Manage tokens →</a></Button>
          </CardContent>
        </Card>
      </section>
    </Layout>
  )
}
