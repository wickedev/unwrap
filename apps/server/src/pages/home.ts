import { html, raw } from 'hono/html'
import type { SessionListItem } from '@unwrap/protocol'
import { Layout, type Renderable } from './layout'
import { groupSessionsByHost } from '../project-aggregate'

export function LoginPage(): Renderable {
  return Layout({
    title: 'Sign in',
    body: html`
      <div class="landing">
        <div class="landing-hero">
          <h1 class="landing-title">Unwrap</h1>
          <p class="landing-tagline">Capture a browser session. Get every analysis, test, and integration artifact a service reverse-engineer or QA engineer would build by hand — without building any of them.</p>
          <p style="margin-top: 24px;"><a class="btn" href="/auth/google/start?mode=web">Sign in with Google →</a></p>
        </div>

        <div class="landing-grid">
          <div class="landing-card">
            <div class="landing-card-icon">🔍</div>
            <h3>Analyze</h3>
            <p>Aggregated route map, API inventory with TS types, GraphQL ops, page → API dependency graph, code coverage, WebSocket inventory. Every session deepens the picture.</p>
          </div>
          <div class="landing-card">
            <div class="landing-card-icon">🧪</div>
            <h3>Test</h3>
            <p>AI-generated Playwright specs per session. Test coverage gap analysis. Curated canonical suite exports as a runnable Playwright project drop-in for CI.</p>
          </div>
          <div class="landing-card">
            <div class="landing-card-icon">🛡</div>
            <h3>Audit</h3>
            <p>Security findings (auth scheme matrix, secrets in URLs, mixed content). Accessibility (runtime AX tree audit). Performance (p95 latency, N+1 detection).</p>
          </div>
          <div class="landing-card">
            <div class="landing-card-icon">📦</div>
            <h3>Export</h3>
            <p>OpenAPI 3.0. Postman v2.1. Stateful Node.js mock server. Runnable clone bundle (frontend + mock + run.sh). GraphQL operations.</p>
          </div>
          <div class="landing-card">
            <div class="landing-card-icon">🔌</div>
            <h3>Integrate</h3>
            <p>GitHub App posts PR comments with diff vs prior captures. CLI captures from CI. Sentry correlation matches issues to the user flow that produced them.</p>
          </div>
          <div class="landing-card">
            <div class="landing-card-icon">🤖</div>
            <h3>AI</h3>
            <p>Gemini reads screenshots + API surface + actions to write a service brief. Proposes a test plan from coverage gaps with evidence and assertions.</p>
          </div>
        </div>
      </div>

      <style>${raw(landingCss)}</style>
    `,
  })
}

const landingCss = `
.landing { padding: 24px 0; }
.landing-hero { text-align: center; padding: 32px 0 48px; }
.landing-title { font-size: 42px; font-weight: 700; margin: 0; }
.landing-tagline { color: var(--muted); font-size: 15px; max-width: 640px; margin: 12px auto 0; line-height: 1.6; }
.landing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 16px; }
.landing-card { border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.landing-card-icon { font-size: 22px; margin-bottom: 6px; }
.landing-card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.landing-card p { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.55; }
`

