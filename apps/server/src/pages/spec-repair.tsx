import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Textarea } from '@unwrap/ui'
import type { SpecRepairResult } from '../spec-repair'

export function SpecRepairPage({ email, sessionId, originalSpec, result, error }: {
  email: string
  sessionId: string
  originalSpec: string
  result?: SpecRepairResult
  error?: string
}) {
  return (
    <Layout email={email}>
      <p className="m-0 mb-2"><a href={`/sessions/${sessionId}`} className="text-primary text-sm">← back to session {sessionId.slice(0, 8)}</a></p>
      <h2 className="m-0 text-xl font-bold">Spec auto-repair</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Gemini reads the current spec, the latest captured HTML for the page the spec targets, and the failure error message —
        then proposes a patched spec with updated selectors. Other things (test name, structure, intent) stay the same.
      </p>

      {error && <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger mb-4">{error}</div>}

      {!result
        ? (
          <form method="post" action={`/sessions/${sessionId}/repair`}>
            <Card>
              <CardContent className="p-4">
                <h3 className="m-0 mb-2 text-sm font-semibold">Paste the failure error message (optional)</h3>
                <p className="text-xs text-muted-foreground mb-2">
                  If you have one from a failed CI run, paste it here so Gemini can target the right selector. The whole repair still works without it.
                </p>
                <Textarea name="errorMessage" rows={6} placeholder={"expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible() failed\nLocator: getByRole('button', { name: 'Sign in' })\n..."} className="font-mono text-xs" />
                <div className="mt-3">
                  <Button type="submit">🩹 Generate repair</Button>
                </div>
              </CardContent>
            </Card>
            <details className="mt-4">
              <summary className="text-xs text-muted-foreground cursor-pointer">Show current spec</summary>
              <pre className="mt-2 text-xs"><code>{originalSpec}</code></pre>
            </details>
          </form>
        )
        : <ResultView originalSpec={originalSpec} r={result} />}
    </Layout>
  )
}

function ResultView({ originalSpec, r }: { originalSpec: string; r: SpecRepairResult }) {
  const changed = r.repairedSpec && r.repairedSpec !== originalSpec
  return (
    <>
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex justify-between items-baseline flex-wrap gap-2">
            <div>
              {changed
                ? <strong className="text-success">✓ Repair suggested</strong>
                : <strong className="text-muted-foreground">No change suggested</strong>}
              <div className="text-xs text-muted-foreground mt-0.5">
                {r.contextUsedUrl
                  ? <>Grounded on captured HTML of <code>{r.contextUsedUrl}</code> · {r.contextScannedSessionCount} session{r.contextScannedSessionCount === 1 ? '' : 's'} searched</>
                  : <>No matching captured HTML found · best-effort from error message + spec</>}
                {' '}· {r.model} · {r.usage.totalTokens} tokens
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-2"><strong>Rationale:</strong> {r.rationale || '(no rationale provided)'}</div>
        </CardContent>
      </Card>

      {changed
        ? (
          <>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold m-0 mb-1.5">Before</h3>
                <pre className="text-xs max-h-[600px] overflow-auto"><code>{originalSpec}</code></pre>
              </div>
              <div>
                <h3 className="text-sm font-semibold m-0 mb-1.5 text-success">After (proposed)</h3>
                <pre className="text-xs max-h-[600px] overflow-auto"><code>{r.repairedSpec}</code></pre>
              </div>
            </div>
            <div className="mt-3 flex gap-2 flex-wrap items-center">
              <Button type="button" id="copy-repair-btn">Copy repaired spec</Button>
              <span className="text-xs text-muted-foreground">Paste into your test file and rerun. We don't auto-overwrite the source session's spec — review and commit yourself.</span>
            </div>
            <script dangerouslySetInnerHTML={{ __html: `
              document.getElementById('copy-repair-btn').addEventListener('click', () => {
                const text = ${JSON.stringify(r.repairedSpec)};
                const btn = document.getElementById('copy-repair-btn');
                navigator.clipboard.writeText(text).then(() => {
                  btn.textContent = 'Copied!';
                  setTimeout(() => { btn.textContent = 'Copy repaired spec' }, 1500);
                });
              });
            `}} />
          </>
        )
        : (
          <details>
            <summary className="text-xs text-muted-foreground cursor-pointer">Show current spec</summary>
            <pre className="mt-2 text-xs"><code>{originalSpec}</code></pre>
          </details>
        )}
    </>
  )
}
