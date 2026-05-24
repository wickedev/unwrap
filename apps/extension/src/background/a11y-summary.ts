import type {
  AccessibilityFinding,
  AccessibilityPageReport,
} from '@unwrap/protocol'
import type { AxTreeEvent, SessionEvent } from '@/shared/events'
import { getBlob } from '@/shared/storage'

const MAX_EVIDENCE_PER_KIND = 12

// CDP AXNode shape — we only model the fields we actually look at.
interface CdpAxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
}

// Reads every captured ax_tree blob for the session and distills a
// per-URL accessibility finding list. We keep it lightweight on
// purpose — the full audit suite belongs on the server when needed.
// These heuristics catch the highest-frequency, highest-confidence
// issues without false positives.
export async function collectAccessibilitySummary(
  events: SessionEvent[],
): Promise<AccessibilityPageReport[] | null> {
  const axEvents = events.filter((e): e is AxTreeEvent => e.type === 'ax_tree')
  if (axEvents.length === 0) return null

  // Dedupe by URL — keep the most recent capture for each URL.
  const latestByUrl = new Map<string, AxTreeEvent>()
  for (const ev of axEvents) {
    const prev = latestByUrl.get(ev.url)
    if (!prev || prev.ts < ev.ts) latestByUrl.set(ev.url, ev)
  }

  const reports: AccessibilityPageReport[] = []
  for (const ev of latestByUrl.values()) {
    const blob = await getBlob(ev.ref)
    if (!blob) continue
    let nodes: CdpAxNode[]
    try {
      nodes = JSON.parse(await blob.text()) as CdpAxNode[]
    } catch {
      continue
    }
    const findings = runHeuristics(nodes)
    reports.push({ url: ev.url, nodeCount: nodes.length, findings })
  }
  return reports
}

function runHeuristics(nodes: CdpAxNode[]): AccessibilityFinding[] {
  const buckets = new Map<AccessibilityFinding['kind'], { count: number; evidence: string[] }>()
  const bucket = (kind: AccessibilityFinding['kind'], evidence: string) => {
    const b = buckets.get(kind) ?? { count: 0, evidence: [] }
    b.count++
    if (b.evidence.length < MAX_EVIDENCE_PER_KIND) b.evidence.push(evidence)
    buckets.set(kind, b)
  }

  const headings: { level: number; name: string }[] = []
  const ariaIds = new Map<string, number>()

  for (const n of nodes) {
    if (n.ignored) continue
    const role = n.role?.value ?? ''
    const name = (n.name?.value ?? '').trim()
    const desc = n.description?.value ?? ''

    // Element-id collection for the duplicate-id check.
    const idProp = n.properties?.find((p) => p.name === 'id')
    const idVal = typeof idProp?.value?.value === 'string' ? (idProp.value.value as string) : ''
    if (idVal) ariaIds.set(idVal, (ariaIds.get(idVal) ?? 0) + 1)

    switch (role) {
      case 'button':
        if (!name) bucket('button-no-name', `<button> id=${idVal || '(none)'}`)
        break
      case 'link':
        if (!name) bucket('link-no-name', `<a> id=${idVal || '(none)'} ${desc ? `desc="${desc.slice(0, 40)}"` : ''}`.trim())
        break
      case 'image':
      case 'img':
        if (!name) bucket('image-no-alt', `<img> id=${idVal || '(none)'}`)
        break
      case 'textbox':
      case 'searchbox':
      case 'combobox':
      case 'checkbox':
      case 'radio':
        if (!name) bucket('input-no-label', `<${role}> id=${idVal || '(none)'}`)
        break
      case 'heading': {
        const levelProp = n.properties?.find((p) => p.name === 'level')
        const level = typeof levelProp?.value?.value === 'number' ? (levelProp.value.value as number) : 0
        if (level > 0) headings.push({ level, name: name || '(empty)' })
        break
      }
    }

    // aria-hidden + focusable contradiction
    const hidden = n.properties?.find((p) => p.name === 'hidden')
    const focusable = n.properties?.find((p) => p.name === 'focusable')
    if (hidden?.value?.value === true && focusable?.value?.value === true) {
      bucket('aria-hidden-focusable', `<${role || '?'}> id=${idVal || '(none)'}`)
    }
  }

  // Heading-level skip: e.g. h1 → h3 with no h2 in between.
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1]!
    const cur = headings[i]!
    if (cur.level > prev.level + 1) {
      bucket('heading-skip', `h${prev.level} "${prev.name.slice(0, 40)}" → h${cur.level} "${cur.name.slice(0, 40)}"`)
    }
  }

  for (const [id, count] of ariaIds) {
    if (count > 1) bucket('duplicate-aria-id', `id="${id}" used ${count} times`)
  }

  return [...buckets.entries()]
    .map<AccessibilityFinding>(([kind, b]) => ({ kind, count: b.count, evidence: b.evidence }))
    .sort((a, b) => b.count - a.count)
}
