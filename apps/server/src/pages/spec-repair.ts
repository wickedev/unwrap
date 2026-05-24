import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { SpecRepairResult } from '../spec-repair'

export function SpecRepairPage({
  email,
  sessionId,
  originalSpec,
  result,
  error,
}: {
  email: string
  sessionId: string
  originalSpec: string
  result?: SpecRepairResult
  error?: string
}): Renderable {
  return Layout({
    title: 'Spec auto-repair',
    email,
    body: html`
      <p><a href="/sessions/${sessionId}">← back to session ${sessionId.slice(0, 8)}</a></p>
      <h2 style="margin-top: 4px;">Spec auto-repair</h2>
      <p class="muted">
        Gemini reads the current spec, the latest captured HTML for the page the spec targets, and the
        failure error message — then proposes a patched spec with updated selectors. Other things
        (test name, structure, intent) stay the same.
      </p>

      ${error ? html`<div class="error">${error}</div>` : ''}

      ${!result
        ? html`<form method="post" action="/sessions/${sessionId}/repair">
            <div class="card">
              <h3 style="margin-top: 0; font-size: 13px;">Paste the failure error message (optional)</h3>
              <p class="meta" style="font-size: 12px;">
                If you have one from a failed CI run, paste it here so Gemini can target the right
                selector. The whole repair still works without it — we'll just rely on diffing the
                current spec against the latest captured DOM.
              </p>
              <textarea name="errorMessage" rows="6" placeholder="expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible() failed&#10;Locator: getByRole('button', { name: 'Sign in' })&#10;..."
                style="width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-family: ui-monospace, monospace; font-size: 12px;"></textarea>
              <div style="margin-top: 12px;">
                <button type="submit" class="btn">🩹 Generate repair</button>
              </div>
            </div>
            <details style="margin-top: 16px;">
              <summary class="muted" style="font-size: 11px; cursor: pointer;">Show current spec</summary>
              <pre style="margin-top: 6px; font-size: 11px;"><code>${originalSpec}</code></pre>
            </details>
          </form>`
        : renderResult(originalSpec, result)}

      <style>${raw(REPAIR_CSS)}</style>
    `,
  })
}

function renderResult(originalSpec: string, r: SpecRepairResult): Renderable {
  const changed = r.repairedSpec && r.repairedSpec !== originalSpec
  return html`
    <div class="card" style="margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px;">
        <div>
          ${changed
            ? html`<strong style="color: #1f9d55;">✓ Repair suggested</strong>`
            : html`<strong style="color: var(--muted);">No change suggested</strong>`}
          <div class="meta" style="font-size: 11px; margin-top: 2px;">
            ${r.contextUsedUrl
              ? html`Grounded on captured HTML of <code>${r.contextUsedUrl}</code> · ${r.contextScannedSessionCount} session${r.contextScannedSessionCount === 1 ? '' : 's'} searched`
              : html`No matching captured HTML found · best-effort from error message + spec`}
            · ${r.model} · ${r.usage.totalTokens} tokens
          </div>
        </div>
      </div>
      <div class="meta" style="font-size: 12px; margin-top: 10px;">
        <strong>Rationale:</strong> ${r.rationale || '(no rationale provided)'}
      </div>
    </div>

    ${changed
      ? html`<div class="repair-grid">
          <div>
            <h3 style="font-size: 13px; margin: 0 0 6px;">Before</h3>
            <pre><code>${originalSpec}</code></pre>
          </div>
          <div>
            <h3 style="font-size: 13px; margin: 0 0 6px; color: #1f9d55;">After (proposed)</h3>
            <pre><code>${r.repairedSpec}</code></pre>
          </div>
        </div>
        <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" class="btn" onclick="copyRepair()">Copy repaired spec</button>
          <span class="meta" style="font-size: 12px; align-self: center;">Paste into your test file and rerun. We don't auto-overwrite the source session's spec — review and commit yourself.</span>
        </div>
        <script>
          function copyRepair() {
            const text = ${JSON.stringify(r.repairedSpec)};
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.querySelector('button.btn[onclick="copyRepair()"]');
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy repaired spec' }, 1500);
            });
          }
        </script>`
      : html`<details>
          <summary class="muted" style="font-size: 11px; cursor: pointer;">Show current spec</summary>
          <pre style="margin-top: 6px; font-size: 11px;"><code>${originalSpec}</code></pre>
        </details>`}
  `
}

const REPAIR_CSS = `
.repair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 900px) { .repair-grid { grid-template-columns: 1fr; } }
.repair-grid pre { max-height: 600px; font-size: 11px; }
`
