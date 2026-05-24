import * as React from 'react'
import type { SessionListItem, StoredSession, VerificationResult, VerifyStep, VisualDiff } from '@unwrap/protocol'
import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Badge } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { Input, Select } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import { Timeline } from './timeline'
import { SessionWaterfall } from './session-waterfall'

export function SessionDetailPage({
  email,
  session,
  otherSameHost = [],
  isCanonical = false,
}: {
  email: string
  session: StoredSession
  otherSameHost?: SessionListItem[]
  isCanonical?: boolean
}) {
  const { summary, generated } = session
  const counts = Object.entries(summary.meta.counts ?? {}).filter(([, v]) => v && v > 0)
  const reg = session.regression
  const regVariant = reg ? (reg.level === 'pass' ? 'success' : reg.level === 'minor' ? 'warning' : 'danger') : 'muted'
  const regGlyph = reg ? (reg.level === 'pass' ? '✓' : reg.level === 'minor' ? '⚠' : '✗') : ''
  const safeFilename = `unwrap-${summary.meta.host || 'session'}-${session.id}.spec.ts`
  const initialSpec = generated?.spec ?? ''

  return (
    <Layout email={email}>
      <p className="m-0 mb-2"><a href="/" className="text-primary text-sm">← All sessions</a></p>
      <h2 className="m-0 text-xl font-bold">{summary.meta.host || '(no host)'}</h2>
      <p className="text-xs text-muted-foreground break-all m-0 mb-4">{summary.meta.url}</p>

      {reg && (
        <Card className={cn('mb-4 border-2', regVariant === 'success' ? 'border-success/40 bg-success/5' : regVariant === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-danger/40 bg-danger/5')}>
          <CardContent className="p-4 flex justify-between items-center gap-3 flex-wrap">
            <div>
              <span className={cn('font-semibold', regVariant === 'success' ? 'text-success' : regVariant === 'warning' ? 'text-warning' : 'text-danger')}>
                {regGlyph} vs previous capture
              </span>
              <span className="text-xs text-muted-foreground ml-2">{reg.headline}</span>
            </div>
            <Button asChild variant="secondary" size="sm"><a href={`/sessions/${session.id}/compare/${reg.baselineId}`}>Full diff →</a></Button>
          </CardContent>
        </Card>
      )}

      {session.video && (
        <Section title="Tab recording">
          <Card>
            <CardContent className="p-4">
              <video
                controls
                preload="metadata"
                src={`/api/sessions/${session.id}/video`}
                className="w-full rounded-md border bg-black"
                style={{ maxHeight: '60vh' }}
              />
              <div className="text-xs text-muted-foreground mt-2">
                {session.video.mimeType} · {formatBytes(session.video.sizeBytes)}{session.video.durationMs > 0 ? ` · ${formatDuration(session.video.durationMs)}` : ''}
              </div>
            </CardContent>
          </Card>
        </Section>
      )}

      {!session.video && session.videoError && (
        <Section title="Tab recording">
          <Card className="border-warning/40 bg-warning/5">
            <CardContent className="p-4">
              <div className="text-sm">
                <strong className="text-warning">⚠️ Video not captured.</strong> {session.videoError}
              </div>
            </CardContent>
          </Card>
        </Section>
      )}

      <Section title="Capture summary">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              started {new Date(summary.meta.startedAt).toLocaleString()} · duration {formatDuration(summary.meta.durationMs)} · viewport {summary.meta.viewport.width}×{summary.meta.viewport.height} · locale {summary.meta.locale}
            </div>
            {counts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {counts.map(([k, v]) => <Badge key={k} variant="muted">{k}: {v}</Badge>)}
              </div>
            )}
            <div className="mt-3 flex gap-2 flex-wrap items-center">
              <Button id="generate-btn">{generated ? '↻ Regenerate' : '✨ Generate Playwright spec'}</Button>
              {generated && <Button asChild variant="secondary" id="download-btn"><a href="#">Download .spec.ts</a></Button>}
              {otherSameHost.length > 0 && (
                <Select id="compare-select" defaultValue="" className="max-w-xs">
                  <option value="">Compare with…</option>
                  {otherSameHost.map((s) => <option key={s.id} value={s.id}>{new Date(s.uploadedAt).toLocaleString()} · {s.id.slice(0, 8)}</option>)}
                </Select>
              )}
              {(session.summary.apiCalls?.length ?? 0) > 0 && (
                <Button asChild variant="secondary"><a href={`/sessions/${session.id}/api`}>⛁ API inventory ({session.summary.apiCalls!.length})</a></Button>
              )}
            </div>
            <div id="status" className="text-xs text-muted-foreground mt-3" />
          </CardContent>
        </Card>
      </Section>

      {generated && (
        <Section title="Generated spec" id="result-section">
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">
                model {generated.model} · {generated.assertionsAdded} extra assertions · prompt {generated.usage.promptTokens} · output {generated.usage.candidatesTokens} · generated {relativeTime(generated.generatedAt)}
              </div>
              {generated.description && <p className="mt-2 text-sm">{generated.description}</p>}
              {generated.warnings && generated.warnings.length > 0 && (
                <div className="mt-3 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
                  <strong>Warnings:</strong>
                  <ul className="mt-1.5 ml-5 list-disc">
                    {generated.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
              <h3 className="mt-4 mb-1.5 text-sm font-semibold">Spec</h3>
              <pre id="spec-pre" className="text-xs"><code>{generated.spec}</code></pre>
              <div className="mt-3 pt-3 border-t flex gap-2 flex-wrap items-center">
                <Button asChild variant="secondary"><a href={`/sessions/${session.id}/repair`}>🩹 Suggest repair</a></Button>
                <span className="text-xs text-muted-foreground">Gemini reads the current spec + latest captured HTML and proposes selector fixes.</span>
              </div>
              <div className="mt-3 pt-3 border-t">
                {isCanonical
                  ? (
                    <div className="flex justify-between items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-success">
                        ✓ Marked as canonical for <a href={`/projects/${encodeURIComponent(session.summary.meta.host)}/tests`} className="text-primary">{session.summary.meta.host}</a>
                      </span>
                      <form method="post" action={`/projects/${encodeURIComponent(session.summary.meta.host)}/tests/${encodeURIComponent(session.id)}/remove`} onSubmit={"return confirm('Remove from canonical suite?')" as never}>
                        <Button type="submit" variant="secondary" size="sm">Unmark</Button>
                      </form>
                    </div>
                  )
                  : (
                    <form method="post" action={`/projects/${encodeURIComponent(session.summary.meta.host)}/tests`} className="flex gap-1.5 flex-wrap items-center">
                      <input type="hidden" name="sessionId" value={session.id} />
                      <Input type="text" name="name" required maxLength={80} placeholder="Test name (e.g. login-and-dashboard)" className="flex-1 min-w-[200px] h-8 text-xs" />
                      <Input type="text" name="tags" maxLength={120} placeholder="tags (comma-separated)" className="flex-1 min-w-[160px] h-8 text-xs" />
                      <Button type="submit">★ Mark as canonical test</Button>
                    </form>
                  )}
              </div>
            </CardContent>
          </Card>
        </Section>
      )}

      <Section title="Replay verification">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              Re-execute the captured action trace in a real Chromium (Cloudflare Browser Rendering) to confirm the selectors still work and capture screenshots at every step.
            </div>
            <div className="mt-3">
              <Button id="verify-btn">{session.verification ? '↻ Re-run verification' : '▶ Verify on real browser'}</Button>
            </div>
            <div id="verify-status" className="text-xs text-muted-foreground mt-3" />
            {session.verification && <VerificationView session={session} />}
          </CardContent>
        </Card>
      </Section>

      <Section title="Timeline">
        <SessionWaterfall session={session} />
        <div className="h-3" />
        <Timeline session={session} />
      </Section>

      <script dangerouslySetInnerHTML={{ __html: SCRIPT(session.id, safeFilename, initialSpec) }} />
    </Layout>
  )
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="mb-6" id={id}>
      <h2 className="text-sm font-semibold m-0 mb-3">{title}</h2>
      {children}
    </section>
  )
}

function VerificationView({ session }: { session: StoredSession }) {
  const v = session.verification as VerificationResult
  const status = v.errorBeforeStart ? 'error' : v.passed ? 'pass' : 'fail'
  const variant = status === 'pass' ? 'success' : 'danger'
  const screenshotBase = `/api/sessions/${session.id}/screenshots`
  const totalChanged = v.steps.reduce((acc, s) => acc + (s.visualDiff?.diffPixels ?? 0), 0)
  const totalPixels = v.steps.reduce((acc, s) => acc + (s.visualDiff?.totalPixels ?? 0), 0)
  const overallPct = totalPixels > 0 ? ((totalChanged / totalPixels) * 100).toFixed(2) : null
  const stepsWithDiff = v.steps.filter((s) => s.visualDiff).length

  return (
    <div className="mt-4">
      <div className="mb-2 flex gap-1.5 flex-wrap items-center text-xs text-muted-foreground">
        <Badge variant={variant}>{status === 'pass' ? '✓ PASS' : status === 'fail' ? '✗ FAIL' : '⚠ ERROR'}</Badge>
        <span>· {v.passedSteps}/{v.totalSteps} actions replayed</span>
        {stepsWithDiff > 0 && overallPct && (
          <span>· {stepsWithDiff} step{stepsWithDiff === 1 ? '' : 's'} diffed · {overallPct}% pixels changed overall</span>
        )}
        <span>· {(v.durationMs / 1000).toFixed(1)}s</span>
        <span>· ran {relativeTime(v.ranAt)}</span>
        {v.finalUrl && <span>· ended at <code className="text-[11px]">{truncate(v.finalUrl, 60)}</code></span>}
      </div>
      {v.errorBeforeStart && (
        <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{v.errorBeforeStart}</div>
      )}
      {v.visualDiffMessage && <div className="text-xs text-muted-foreground mt-2">Visual diff skipped: {v.visualDiffMessage}</div>}
      {v.steps.length > 0 && (
        <div className="mt-4 flex flex-col gap-3.5">
          {v.steps.map((s) => <StepCard key={s.index} step={s} screenshotBase={screenshotBase} />)}
        </div>
      )}
    </div>
  )
}

function StepCard({ step, screenshotBase }: { step: VerifyStep; screenshotBase: string }) {
  const symbol = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'
  const colorClass = step.status === 'ok' ? 'text-success' : step.status === 'failed' ? 'text-danger' : 'text-muted-foreground'
  const isInitial = step.actionType === 'initial'
  const label = isInitial ? 'Initial state (post-goto)' : `Step ${step.index + 1} · ${step.actionType}`

  return (
    <div className="rounded-lg border p-3">
      <div className="flex gap-2 items-baseline flex-wrap">
        <span className={cn('font-semibold', colorClass)}>{symbol}</span>
        <strong className="text-sm">{label}</strong>
        {!isInitial && <code className="text-xs text-muted-foreground">{truncate(step.selector, 80)}</code>}
        <span className="text-xs text-muted-foreground ml-auto">{step.durationMs}ms</span>
      </div>
      {step.message && <div className={cn('mt-1.5 text-xs', colorClass)}>{step.message}</div>}
      {step.visualDiff
        ? <Triptych diff={step.visualDiff} screenshotBase={screenshotBase} />
        : step.screenshotRef
          ? (
            <div className="mt-3">
              <a href={`${screenshotBase}/${step.screenshotRef}`} target="_blank" rel="noreferrer" className="block">
                <img src={`${screenshotBase}/${step.screenshotRef}`} alt="replay" loading="lazy" className="max-w-full h-auto rounded-md border bg-white" />
              </a>
              <div className="text-[10px] text-muted-foreground mt-1">Replay only (no captured screenshot to diff against)</div>
            </div>
          )
          : null}
    </div>
  )
}

function Triptych({ diff, screenshotBase }: { diff: VisualDiff; screenshotBase: string }) {
  const pct = (diff.diffRatio * 100).toFixed(2)
  const okay = diff.diffRatio < 0.005
  const close = diff.diffRatio < 0.03
  const variant = okay ? 'success' : close ? 'warning' : 'danger'
  const drift = okay ? 'minimal drift' : close ? 'visible differences' : 'major drift'

  return (
    <>
      <div className="mt-3 mb-2 flex gap-1.5 items-center flex-wrap text-xs text-muted-foreground">
        <Badge variant={variant}>{pct}% changed</Badge>
        <span>· {drift}</span>
        <span>· {diff.diffPixels.toLocaleString()}/{diff.totalPixels.toLocaleString()} px</span>
        <span>· {diff.width}×{diff.height}</span>
        {typeof diff.matchTimeDeltaMs === 'number' && <span>· matched within {diff.matchTimeDeltaMs}ms</span>}
      </div>
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
        <VisualCell label="Captured" src={`${screenshotBase}/${diff.originalRef}`} />
        <VisualCell label="Replay" src={`${screenshotBase}/${diff.replayRef}`} />
        <VisualCell label="Diff" src={`${screenshotBase}/${diff.diffRef}`} dark />
      </div>
    </>
  )
}

function VisualCell({ label, src, dark }: { label: string; src: string; dark?: boolean }) {
  return (
    <div>
      <a href={src} target="_blank" rel="noreferrer" className="block">
        <img src={src} alt={label} loading="lazy" className={cn('w-full h-auto rounded-md border', dark && 'bg-black')} />
      </a>
      <div className="text-[10px] text-muted-foreground mt-1 text-center">{label}</div>
    </div>
  )
}

function SCRIPT(sessionId: string, filename: string, initialSpec: string) {
  return `
    (function() {
      const sessionId = ${JSON.stringify(sessionId)};
      const filename = ${JSON.stringify(filename)};
      const btn = document.getElementById('generate-btn');
      const status = document.getElementById('status');
      const resultSection = document.getElementById('result-section');
      let currentSpec = ${JSON.stringify(initialSpec)};
      function attachDownload() {
        const a = document.getElementById('download-btn');
        if (!a) return;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const blob = new Blob([currentSpec || ''], { type: 'text/typescript' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      }
      attachDownload();
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        status.textContent = 'Calling Gemini… (5–30s)';
        try {
          const resp = await fetch('/api/sessions/' + sessionId + '/generate', { method: 'POST' });
          const body = await resp.json();
          if (!resp.ok) throw new Error(body.error || ('HTTP ' + resp.status));
          currentSpec = body.spec || '';
          status.textContent = 'Done — reloading view…';
          location.reload();
        } catch (e) {
          status.innerHTML = '';
          const err = document.createElement('div');
          err.className = 'text-danger';
          err.textContent = (e && e.message) || String(e);
          status.appendChild(err);
          btn.disabled = false;
        }
      });
      const verifyBtn = document.getElementById('verify-btn');
      const verifyStatus = document.getElementById('verify-status');
      if (verifyBtn && verifyStatus) {
        verifyBtn.addEventListener('click', async () => {
          verifyBtn.disabled = true;
          verifyStatus.textContent = 'Spawning Chromium and replaying the action trace… (10–60s)';
          try {
            const resp = await fetch('/api/sessions/' + sessionId + '/verify', { method: 'POST' });
            const body = await resp.json();
            if (!resp.ok) throw new Error(body.error || ('HTTP ' + resp.status));
            verifyStatus.textContent = body.passed
              ? 'Replay passed (' + body.passedSteps + '/' + body.totalSteps + ') — reloading view…'
              : 'Replay finished — reloading view…';
            location.reload();
          } catch (e) {
            verifyStatus.innerHTML = '';
            const errEl = document.createElement('div');
            errEl.className = 'text-danger';
            errEl.textContent = (e && e.message) || String(e);
            verifyStatus.appendChild(errEl);
            verifyBtn.disabled = false;
          }
        });
      }
      const compareSelect = document.getElementById('compare-select');
      if (compareSelect) {
        compareSelect.addEventListener('change', (e) => {
          const otherId = e.target.value;
          if (!otherId) return;
          location.href = '/sessions/' + sessionId + '/compare/' + otherId;
        });
      }
    })();
  `
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}
function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
function relativeTime(ts: number) {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
