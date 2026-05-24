import type { StoredSession } from '@unwrap/protocol'
import { aggregateProject } from './project-aggregate'
import { compareProjects } from './project-compare'

// HTML comment marker so the commenter (in the CLI or GitHub App) can
// recognize its own prior comment and edit it in-place rather than spam
// a new comment on every CI push.
export const UNWRAP_COMMENT_MARKER = '<!-- unwrap:pr-comment:v1 -->'

// Builds a PR-friendly markdown comment for a freshly-uploaded session.
// If a baseline session exists for the host, we run the project-diff
// between (everything before this upload) and (everything including
// this upload) so the comment surfaces what changed. If this is the
// first capture for the host, we fall back to a summary-only message.
export function buildSessionPrComment(opts: {
  origin: string
  current: StoredSession
  baselineSessions: StoredSession[]
  currentSessions: StoredSession[]
}): string {
  const { origin, current, baselineSessions, currentSessions } = opts
  const host = current.summary.meta.host || 'unknown'
  const projectUrl = `${origin}/projects/${encodeURIComponent(host)}`
  const sessionUrl = `${origin}/sessions/${current.id}`

  const lines: string[] = []
  lines.push(UNWRAP_COMMENT_MARKER)
  lines.push(`## 📋 Unwrap capture — \`${host}\``)
  lines.push('')

  if (baselineSessions.length === 0) {
    lines.push(`First capture for this host. [Open project view →](${projectUrl})`)
    lines.push('')
    lines.push(`<details><summary>What we captured</summary>`)
    lines.push('')
    lines.push(`- ${current.summary.navigations.length} navigation${current.summary.navigations.length === 1 ? '' : 's'}`)
    lines.push(`- ${current.summary.apiCalls?.length ?? 0} API call${current.summary.apiCalls?.length === 1 ? '' : 's'}`)
    if (current.summary.consoleErrors.length > 0) {
      lines.push(`- ⚠ ${current.summary.consoleErrors.length} console error${current.summary.consoleErrors.length === 1 ? '' : 's'}`)
    }
    lines.push('')
    lines.push(`</details>`)
    return lines.join('\n')
  }

  const baseline = aggregateProject(host, baselineSessions)
  const incoming = aggregateProject(host, currentSessions)
  const diff = compareProjects(baseline, incoming)

  const e = diff.endpoints
  const r = diff.routes
  const g = diff.graphqlOps

  const summaryParts: string[] = []
  if (e.addedInRight.length > 0) summaryParts.push(`✨ +${e.addedInRight.length} endpoints`)
  if (e.removedInRight.length > 0) summaryParts.push(`🗑 −${e.removedInRight.length} endpoints`)
  if (e.changed.length > 0) summaryParts.push(`⚠ ${e.changed.length} endpoints changed`)
  if (r.addedInRight.length > 0) summaryParts.push(`+${r.addedInRight.length} routes`)
  if (r.removedInRight.length > 0) summaryParts.push(`−${r.removedInRight.length} routes`)
  if (g.changed.length > 0) summaryParts.push(`🧬 ${g.changed.length} GraphQL ops changed`)

  if (summaryParts.length === 0) {
    lines.push(`✅ No surface changes detected vs the previous ${baselineSessions.length} capture${baselineSessions.length === 1 ? '' : 's'} of this host.`)
    lines.push('')
    lines.push(`[Project view →](${projectUrl}) · [Session →](${sessionUrl})`)
    return lines.join('\n')
  }

  lines.push(summaryParts.join(' · '))
  lines.push('')

  // Breaking changes section — most important — schema diffs only.
  const breakingEndpoints = e.changed.filter((c) => c.schemaChanges.some((sc) => sc.kind === '-' || sc.detail.includes('type ')))
  if (breakingEndpoints.length > 0) {
    lines.push('### 💥 Potentially breaking schema changes')
    lines.push('')
    for (const c of breakingEndpoints.slice(0, 10)) {
      lines.push(`**${c.method} ${c.normalizedPath}**`)
      for (const sc of c.schemaChanges.slice(0, 5)) {
        lines.push(`- \`${sc.kind}\` \`${sc.path}\` — ${sc.detail}`)
      }
      if (c.schemaChanges.length > 5) {
        lines.push(`- _…+${c.schemaChanges.length - 5} more_`)
      }
      lines.push('')
    }
  }

  // Added/removed endpoints — concise
  if (e.addedInRight.length > 0) {
    lines.push('### ✨ New endpoints')
    for (const ep of e.addedInRight.slice(0, 10)) {
      lines.push(`- \`${ep.method} ${ep.normalizedPath}\``)
    }
    if (e.addedInRight.length > 10) lines.push(`- _…+${e.addedInRight.length - 10} more_`)
    lines.push('')
  }
  if (e.removedInRight.length > 0) {
    lines.push('### 🗑 Removed endpoints')
    for (const ep of e.removedInRight.slice(0, 10)) {
      lines.push(`- \`${ep.method} ${ep.normalizedPath}\``)
    }
    if (e.removedInRight.length > 10) lines.push(`- _…+${e.removedInRight.length - 10} more_`)
    lines.push('')
  }

  // Status histogram drift — e.g., new 500s
  const statusChanges = e.changed.filter((c) => c.statusesAddedInRight.length > 0 || c.statusesRemovedInRight.length > 0)
  const new5xx = statusChanges.filter((c) => c.statusesAddedInRight.some((s) => s >= 500))
  if (new5xx.length > 0) {
    lines.push('### 🔥 Endpoints returning new 5xx')
    for (const c of new5xx.slice(0, 10)) {
      lines.push(`- \`${c.method} ${c.normalizedPath}\` — added ${c.statusesAddedInRight.filter((s) => s >= 500).join(', ')}`)
    }
    lines.push('')
  }

  // GraphQL changes
  if (g.changed.length > 0) {
    lines.push('### 🧬 GraphQL changes')
    for (const c of g.changed.slice(0, 10)) {
      const bits: string[] = []
      if (c.variablesAddedInRight.length > 0) bits.push(`+${c.variablesAddedInRight.length} var${c.variablesAddedInRight.length === 1 ? '' : 's'}`)
      if (c.variablesRemovedInRight.length > 0) bits.push(`−${c.variablesRemovedInRight.length} var${c.variablesRemovedInRight.length === 1 ? '' : 's'}`)
      if (c.variablesTypeChanged.length > 0) bits.push(`${c.variablesTypeChanged.length} type change${c.variablesTypeChanged.length === 1 ? '' : 's'}`)
      if (c.typenamesAddedInRight.length > 0) bits.push(`+${c.typenamesAddedInRight.length} typename${c.typenamesAddedInRight.length === 1 ? '' : 's'}`)
      lines.push(`- **${c.left.operationType} ${c.name}** — ${bits.join(', ')}`)
    }
    lines.push('')
  }

  // Footer with links
  lines.push('---')
  lines.push(`[Project view →](${projectUrl}) · [This session →](${sessionUrl})`)

  return lines.join('\n')
}
