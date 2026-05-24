import { html, raw } from 'hono/html'
import type { SessionListItem, StoredSession, VerificationResult, VerifyStep, VisualDiff } from '@unwrap/protocol'
import { Layout, type Renderable } from './layout'
import { renderTimeline } from './timeline'
import { renderSessionWaterfall } from './session-waterfall'

export function SessionDetailPage({
  email,
  session,
  otherSameHost = [],
}: {
  email: string
  session: StoredSession
  otherSameHost?: SessionListItem[]
}): Renderable {
  const { summary, generated } = session
  const counts = Object.entries(summary.meta.counts ?? {}).filter(([, v]) => v && v > 0)

  const reg = session.regression
  const regColor = reg ? (reg.level === 'pass' ? '#1f9d55' : reg.level === 'minor' ? '#b88300' : '#d64545') : '#5e6772'
  const regGlyph = reg ? (reg.level === 'pass' ? '✓' : reg.level === 'minor' ? '⚠' : '✗') : ''

  const body = html`
    <p><a href="/sessions">← All sessions</a></p>
    <h2 style="margin-top:4px;">${summary.meta.host || '(no host)'}</h2>
    <p class="muted" style="word-break: break-all;">${summary.meta.url}</p>

    ${reg
      ? html`<div class="card" style="border-color: ${regColor}; background: color-mix(in oklab, ${regColor} 6%, transparent); margin-bottom: 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
            <div>
              <span style="color:${regColor}; font-weight:600;">${regGlyph} vs previous capture</span>
              <span class="meta" style="margin-left:8px;">${reg.headline}</span>
            </div>
            <a class="btn secondary" href="/sessions/${session.id}/compare/${reg.baselineId}">Full diff →</a>
          </div>
        </div>`
      : ''}

    <div class="section">
      <h2>Capture summary</h2>
      <div class="card">
        <div class="meta">
          started ${new Date(summary.meta.startedAt).toLocaleString()} ·
          duration ${formatDuration(summary.meta.durationMs)} ·
          viewport ${summary.meta.viewport.width}×${summary.meta.viewport.height} ·
          locale ${summary.meta.locale}
        </div>
        ${counts.length > 0
          ? html`<div class="meta" style="margin-top:6px;">
              ${counts.map(([k, v]) => html`<span class="badge" style="margin-right:6px;">${k}: ${v}</span>`)}
            </div>`
          : ''}
        <div class="actions">
          <button id="generate-btn" class="btn">${generated ? '↻ Regenerate' : '✨ Generate Playwright spec'}</button>
          ${generated
            ? html`<a class="btn secondary" id="download-btn" href="#">Download .spec.ts</a>`
            : ''}
          ${otherSameHost.length > 0
            ? html`<select id="compare-select" class="btn secondary" style="padding: 6px 8px;">
                <option value="">Compare with…</option>
                ${otherSameHost.map(
                  (s) => html`<option value="${s.id}">${new Date(s.uploadedAt).toLocaleString()} · ${s.id.slice(0, 8)}</option>`,
                )}
              </select>`
            : ''}
          ${(session.summary.apiCalls?.length ?? 0) > 0
            ? html`<a class="btn secondary" href="/sessions/${session.id}/api">⛁ API inventory (${session.summary.apiCalls!.length})</a>`
            : ''}
        </div>
        <div id="status" class="muted" style="margin-top: 10px;"></div>
      </div>
    </div>

    <div class="section" id="result-section" style="${generated ? '' : 'display:none;'}">
      <h2>Generated spec</h2>
      ${generated
        ? html`
            <div class="card">
              <div class="meta">
                model ${generated.model} ·
                ${generated.assertionsAdded} extra assertions ·
                prompt ${generated.usage.promptTokens} · output ${generated.usage.candidatesTokens} ·
                generated ${relativeTime(generated.generatedAt)}
              </div>
              ${generated.description
                ? html`<p style="margin-top:10px;">${generated.description}</p>`
                : ''}
              ${generated.warnings && generated.warnings.length > 0
                ? html`<div class="error">
                    <strong>Warnings:</strong>
                    <ul style="margin:6px 0 0 18px;">
                      ${generated.warnings.map((w) => html`<li>${w}</li>`)}
                    </ul>
                  </div>`
                : ''}
              <h3 style="margin-top:14px; font-size:13px;">Spec</h3>
              <pre id="spec-pre">${generated.spec}</pre>
            </div>
          `
        : ''}
    </div>

    <div class="section">
      <h2>Replay verification</h2>
      <div class="card">
        <div class="meta">
          Re-execute the captured action trace in a real Chromium (Cloudflare Browser Rendering)
          to confirm the selectors still work and capture screenshots at every step.
        </div>
        <div class="actions">
          <button id="verify-btn" class="btn">
            ${session.verification ? '↻ Re-run verification' : '▶ Verify on real browser'}
          </button>
        </div>
        <div id="verify-status" class="muted" style="margin-top: 10px;"></div>
        ${session.verification
          ? html`${renderVerification(session)}`
          : ''}
      </div>
    </div>

    <div class="section">
      <h2>Timeline</h2>
      ${renderSessionWaterfall(session)}
      <div style="height: 12px;"></div>
      ${renderTimeline(session)}
    </div>
  `

  const safeFilename = `unwrap-${summary.meta.host || 'session'}-${session.id}.spec.ts`
  const initialSpec = generated?.spec ?? ''

  const scripts = html`<script>${raw(`
    (function() {
      const sessionId = ${JSON.stringify(session.id)};
      const filename = ${JSON.stringify(safeFilename)};
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
          link.href = url;
          link.download = filename;
          link.click();
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
          err.className = 'error';
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
            errEl.className = 'error';
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
  `)}</script>`

  return Layout({
    title: summary.meta.host || 'Session',
    email,
    body,
    scripts,
  })
}

function renderVerification(session: StoredSession): Renderable {
  const v = session.verification as VerificationResult
  const status = v.errorBeforeStart
    ? 'error'
    : v.passed
      ? 'pass'
      : 'fail'
  const badgeClass = status === 'pass' ? 'badge ok' : 'badge'
  const badgeColor = status === 'pass' ? '#1f9d55' : '#d64545'
  const screenshotBase = `/api/sessions/${session.id}/screenshots`

  const totalChanged = v.steps.reduce(
    (acc, s) => acc + (s.visualDiff?.diffPixels ?? 0),
    0,
  )
  const totalPixels = v.steps.reduce(
    (acc, s) => acc + (s.visualDiff?.totalPixels ?? 0),
    0,
  )
  const overallPct = totalPixels > 0 ? ((totalChanged / totalPixels) * 100).toFixed(2) : null
  const stepsWithDiff = v.steps.filter((s) => s.visualDiff).length

  return html`
    <div style="margin-top: 14px;">
      <div class="meta" style="margin-bottom: 8px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <span class="${badgeClass}" style="color: ${badgeColor}; border-color: ${badgeColor};">
          ${status === 'pass' ? '✓ PASS' : status === 'fail' ? '✗ FAIL' : '⚠ ERROR'}
        </span>
        <span>· ${v.passedSteps}/${v.totalSteps} actions replayed</span>
        ${stepsWithDiff > 0 && overallPct
          ? html`<span>· ${stepsWithDiff} step${stepsWithDiff === 1 ? '' : 's'} diffed · ${overallPct}% pixels changed overall</span>`
          : ''}
        <span>· ${(v.durationMs / 1000).toFixed(1)}s</span>
        <span>· ran ${relativeTime(v.ranAt)}</span>
        ${v.finalUrl ? html`<span>· ended at <code style="font-size:11px;">${truncate(v.finalUrl, 60)}</code></span>` : ''}
      </div>
      ${v.errorBeforeStart
        ? html`<div class="error">${v.errorBeforeStart}</div>`
        : ''}
      ${v.visualDiffMessage
        ? html`<div class="meta" style="margin: 10px 0; font-size: 11px;">Visual diff skipped: ${v.visualDiffMessage}</div>`
        : ''}
      ${v.steps.length > 0
        ? html`<div style="margin-top: 14px; display:flex; flex-direction:column; gap:14px;">
            ${v.steps.map((s) => renderStepCard(s, screenshotBase))}
          </div>`
        : ''}
    </div>
  `
}

function renderStepCard(step: VerifyStep, screenshotBase: string): Renderable {
  const symbol = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'
  const color = step.status === 'ok' ? '#1f9d55' : step.status === 'failed' ? '#d64545' : 'var(--muted)'
  const isInitial = step.actionType === 'initial'
  const label = isInitial
    ? 'Initial state (post-goto)'
    : `Step ${step.index + 1} · ${step.actionType}`

  return html`<div style="border:1px solid var(--border); border-radius:10px; padding:12px;">
    <div style="display:flex; gap:8px; align-items:baseline; flex-wrap:wrap;">
      <span style="color: ${color}; font-weight: 600;">${symbol}</span>
      <strong style="font-size:13px;">${label}</strong>
      ${!isInitial
        ? html`<code style="font-size:11px; color:var(--muted);">${truncate(step.selector, 80)}</code>`
        : ''}
      <span class="meta" style="font-size:11px; margin-left:auto;">${step.durationMs}ms</span>
    </div>
    ${step.message
      ? html`<div class="meta" style="margin-top: 6px; color: ${color}; font-size: 11px;">${step.message}</div>`
      : ''}
    ${step.visualDiff
      ? renderTriptych(step.visualDiff, screenshotBase)
      : step.screenshotRef
        ? html`<div style="margin-top: 10px;">
            <a href="${screenshotBase}/${step.screenshotRef}" target="_blank" style="display:block;">
              <img src="${screenshotBase}/${step.screenshotRef}" alt="replay" loading="lazy"
                   style="max-width: 100%; height:auto; border-radius:6px; border:1px solid var(--border); background:#fff;" />
            </a>
            <div class="meta" style="font-size:10px; margin-top:4px;">Replay only (no captured screenshot to diff against)</div>
          </div>`
        : ''}
  </div>`
}

function renderTriptych(diff: VisualDiff, screenshotBase: string): Renderable {
  const pct = (diff.diffRatio * 100).toFixed(2)
  const okay = diff.diffRatio < 0.005
  const close = diff.diffRatio < 0.03
  const color = okay ? '#1f9d55' : close ? '#b88300' : '#d64545'
  const drift = okay ? 'minimal drift' : close ? 'visible differences' : 'major drift'

  return html`
    <div class="meta" style="margin: 10px 0 8px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
      <span class="badge" style="color:${color}; border-color:${color};">${pct}% changed</span>
      <span>· ${drift}</span>
      <span>· ${diff.diffPixels.toLocaleString()}/${diff.totalPixels.toLocaleString()} px</span>
      <span>· ${diff.width}×${diff.height}</span>
      ${typeof diff.matchTimeDeltaMs === 'number'
        ? html`<span>· matched within ${diff.matchTimeDeltaMs}ms</span>`
        : ''}
    </div>
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;">
      ${visualCell('Captured', `${screenshotBase}/${diff.originalRef}`)}
      ${visualCell('Replay', `${screenshotBase}/${diff.replayRef}`)}
      ${visualCell('Diff', `${screenshotBase}/${diff.diffRef}`, 'background:#000;')}
    </div>
  `
}

function visualCell(label: string, src: string, extraStyle = ''): Renderable {
  return html`<div>
    <a href="${src}" target="_blank" style="display:block;">
      <img src="${src}" alt="${label}" loading="lazy"
           style="width:100%; height:auto; border-radius:6px; border:1px solid var(--border); ${extraStyle}" />
    </a>
    <div class="meta" style="font-size:10px; margin-top:4px; text-align:center;">${label}</div>
  </div>`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
