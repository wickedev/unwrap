import { Layout } from './_layout'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table'
import type { ApiTokenRecord } from '../storage/api-tokens'

export function ApiTokensPage({
  email,
  tokens,
  freshlyMinted,
  origin,
}: {
  email: string
  tokens: ApiTokenRecord[]
  freshlyMinted?: ApiTokenRecord
  origin: string
}) {
  return (
    <Layout email={email}>
      <p className="m-0 mb-2"><a href="/" className="text-primary text-sm">← back to sessions</a></p>
      <h2 className="m-0 text-xl font-bold">API tokens</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">Long-lived bearer tokens for uploading captures from CI or scripts. Use them with the <code className="rounded bg-muted px-1.5 py-0.5">unwrap-cli</code> package or any HTTP client.</p>

      {freshlyMinted && (
        <Card className="mb-4 border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/5">
          <CardContent className="p-4">
            <strong>New token created — copy it now.</strong>
            <div className="text-xs text-muted-foreground mt-1">This is the only time the full token is shown in the UI. Treat it like a password.</div>
            <pre className="mt-2"><code>{freshlyMinted.token}</code></pre>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardContent className="p-4">
          <form method="post" action="/api/tokens" className="flex gap-2 flex-wrap items-center">
            <Input type="text" name="label" required maxLength={80} placeholder="Label (e.g. github-actions, local-dev)" className="flex-1 min-w-[240px]" />
            <Button type="submit">Mint token</Button>
          </form>
        </CardContent>
      </Card>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Existing tokens ({tokens.length})</h2>
        {tokens.length === 0
          ? <div className="text-xs text-muted-foreground">No tokens yet.</div>
          : (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map((t) => (
                    <TableRow key={t.token}>
                      <TableCell>{t.label}</TableCell>
                      <TableCell><code>{t.token.slice(0, 10)}…{t.token.slice(-4)}</code></TableCell>
                      <TableCell className="text-muted-foreground">{new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</TableCell>
                      <TableCell>
                        <form method="post" action={`/api/tokens/${encodeURIComponent(t.token)}/revoke`} onSubmit={"return confirm('Revoke this token? Any caller using it will get 401.')" as never}>
                          <Button type="submit" variant="destructive" size="sm">Revoke</Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">Usage</h2>
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="m-0">Capture a list of URLs with the CLI (drives headless Chromium via Playwright):</p>
            <pre><code>{`npx @unwrap/cli capture \\
  --server=${origin} \\
  --token=<your token> \\
  --host=staging.example.com \\
  https://staging.example.com/login \\
  https://staging.example.com/dashboard`}</code></pre>
            <p className="m-0">Or upload a session blob from any HTTP client:</p>
            <pre><code>{`curl -X POST ${origin}/api/sessions \\
  -H "Authorization: Bearer <your token>" \\
  -H "Content-Type: application/json" \\
  -d @session.json`}</code></pre>
            <p className="text-xs text-muted-foreground m-0">Uploads landing on a host with prior captures auto-diff against the most recent — surface the diff on the project page or fetch via <code className="rounded bg-muted px-1.5 py-0.5">GET /projects/&lt;host&gt;/diff/&lt;other&gt;</code>.</p>
          </CardContent>
        </Card>
      </section>
    </Layout>
  )
}