export function SessionsPage({ email, sessions }: { email: string; sessions: SessionListItem[] }): Renderable {
  const projects = groupSessionsByHost(sessions.map((s) => ({ host: s.host, uploadedAt: s.uploadedAt })))
  return Layout({
    title: 'Sessions',
    email,
    body: html`
      ${projects.length > 0
        ? html`<div class="section" style="margin-top: 0;">
            <h2>Projects</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-bottom: 24px;">
              ${projects.map((p) => html`<a href="/projects/${encodeURIComponent(p.host)}" class="card" style="display: block; margin: 0; text-decoration: none; color: inherit;">
                <h3 style="margin: 0 0 4px 0;">${p.host || '(no host)'}</h3>
                <div class="meta">${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'} · last ${relativeTime(p.latestUploadedAt)}</div>
              </a>`)}
            </div>
          </div>`
        : ''}

      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: 16px;">
        <h2 style="margin:0;">Uploaded sessions</h2>
        <span class="muted">${sessions.length} session${sessions.length === 1 ? '' : 's'}</span>
      </div>
      ${sessions.length === 0
        ? html`
            <div class="onboarding">
              <h3 style="margin-top: 0; font-size: 16px;">Welcome — let's capture your first session</h3>
              <p class="muted" style="font-size: 13px;">Two paths:</p>
              <div class="onboarding-grid">
                <div class="onboarding-step">
                  <div class="onboarding-icon">🖱</div>
                  <h4>Interactive (Chrome extension)</h4>
                  <ol>
                    <li>Build + load the Unwrap extension (<code>pnpm --filter @unwrap/extension build</code> → load <code>apps/extension/dist</code> as unpacked at <a href="chrome://extensions" target="_blank">chrome://extensions</a>).</li>
                    <li>Open the side panel on any page you want to analyze.</li>
                    <li>Click Record. Use the site normally. Click Stop. The session uploads here automatically.</li>
                  </ol>
                  <p class="muted" style="font-size: 11px;">Captures everything: clicks, network, DOM, screenshots, AX trees, coverage, WebSockets.</p>
                </div>
                <div class="onboarding-step">
                  <div class="onboarding-icon">🤖</div>
                  <h4>Headless (CI / scripts)</h4>
                  <ol>
                    <li>Mint a token at <a href="/settings/tokens">Settings → API tokens</a>.</li>
                    <li>Run <code>npx @unwrap/cli capture --server=&lt;origin&gt; --token=&lt;token&gt; &lt;urls...&gt;</code> on your machine or in CI.</li>
                    <li>The CLI uploads here when done.</li>
                  </ol>
                  <p class="muted" style="font-size: 11px;">Lighter than the extension (no clicks/DOM/AX/coverage) but enough for surface change detection. <a href="/settings/integrations">Add the GitHub App</a> for auto PR comments.</p>
                </div>
              </div>
            </div>
          `
        : html`<div>
            ${sessions.map((s) => html`
              <div class="card">
                <div class="row">
                  <div style="min-width:0;">
                    <h3><a href="/sessions/${s.id}">${s.host || '(no host)'}</a></h3>
                    <div class="meta" title="${s.startUrl}">${truncate(s.startUrl, 70)}</div>
                    <div class="meta">
                      uploaded ${relativeTime(s.uploadedAt)} · duration ${formatDuration(s.durationMs)}
                    </div>
                  </div>
                  <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                    ${s.regressionLevel && s.regressionBaselineId
                      ? html`<a href="/sessions/${s.id}/compare/${s.regressionBaselineId}"
                              title="${s.regressionHeadline ?? ''} (vs previous capture)"
                              style="text-decoration: none;">
                          <span class="badge"
                                style="color:${regressionColor(s.regressionLevel)}; border-color:${regressionColor(s.regressionLevel)};">
                            ${regressionGlyph(s.regressionLevel)} ${regressionLabel(s.regressionLevel)}
                          </span>
                        </a>`
                      : ''}
                    ${s.verificationStatus === 'pass'
                      ? html`<span class="badge ok">✓ verified</span>`
                      : s.verificationStatus === 'fail'
                        ? html`<span class="badge" style="color:#d64545; border-color:#d64545;">✗ replay fail</span>`
                        : s.verificationStatus === 'error'
                          ? html`<span class="badge" style="color:#d64545; border-color:#d64545;">⚠ replay error</span>`
                          : ''}
                    ${s.hasGeneratedSpec
                      ? html`<span class="badge ok" style="color:#1f9d55; border-color:#1f9d55;">spec</span>`
                      : html`<span class="badge">no spec</span>`}
                  </div>
                </div>
              </div>
            `)}
          </div>`}
      <style>${raw(onboardingCss)}</style>
    `,
  })
}

const onboardingCss = `
.onboarding { border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; }
.onboarding-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 12px; }
.onboarding-step { padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.onboarding-icon { font-size: 22px; margin-bottom: 6px; }
.onboarding-step h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.onboarding-step ol { margin: 0 0 8px; padding-left: 20px; font-size: 12px; line-height: 1.55; }
.onboarding-step ol li { margin-bottom: 6px; }
.onboarding-step code { font-size: 11px; background: rgba(127,127,127,0.1); padding: 1px 5px; border-radius: 4px; }
.onboarding-step p { margin: 6px 0 0; }
`

function regressionColor(l: 'pass' | 'minor' | 'fail'): string {
  return l === 'pass' ? '#1f9d55' : l === 'minor' ? '#b88300' : '#d64545'
}
function regressionGlyph(l: 'pass' | 'minor' | 'fail'): string {
  return l === 'pass' ? '✓' : l === 'minor' ? '⚠' : '✗'
}
function regressionLabel(l: 'pass' | 'minor' | 'fail'): string {
  return l === 'pass' ? 'no regression' : l === 'minor' ? 'changed' : 'regression'
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
