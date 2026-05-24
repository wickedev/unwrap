import type { Env } from './env'
import { findInstallationForRepo, getInstallationToken, postOrUpdateCommentAsApp } from './github-app'
import { runSingleMonitor } from './monitor'
import type { MonitorConfig } from './storage/monitor'
import { getSession as getStoredSession, listSessions } from './storage/sessions'
import { listProjectRepoBindings } from './storage/project-repo'

// PR bot — fires on `pull_request` events. For each known
// repo-to-project binding, looks up an active deploy preview URL (parsed
// from prior Vercel/Netlify/Render bot comments on the same PR),
// triggers a one-off synthetic check against that URL, and posts the
// drift result as an idempotent PR comment using the App's bot
// identity.

export interface PrEvent {
  action: 'opened' | 'synchronize' | 'reopened' | 'edited' | 'closed' | string
  number: number
  pull_request: {
    number: number
    html_url: string
    head: { sha: string; ref: string }
    base: { ref: string }
    title: string
    body?: string | null
  }
  repository: {
    full_name: string
  }
}

const PREVIEW_HOST_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Vercel', re: /https:\/\/[a-z0-9-]+-[a-z0-9]+\.vercel\.app(?=[\s/)\]>"]|$)/i },
  { name: 'Netlify', re: /https:\/\/deploy-preview-\d+--[a-z0-9-]+\.netlify\.app(?=[\s/)\]>"]|$)/i },
  { name: 'Netlify', re: /https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app(?=[\s/)\]>"]|$)/i },
  { name: 'Render', re: /https:\/\/pr-\d+-[a-z0-9-]+\.onrender\.com(?=[\s/)\]>"]|$)/i },
  { name: 'Cloudflare Pages', re: /https:\/\/[a-z0-9]+\.[a-z0-9-]+\.pages\.dev(?=[\s/)\]>"]|$)/i },
]

// Returns the most-recent preview URL found in the PR body + bot
// comments. The Vercel/Netlify/Render/CF bot comments tend to update the
// same comment in place, so picking the latest comment match works in
// practice.
export async function findPreviewUrl(env: Env, repo: string, pullNumber: number, prBody: string | null | undefined): Promise<string | null> {
  if (prBody) {
    const fromBody = scanText(prBody)
    if (fromBody) return fromBody
  }
  const installId = await findInstallationForRepo(env, repo)
  if (installId == null) return null
  const token = await getInstallationToken(env, installId)
  const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${pullNumber}/comments?per_page=100`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'unwrap-app',
    },
  })
  if (!resp.ok) return null
  const comments = (await resp.json()) as { body?: string; created_at?: string; updated_at?: string }[]
  // Walk newest-first.
  const sorted = comments.slice().sort((a, b) => (Date.parse(b.updated_at ?? b.created_at ?? '0') || 0) - (Date.parse(a.updated_at ?? a.created_at ?? '0') || 0))
  for (const c of sorted) {
    const m = scanText(c.body ?? '')
    if (m) return m
  }
  return null
}

function scanText(s: string): string | null {
  for (const p of PREVIEW_HOST_PATTERNS) {
    const m = s.match(p.re)
    if (m) return m[0]
  }
  return null
}

// Walks every (email, host) bound to `repo` and triggers a PR-scoped
// synthetic check. Each result is appended to a single Unwrap PR comment
// (idempotently — the marker on the comment ensures repeat pushes edit
// in place instead of stacking comments).
export async function handlePullRequestEvent(env: Env, origin: string, event: PrEvent): Promise<{ posted: number; previewUrl: string | null }> {
  const repo = event.repository.full_name
  const pr = event.pull_request
  const bindings = await listProjectRepoBindings(env, repo)
  if (bindings.length === 0) return { posted: 0, previewUrl: null }
  const previewUrl = await findPreviewUrl(env, repo, pr.number, pr.body ?? null)
  // If we can't find a preview URL, post a comment explaining + asking the
  // user to add one to the PR body. Better than silently doing nothing.
  if (!previewUrl) {
    const body = renderNoPreviewComment(bindings.map((b) => b.host))
    try { await postOrUpdateCommentAsApp({ env, repo, pullNumber: pr.number, body }) } catch (e) { console.warn('[unwrap-pr] no-preview comment failed', e) }
    return { posted: 1, previewUrl: null }
  }

  const sections: PrSection[] = []
  for (const b of bindings) {
    try {
      const baseline = await pickBaselineSession(env, b.email, b.host)
      const ephemeralCfg: MonitorConfig = {
        enabled: true,
        interval: '1h',
        entryUrl: previewUrl,
        alertSlack: false,
        updatedAt: Date.now(),
      }
      const run = await runSingleMonitor(env, b.email, b.host, ephemeralCfg, origin)
      sections.push({ host: b.host, run, baselineUploadedAt: baseline?.uploadedAt ?? null })
    } catch (e) {
      sections.push({ host: b.host, error: asMessage(e) })
    }
  }
  const body = renderComment({ previewUrl, sections, prHeadSha: pr.head.sha, origin })
  try {
    await postOrUpdateCommentAsApp({ env, repo, pullNumber: pr.number, body })
  } catch (e) {
    console.warn('[unwrap-pr] post comment failed', e)
    return { posted: 0, previewUrl }
  }
  return { posted: 1, previewUrl }
}

async function pickBaselineSession(env: Env, email: string, host: string) {
  const items = await listSessions(env, email)
  const c = items.find((s) => s.host === host)
  if (!c) return null
  return getStoredSession(env, email, c.id)
}

interface PrSection {
  host: string
  run?: Awaited<ReturnType<typeof runSingleMonitor>>
  baselineUploadedAt?: number | null
  error?: string
}

function renderComment(opts: { previewUrl: string; sections: PrSection[]; prHeadSha: string; origin: string }): string {
  const lines: string[] = []
  lines.push('<!-- unwrap:pr-comment:v1 -->')
  lines.push(`### 🪄 Unwrap PR check`)
  lines.push('')
  lines.push(`Preview: ${opts.previewUrl} · Head: \`${opts.prHeadSha.slice(0, 7)}\``)
  lines.push('')
  for (const s of opts.sections) {
    lines.push(`#### \`${s.host}\``)
    if (s.error) {
      lines.push(`> ⚠️ Check failed: ${s.error}`)
      lines.push('')
      continue
    }
    if (!s.run) continue
    const r = s.run
    const emoji = r.status === 'ok' ? '✅' : r.status === 'regression' ? '🚨' : '⚠️'
    lines.push(`${emoji} **${r.status.toUpperCase()}** — ${r.headline}`)
    if (r.finalStatus) lines.push(`- Final HTTP: \`${r.finalStatus}\``)
    if (r.newEndpointCount + r.missingEndpointCount + r.statusChangeCount > 0) {
      lines.push(`- API surface drift: +${r.newEndpointCount} new · -${r.missingEndpointCount} missing · ${r.statusChangeCount} status changed`)
    }
    if (r.consoleErrorDelta !== 0) lines.push(`- Console error delta: ${r.consoleErrorDelta > 0 ? '+' : ''}${r.consoleErrorDelta}`)
    if (s.baselineUploadedAt) {
      const ago = humanAgo(Date.now() - s.baselineUploadedAt)
      lines.push(`- Baseline: capture from ${ago} ago`)
    }
    lines.push(`- [Open project →](${opts.origin}/projects/${encodeURIComponent(s.host)}) · [Monitor history →](${opts.origin}/projects/${encodeURIComponent(s.host)}/monitor)`)
    lines.push('')
  }
  lines.push('')
  lines.push('<sub>This comment is updated on every push. Connect more hosts via the project page.</sub>')
  return lines.join('\n')
}

function renderNoPreviewComment(hosts: string[]): string {
  return [
    '<!-- unwrap:pr-comment:v1 -->',
    '### 🪄 Unwrap PR check',
    '',
    `I couldn't find a deploy-preview URL for this PR. To run synthetic checks on the preview, add a Vercel/Netlify/Render/CF Pages preview URL to the PR body or wait for the deploy bot's comment.`,
    '',
    `Bound projects: ${hosts.map((h) => '`' + h + '`').join(', ')}`,
  ].join('\n')
}

function humanAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
