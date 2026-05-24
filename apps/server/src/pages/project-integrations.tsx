import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Input } from '@unwrap/ui'
import { Badge } from '@unwrap/ui'
import type { LinearConfig } from '../storage/linear-config'
import type { SlackConfig } from '../storage/slack-config'
import type { SentryConfig } from '../storage/sentry-config'
import type { ProjectRepoBinding } from '../storage/project-repo'

export function ProjectIntegrationsPage({ email, host, linear, slack, sentry, repo, message, error }: {
  email: string
  host: string
  linear: LinearConfig | null
  slack: SlackConfig | null
  sentry: SentryConfig | null
  repo: ProjectRepoBinding | null
  message?: string
  error?: string
}) {
  return (
    <Layout email={email}>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Per-project integrations</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">External services this project can post to: file Linear issues from findings, ping Slack on regression, see Sentry errors correlated to captured user flows.</p>

      {message && <Card className="mb-3 border-success/40 bg-success/5"><CardContent className="p-3">{message}</CardContent></Card>}
      {error && <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger mb-3">{error}</div>}

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">🟪 Linear</h2>
        <Card><CardContent className="p-4">
          {linear
            ? (
              <>
                <div className="flex justify-between items-baseline gap-2 flex-wrap">
                  <div><strong>Connected</strong> · <span className="text-muted-foreground">team {linear.teamKey ?? linear.teamId.slice(0, 8)}</span></div>
                  <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/linear/disconnect`} onSubmit={"return confirm('Disconnect Linear?')" as never}>
                    <Button type="submit" variant="destructive" size="sm">Disconnect</Button>
                  </form>
                </div>
                <p className="text-xs text-muted-foreground mt-2">Every security / a11y / performance finding now gets a "📥 Create Linear issue" button — title + evidence prefilled with a link back to the finding.</p>
              </>
            )
            : (
              <>
                <p className="m-0 font-semibold">Create Linear issues from findings.</p>
                <p className="text-xs text-muted-foreground mt-1.5 mb-3">Create a personal API key in Linear (Settings → API → New personal API key) with default scopes. Then pick the team issues should land under.</p>
                <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/linear`} className="grid gap-2 max-w-xl">
                  <Input type="password" name="apiKey" required placeholder="lin_api_..." />
                  <Input type="text" name="teamId" required placeholder="Team UUID (from Linear team settings URL)" />
                  <Input type="text" name="teamKey" placeholder="Team key (display only, e.g. ENG)" />
                  <Button type="submit" className="justify-self-start">Connect Linear</Button>
                </form>
              </>
            )}
        </CardContent></Card>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">💬 Slack</h2>
        <Card><CardContent className="p-4">
          {slack
            ? (
              <div className="flex justify-between items-baseline gap-2 flex-wrap">
                <div>
                  <strong>Connected</strong> · webhook configured
                  {slack.notifyOnRegression && <Badge variant="success" className="ml-2">regression</Badge>}
                  {slack.notifyOnFirstCapture && <Badge variant="success" className="ml-2">first capture</Badge>}
                </div>
                <div className="flex gap-1.5">
                  <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/slack/test`}>
                    <Button type="submit" variant="secondary" size="sm">Send test message</Button>
                  </form>
                  <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/slack/disconnect`} onSubmit={"return confirm('Disconnect Slack?')" as never}>
                    <Button type="submit" variant="destructive" size="sm">Disconnect</Button>
                  </form>
                </div>
              </div>
            )
            : (
              <>
                <p className="m-0 font-semibold">Ping Slack when something changes.</p>
                <p className="text-xs text-muted-foreground mt-1.5 mb-3">Create an Incoming Webhook in your Slack workspace and paste the URL below. Notifications fire on new uploads where regression detection finds drift.</p>
                <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/slack`} className="grid gap-2 max-w-xl">
                  <Input type="url" name="webhookUrl" required placeholder="https://hooks.slack.com/services/..." />
                  <label className="text-xs flex gap-1.5 items-center"><input type="checkbox" name="notifyOnRegression" defaultChecked /> Notify on regression detected</label>
                  <label className="text-xs flex gap-1.5 items-center"><input type="checkbox" name="notifyOnFirstCapture" /> Notify on each new capture (first or otherwise)</label>
                  <Button type="submit" className="justify-self-start">Connect Slack</Button>
                </form>
              </>
            )}
        </CardContent></Card>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">🐙 GitHub PR bot</h2>
        <Card><CardContent className="p-4">
          {repo
            ? (
              <>
                <div className="flex justify-between items-baseline gap-2 flex-wrap">
                  <div><strong>Bound</strong> · <code>{repo.repo}</code></div>
                  <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/repo/unbind`} data-confirm="Unbind this repository?">
                    <Button type="submit" variant="destructive" size="sm">Unbind</Button>
                  </form>
                </div>
                <p className="text-xs text-muted-foreground mt-2">When a PR opens or pushes in this repo, the Unwrap App scans the PR body + bot comments for a deploy-preview URL (Vercel / Netlify / Render / CF Pages), runs a synthetic check against it, and posts a drift summary as an idempotent PR comment.</p>
                <p className="text-xs text-muted-foreground mt-1">Comment <code className="rounded bg-muted px-1 py-0.5">/unwrap recheck</code> on the PR to force a re-run (useful when the preview URL only shows up after the first push).</p>
              </>
            )
            : (
              <>
                <p className="m-0 font-semibold">Auto-comment PR drift summaries.</p>
                <p className="text-xs text-muted-foreground mt-1.5 mb-3">Install the Unwrap GitHub App on the org if you haven't (Integrations settings), then bind this project to one repo. Multiple projects can target the same repo (e.g. staging + prod hosts on one frontend).</p>
                <form method="post" action={`/projects/${encodeURIComponent(host)}/integrations/repo`} className="grid gap-2 max-w-xl grid-cols-[1fr_auto]">
                  <Input type="text" name="repo" required placeholder="owner/repo (e.g. wickedev/unwrap)" pattern="^[^/\s]+/[^/\s]+$" />
                  <Button type="submit">Bind</Button>
                </form>
              </>
            )}
        </CardContent></Card>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold m-0 mb-3">🐞 Sentry</h2>
        <Card><CardContent className="p-4 flex justify-between items-baseline gap-2 flex-wrap">
          <div>
            {sentry
              ? <><strong>Connected</strong> · <code>{sentry.org}/{sentry.project}</code></>
              : <><strong>Not connected</strong> · <span className="text-muted-foreground">Correlate Sentry issues with captured sessions</span></>}
          </div>
          <Button asChild variant="secondary"><a href={`/projects/${encodeURIComponent(host)}/sentry`}>→ Open Sentry view</a></Button>
        </CardContent></Card>
      </section>
    </Layout>
  )
}
