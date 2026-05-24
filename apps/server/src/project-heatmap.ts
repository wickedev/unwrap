import type { StoredSession, VerifyScreenshotMeta } from '@unwrap/protocol'

export interface PageHeatmap {
  // Normalized URL template (path only) — e.g. "/t/{id}/settings".
  normalizedPath: string
  // First raw URL seen for this template — used for display only.
  exampleUrl: string
  // Best screenshot we found for this page (most recent that took place
  // while the user was navigated to a matching URL).
  screenshot?: {
    sessionId: string
    storedRef: string
    width: number
    height: number
  }
  // Every click action with a position field, normalized to 0..1 of the
  // viewport so they overlay onto any screenshot regardless of size.
  clicks: { x: number; y: number; sessionId: string }[]
  // For info: number of sessions that contributed to this page.
  sessionCount: number
}

// Walks every session for a host, buckets clicks by the normalized URL
// they happened on, picks a representative screenshot per page, and
// normalizes click coordinates so the heatmap renderer can scale them
// to any screenshot dimensions. Only click actions that have a captured
// position field contribute — older sessions are silently ignored.
export function buildProjectHeatmaps(sessions: StoredSession[]): PageHeatmap[] {
  const pages = new Map<string, PageHeatmap>()

  // First pass — collect clicks per normalized URL.
  for (const s of sessions) {
    const actions = s.summary.actions ?? []
    for (const a of actions) {
      if (a.type !== 'click') continue
      const pos = a.position
      if (!pos || !pos.viewport || !pos.viewport.w || !pos.viewport.h) continue
      const normalizedPath = normalizeUrl(a.url)
      if (!normalizedPath) continue
      let p = pages.get(normalizedPath)
      if (!p) {
        p = {
          normalizedPath,
          exampleUrl: a.url,
          clicks: [],
          sessionCount: 0,
        }
        pages.set(normalizedPath, p)
      }
      p.clicks.push({
        x: clamp(pos.x / pos.viewport.w, 0, 1),
        y: clamp(pos.y / pos.viewport.h, 0, 1),
        sessionId: s.id,
      })
    }
  }

  if (pages.size === 0) return []

  // Second pass — for each page, find the best screenshot.
  for (const s of sessions) {
    const meta = s.verifyScreenshotMeta ?? []
    if (meta.length === 0) continue
    for (const m of meta) {
      const normalizedPath = normalizeUrl(m.url)
      if (!normalizedPath) continue
      const page = pages.get(normalizedPath)
      if (!page) continue
      if (!page.screenshot) {
        page.screenshot = pickScreenshot(s.id, m)
      } else {
        // Prefer a wider screenshot if we find one — usually means the user
        // captured at a larger viewport, which gives the heatmap more detail.
        if (m.width > page.screenshot.width) {
          page.screenshot = pickScreenshot(s.id, m)
        }
      }
    }
  }

  // Session count per page
  for (const p of pages.values()) {
    p.sessionCount = new Set(p.clicks.map((c) => c.sessionId)).size
  }

  return [...pages.values()].sort((a, b) => b.clicks.length - a.clicks.length)
}

function pickScreenshot(sessionId: string, m: VerifyScreenshotMeta): PageHeatmap['screenshot'] {
  return { sessionId, storedRef: m.storedRef, width: m.width, height: m.height }
}

function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return (
      '/' +
      u.pathname
        .split('/')
        .filter(Boolean)
        .map((seg) => {
          if (/^\d+$/.test(seg)) return '{id}'
          if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
          if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
          return seg
        })
        .join('/')
    )
  } catch {
    return null
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

// Renders a single page's heatmap as an SVG fragment. Caller is expected
// to wrap it with whatever framing/heading they want. screenshotUrl is
// served by /api/sessions/:id/screenshots/:ref.
export function renderHeatmapSvg(page: PageHeatmap, screenshotUrl?: string): string {
  // SVG aspect ratio: prefer screenshot's own ratio; fall back to 16:9
  // for pages we don't have a screenshot for so the dots still place
  // proportionally on an empty canvas.
  const w = page.screenshot?.width ?? 1600
  const h = page.screenshot?.height ?? 900
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMin meet" style="display: block; max-height: 70vh;">`)
  out.push('<defs>')
  out.push('<radialGradient id="heat-dot" cx="50%" cy="50%" r="50%">')
  out.push('<stop offset="0%" stop-color="#d64545" stop-opacity="0.85"/>')
  out.push('<stop offset="40%" stop-color="#d64545" stop-opacity="0.45"/>')
  out.push('<stop offset="100%" stop-color="#d64545" stop-opacity="0"/>')
  out.push('</radialGradient>')
  out.push('</defs>')

  if (screenshotUrl) {
    out.push(`<image href="${esc(screenshotUrl)}" x="0" y="0" width="${w}" height="${h}" opacity="0.55"/>`)
  } else {
    out.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="rgba(127,127,127,0.06)"/>`)
    out.push(`<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${Math.min(40, w / 25)}" fill="currentColor" opacity="0.4">(no screenshot captured for this page)</text>`)
  }

  // Dot radius scales with the screenshot size so spots don't look like
  // pinpricks on huge captures or dinner plates on tiny ones.
  const dotR = Math.max(24, Math.min(w, h) * 0.04)
  for (const c of page.clicks) {
    out.push(`<circle cx="${(c.x * w).toFixed(1)}" cy="${(c.y * h).toFixed(1)}" r="${dotR.toFixed(1)}" fill="url(#heat-dot)"/>`)
  }

  out.push(`</svg>`)
  return out.join('')
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
