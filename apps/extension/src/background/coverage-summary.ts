import type { CoverageFile, CoverageSummary } from '@unwrap/protocol'
import type { CoverageEvent, SessionEvent } from '@/shared/events'
import { getBlob } from '@/shared/storage'

// Cap how many per-file rows we ship up — the headline totals carry
// the big picture; the file list is for surfacing the heavy offenders.
const MAX_FILES = 50

// Reads the coverage blob the CoverageTracker stashed during capture
// and builds the protocol-shaped summary. The blob holds raw V8
// PreciseCoverage plus CSS rule deltas — we collapse them per-file so
// the server can show "vendor.js: 2.1MB total, 12% used".
//
// Returns null when no coverage event is present (Profiler/CSS CDP
// domains failed to attach) so the caller can skip the field cleanly.
export async function collectCoverageSummary(
  events: SessionEvent[],
): Promise<CoverageSummary | null> {
  // The recorder emits one coverage event at session end. If somehow
  // multiple end up here we use the most recent.
  const covEvents = events.filter((e): e is CoverageEvent => e.type === 'coverage')
  if (covEvents.length === 0) return null
  const ev = covEvents[covEvents.length - 1]!
  const blob = await getBlob(ev.ref)
  if (!blob) {
    // Fall back to the aggregate-only summary the event itself carries.
    return {
      jsUsedBytes: ev.jsUsedBytes,
      jsTotalBytes: ev.jsTotalBytes,
      cssUsedBytes: ev.cssUsedBytes,
      cssTotalBytes: ev.cssTotalBytes,
      files: [],
    }
  }

  let payload: CoveragePayload
  try {
    payload = JSON.parse(await blob.text()) as CoveragePayload
  } catch {
    return {
      jsUsedBytes: ev.jsUsedBytes,
      jsTotalBytes: ev.jsTotalBytes,
      cssUsedBytes: ev.cssUsedBytes,
      cssTotalBytes: ev.cssTotalBytes,
      files: [],
    }
  }

  const files: CoverageFile[] = []

  // JS — one row per script
  for (const script of payload.js ?? []) {
    const url = scriptUrlFromPayload(script.scriptId, payload.scripts)
    if (!url) continue
    const total = lengthFromPayload(script.scriptId, payload.scripts) ?? scriptMaxOffset(script)
    if (total === 0) continue
    let used = 0
    for (const fn of script.functions ?? []) {
      for (const r of fn.ranges ?? []) {
        if (r.count > 0) used += r.endOffset - r.startOffset
      }
    }
    // V8 ranges can overshoot the file length slightly; clamp.
    used = Math.min(used, total)
    files.push({ url, kind: 'js', totalBytes: total, usedBytes: used })
  }

  // CSS — group rules by stylesheet
  const cssByStyleSheet = new Map<string, { used: number; total: number }>()
  for (const r of payload.css ?? []) {
    const key = r.styleSheetId
    const entry = cssByStyleSheet.get(key) ?? { used: 0, total: 0 }
    const span = Math.max(0, r.endOffset - r.startOffset)
    entry.total += span
    if (r.used) entry.used += span
    cssByStyleSheet.set(key, entry)
  }
  for (const [id, agg] of cssByStyleSheet) {
    const sheet = payload.stylesheets?.find((s) => s.styleSheetId === id)
    const url = sheet?.sourceURL || ''
    if (!url) continue
    files.push({ url, kind: 'css', totalBytes: agg.total, usedBytes: Math.min(agg.used, agg.total) })
  }

  // Heaviest files first; cap to avoid blowing up the upload payload.
  files.sort((a, b) => b.totalBytes - a.totalBytes)
  const capped = files.slice(0, MAX_FILES)

  // Recompute totals from per-file so they match the file list exactly
  // (the CoverageEvent totals already match, but better safe).
  let jsUsed = 0, jsTotal = 0, cssUsed = 0, cssTotal = 0
  for (const f of files) {
    if (f.kind === 'js') { jsUsed += f.usedBytes; jsTotal += f.totalBytes }
    else { cssUsed += f.usedBytes; cssTotal += f.totalBytes }
  }
  return {
    jsUsedBytes: jsUsed,
    jsTotalBytes: jsTotal,
    cssUsedBytes: cssUsed,
    cssTotalBytes: cssTotal,
    files: capped,
  }
}

// ---- types matching the blob shape the CoverageTracker writes ---------------

interface CoveragePayload {
  js?: PreciseScript[]
  css?: CssRange[]
  scripts?: { scriptId: string; url: string; contentLength?: number }[]
  stylesheets?: { styleSheetId: string; sourceURL: string; length?: number }[]
}

interface PreciseScript {
  scriptId: string
  functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[]
}

interface CssRange {
  styleSheetId: string
  startOffset: number
  endOffset: number
  used: boolean
}

function scriptUrlFromPayload(scriptId: string, scripts?: { scriptId: string; url: string }[]): string {
  return scripts?.find((s) => s.scriptId === scriptId)?.url ?? ''
}

function lengthFromPayload(scriptId: string, scripts?: { scriptId: string; contentLength?: number }[]): number | undefined {
  return scripts?.find((s) => s.scriptId === scriptId)?.contentLength
}

function scriptMaxOffset(script: PreciseScript): number {
  let max = 0
  for (const fn of script.functions ?? []) {
    for (const r of fn.ranges ?? []) {
      if (r.endOffset > max) max = r.endOffset
    }
  }
  return max
}
