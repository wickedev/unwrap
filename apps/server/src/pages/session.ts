import { html, raw } from 'hono/html'
import type { StoredSession, VerificationResult, VerifyStep } from '@unwrap/protocol'
import { Layout, type Renderable } from './layout'

export function SessionDetailPage({
  email,
  session,
}: {
  email: string
  session: StoredSession
}): Renderable {
  const { summary, generated } = session
  const counts = Object.entries(summary.meta.counts ?? {}).filter(([, v]) => v && v > 0)

  const body = html`
    <p><a href="/sessions">← All sessions</a></p>
    <h2 style="margin-top:4px;">${summary.meta.host || '(no host)'}</h2>
    <p class="muted" style="word-break: break-all;">${summary.meta.url}</p>

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
      <h2>Actions captured</h2>
      <div class="card">
        ${summary.actions.length === 0
          ? html`<div class="muted">No user actions recorded.</div>`
          : html`<ol style="padding-left: 22px; margin: 0;">
              ${summary.actions.slice(0, 30).map(
                (a) => html`<li style="margin: 4px 0;">
                  <code>${a.type}</code> →
                  <code style="font-size: 11px;">${truncate(a.selector?.primary ?? '', 60)}</code>
                </li>`,
              )}
              ${summary.actions.length > 30
                ? html`<li class="muted">... and ${summary.actions.length - 30} more</li>`
                : ''}
            </ol>`}
      </div>
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

  return html`
    <div style="margin-top: 14px;">
      <div class="meta" style="margin-bottom: 8px;">
        <span class="${badgeClass}" style="color: ${badgeColor}; border-color: ${badgeColor};">
          ${status === 'pass' ? '✓ PASS' : status === 'fail' ? '✗ FAIL' : '⚠ ERROR'}
        </span>
        · ${v.passedSteps}/${v.totalSteps} steps passed
        · ${(v.durationMs / 1000).toFixed(1)}s
        · ran ${relativeTime(v.ranAt)}
        ${v.finalUrl ? html` · ended at <code style="font-size:11px;">${truncate(v.finalUrl, 60)}</code>` : ''}
      </div>
      ${v.errorBeforeStart
        ? html`<div class="error">${v.errorBeforeStart}</div>`
        : ''}
      ${v.screenshotRefs.length > 0
        ? html`<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin: 12px 0;">
            ${v.screenshotRefs.map(
              (ref, i) => html`<a href="${screenshotBase}/${ref}" target="_blank" style="display:block;">
                <img src="${screenshotBase}/${ref}" alt="step ${i}" style="width:100%; height:auto; border-radius:6px; border:1px solid var(--border); background: #fff;" loading="lazy" />
                <div class="meta" style="font-size:10px; margin-top:4px; text-align:center;">${i === 0 ? 'initial' : 'after step ' + (i - 1)}</div>
              </a>`,
            )}
          </div>`
        : ''}
      ${v.steps.length > 0
        ? html`<ol style="padding-left: 22px; margin: 12px 0 0 0;">
            ${v.steps.map((s) => renderVerifyStep(s))}
          </ol>`
        : ''}
    </div>
  `
}

function renderVerifyStep(step: VerifyStep): Renderable {
  const symbol = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '·'
  const color = step.status === 'ok' ? '#1f9d55' : step.status === 'failed' ? '#d64545' : 'var(--muted)'
  return html`<li style="margin: 4px 0; color: var(--fg);">
    <span style="color: ${color}; font-weight: 600;">${symbol}</span>
    <code>${step.actionType}</code>
    →
    <code style="font-size: 11px;">${truncate(step.selector, 60)}</code>
    <span class="meta" style="font-size: 11px;">· ${step.durationMs}ms</span>
    ${step.message ? html`<div class="meta" style="margin-left: 18px; color: ${color};">${step.message}</div>` : ''}
  </li>`
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
