import { html, raw } from 'hono/html'
import type { StoredSession } from '@unwrap/protocol'
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
    })();
  `)}</script>`

  return Layout({
    title: summary.meta.host || 'Session',
    email,
    body,
    scripts,
  })
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
