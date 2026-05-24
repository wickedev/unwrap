import { zipSync, strToU8 } from 'fflate'
import type { ApiCall, StaticAsset, StoredSession } from '@unwrap/protocol'

// Packs every captured text asset into a zip preserving the URL's
// pathname under <host>/. Binary assets (image/font) the extension
// only sent URL-only become entries in MIRROR.md instead of files —
// they're not on disk so we point at the source URL.
//
// Two-pass build: first we resolve every asset to its in-zip path so
// the URL→path map is complete; then we walk HTML and CSS bodies and
// rewrite absolute / same-origin URLs to relative paths so the mirror
// works behind a plain `python -m http.server`.
export function buildStaticMirrorZip(session: StoredSession): { filename: string; bytes: Uint8Array } {
  const assets = session.summary.staticAssets ?? []

  // Pass 1 — assign a target path to every inlinable asset.
  const usedPaths = new Set<string>()
  const placed: { asset: StaticAsset; path: string }[] = []
  const urlOnly: { url: string; mime: string; size: number; status: number }[] = []
  for (const a of assets) {
    if (a.urlOnly || a.body === undefined) {
      urlOnly.push({ url: a.url, mime: a.mimeType, size: a.size, status: a.status })
      continue
    }
    placed.push({ asset: a, path: filePathFor(a, usedPaths) })
  }

  const urlToPath = new Map<string, string>()
  for (const { asset, path } of placed) urlToPath.set(asset.url, path)

  // Pass 2 — write bodies, rewriting HTML and CSS.
  const files: Record<string, Uint8Array> = {}
  const rewriteCounts: { html: number; css: number; touched: number } = { html: 0, css: 0, touched: 0 }
  for (const { asset, path } of placed) {
    let body = asset.body!
    if (asset.mimeType.startsWith('text/html')) {
      const before = body
      body = rewriteHtml(body, asset.url, path, urlToPath)
      if (body !== before) rewriteCounts.touched++
      rewriteCounts.html++
    } else if (asset.mimeType.startsWith('text/css')) {
      const before = body
      body = rewriteCss(body, asset.url, path, urlToPath)
      if (body !== before) rewriteCounts.touched++
      rewriteCounts.css++
    }
    files[path] = strToU8(body)
  }

  const inlined = placed.map(({ asset, path }) => ({
    url: asset.url,
    path,
    mime: asset.mimeType,
    size: asset.size,
  }))

  const pages = buildPageMap(session, urlToPath)
  const hasSitemap = pages.length > 0
  if (hasSitemap) {
    files['sitemap.html'] = strToU8(renderSitemap(session, pages))
  }
  files['MIRROR.md'] = strToU8(renderReadme(session, inlined, urlOnly, rewriteCounts, hasSitemap))

  const bytes = zipSync(files, { level: 6 })
  const filename = `mirror-${safeHost(session.summary.meta.host)}-${session.id.slice(0, 8)}.zip`
  return { filename, bytes }
}

// ---- URL rewriting ----------------------------------------------------------

// Rewrites href / src / srcset / poster / action / formaction attribute
// values in an HTML body so absolute URLs that point at a bundled asset
// become relative paths into the zip.
function rewriteHtml(
  html: string,
  sourceUrl: string,
  zipPath: string,
  urlToPath: Map<string, string>,
): string {
  const sourceOrigin = originOf(sourceUrl)
  const subst = (value: string): string => resolveAndRewrite(value, sourceOrigin, zipPath, urlToPath)

  let out = html.replace(
    /\b(href|src|poster|action|formaction|cite|data)\s*=\s*(["'])([^"']*)\2/gi,
    (_, attr: string, q: string, value: string) => `${attr}=${q}${subst(value)}${q}`,
  )
  out = out.replace(/\bsrcset\s*=\s*(["'])([^"']*)\1/gi, (_, q: string, value: string) => {
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim()
        if (!trimmed) return part
        const sp = trimmed.indexOf(' ')
        if (sp < 0) return subst(trimmed)
        return `${subst(trimmed.slice(0, sp))}${trimmed.slice(sp)}`
      })
      .join(', ')
    return `srcset=${q}${rewritten}${q}`
  })
  return out
}

// Rewrites url(...) and @import targets in a CSS body the same way.
function rewriteCss(
  css: string,
  sourceUrl: string,
  zipPath: string,
  urlToPath: Map<string, string>,
): string {
  const sourceOrigin = originOf(sourceUrl)
  const subst = (value: string): string => resolveAndRewrite(value, sourceOrigin, zipPath, urlToPath)

  return css
    .replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (_, q: string, value: string) =>
      `url(${q}${subst(value)}${q})`,
    )
    .replace(/@import\s+(['"])([^'"]+)\1/g, (_, q: string, value: string) =>
      `@import ${q}${subst(value)}${q}`,
    )
}

function resolveAndRewrite(
  value: string,
  sourceOrigin: string | null,
  zipPath: string,
  urlToPath: Map<string, string>,
): string {
  if (!value) return value
  if (/^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) return value
  let absUrl: string
  try {
    absUrl = new URL(value, sourceOrigin ?? 'http://_placeholder_/').toString()
  } catch {
    return value
  }
  // Strip query / hash for the lookup — the map keys are bare URLs.
  const baseUrl = stripQueryAndHash(absUrl)
  const target = urlToPath.get(absUrl) ?? urlToPath.get(baseUrl)
  if (!target) return value
  const suffix = absUrl.slice(baseUrl.length) // preserves #fragment etc.
  return computeRelativePath(zipPath, target) + suffix
}

function stripQueryAndHash(url: string): string {
  const q = url.indexOf('?')
  const h = url.indexOf('#')
  const cut = q >= 0 && (h < 0 || q < h) ? q : h
  return cut >= 0 ? url.slice(0, cut) : url
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}/`
  } catch {
    return null
  }
}

function computeRelativePath(fromPath: string, toPath: string): string {
  const fromSegs = fromPath.split('/').slice(0, -1) // directory of from
  const toSegs = toPath.split('/')
  let common = 0
  while (common < fromSegs.length && common < toSegs.length - 1 && fromSegs[common] === toSegs[common]) {
    common++
  }
  const up = fromSegs.length - common
  const parts: string[] = []
  for (let i = 0; i < up; i++) parts.push('..')
  for (let i = common; i < toSegs.length; i++) parts.push(toSegs[i]!)
  const joined = parts.join('/')
  return joined.length === 0 ? './' : joined
}

function filePathFor(a: StaticAsset, used: Set<string>): string {
  let host = ''
  let pathname = '/'
  let search = ''
  try {
    const u = new URL(a.url)
    host = u.host
    pathname = u.pathname || '/'
    search = u.search ? '__' + safeChunk(u.search) : ''
  } catch {
    host = 'unknown'
  }

  let segments = pathname.split('/').filter(Boolean).map(safeChunk)
  // For root URL or paths ending with slash, give index.html
  if (segments.length === 0 || pathname.endsWith('/')) {
    segments = [...segments, 'index.html']
  }

  // Ensure final segment has an extension. If not and the mime is HTML,
  // append .html so editors render it; for other mimes leave as-is.
  const last = segments[segments.length - 1]!
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last)) {
    const ext = mimeToExt(a.mimeType)
    if (ext) segments[segments.length - 1] = `${last}.${ext}`
  }

  if (search) {
    const last = segments[segments.length - 1]!
    const dot = last.lastIndexOf('.')
    segments[segments.length - 1] = dot > 0 ? last.slice(0, dot) + search + last.slice(dot) : last + search
  }

  let path = `${safeChunk(host)}/${segments.join('/')}`
  // Dedupe — same URL hit twice already collapsed in extension, but
  // different search strings or normalized segments could still clash.
  let counter = 1
  let attempt = path
  while (used.has(attempt)) {
    const dot = path.lastIndexOf('.')
    attempt = dot > 0 ? `${path.slice(0, dot)}.${counter}${path.slice(dot)}` : `${path}.${counter}`
    counter++
  }
  used.add(attempt)
  return attempt
}

function safeChunk(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || '_'
}

function mimeToExt(mime: string): string | null {
  if (!mime) return null
  if (mime.startsWith('text/html')) return 'html'
  if (mime.startsWith('text/css')) return 'css'
  if (mime.includes('javascript')) return 'js'
  if (mime.includes('json')) return 'json'
  if (mime.includes('xml')) return 'xml'
  if (mime.includes('svg')) return 'svg'
  return null
}

function safeHost(host: string): string {
  return (host || 'session').replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
}

function renderReadme(
  session: StoredSession,
  inlined: { url: string; path: string; mime: string; size: number }[],
  urlOnly: { url: string; mime: string; size: number; status: number }[],
  rewriteCounts: { html: number; css: number; touched: number },
  hasSitemap: boolean,
): string {
  const meta = session.summary.meta
  const lines: string[] = []
  lines.push(`# Static mirror — ${meta.host || 'unknown host'}`)
  lines.push('')
  lines.push(`Generated by Unwrap from session \`${session.id}\``)
  lines.push(`Captured at ${meta.startedAt} · viewport ${meta.viewport.width}×${meta.viewport.height}`)
  lines.push('')
  lines.push("## What's here")
  lines.push('')
  lines.push(`- **${inlined.length}** text asset${inlined.length === 1 ? '' : 's'} (HTML / CSS / JS / SVG) inlined as files.`)
  lines.push(`- **${urlOnly.length}** binary reference${urlOnly.length === 1 ? '' : 's'} (image / font) listed below but not bundled — see the URLs to refetch from origin.`)
  lines.push(`- URLs in **${rewriteCounts.html}** HTML and **${rewriteCounts.css}** CSS file${rewriteCounts.html + rewriteCounts.css === 1 ? '' : 's'} scanned; **${rewriteCounts.touched}** had absolute URLs rewritten to relative paths so the mirror works offline.`)
  if (hasSitemap) {
    lines.push(`- **sitemap.html** at the root of the zip — every page navigated to during the capture, with the API calls each page fired and links to its local HTML when bundled. Open this first.`)
  }
  lines.push('')
  lines.push('## How to use')
  lines.push('')
  lines.push('```sh')
  lines.push('unzip mirror-*.zip -d mirror && cd mirror')
  lines.push(`python -m http.server 8080            # serve over http://localhost:8080`)
  lines.push('```')
  if (hasSitemap) {
    lines.push('')
    lines.push('Then open <http://localhost:8080/sitemap.html> for the page index.')
  }
  lines.push('')
  lines.push('Absolute and same-origin URLs that point at bundled assets have been rewritten')
  lines.push('to relative paths, so HTML/CSS load their JS/CSS/SVG dependencies from the zip.')
  lines.push('Cross-origin URLs and URLs pointing at assets we did not capture are left as-is —')
  lines.push('those will still hit the original host. To pair with the captured backend, also')
  lines.push('download the mock server from the API inventory page and point your frontend at it.')
  lines.push('')
  lines.push('## Text assets bundled')
  lines.push('')
  if (inlined.length === 0) {
    lines.push('_(none)_')
  } else {
    lines.push('| Path | Source URL | Mime | Captured size |')
    lines.push('|---|---|---|---|')
    for (const a of inlined) {
      lines.push(`| \`${escapeMd(a.path)}\` | \`${escapeMd(a.url)}\` | ${escapeMd(a.mime)} | ${formatBytes(a.size)} |`)
    }
  }
  lines.push('')
  lines.push('## Binary references (URL only)')
  lines.push('')
  if (urlOnly.length === 0) {
    lines.push('_(none)_')
  } else {
    lines.push('| Source URL | Mime | Captured size | Status |')
    lines.push('|---|---|---|---|')
    for (const a of urlOnly) {
      lines.push(`| \`${escapeMd(a.url)}\` | ${escapeMd(a.mime)} | ${formatBytes(a.size)} | ${a.status} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/`/g, '\\`')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

// ---- Sitemap ----------------------------------------------------------------

interface PageEntry {
  url: string
  host: string
  path: string
  source: string
  ts: number
  // Local mirror file we have for this page, if any.
  localPath?: string
  // API calls fired between this navigation and the next.
  apiCalls: { method: string; url: string; normalizedPath: string; status: number; mimeType: string }[]
}

// Pairs every committed-or-history navigation in the session with the API
// calls fired between it and the next navigation, plus a link to the local
// HTML file in the zip when we captured one. The result is a flat,
// chronologically-ordered list — buildSitemap groups it for display.
function buildPageMap(session: StoredSession, urlToPath: Map<string, string>): PageEntry[] {
  const navs = session.summary.navigations ?? []
  const calls = session.summary.apiCalls ?? []
  if (navs.length === 0) return []

  // Sort calls by ts so the bucketing per navigation window is deterministic.
  const sortedCalls = calls.filter((c) => typeof c.ts === 'number').sort((a, b) => a.ts - b.ts)

  // Sort navs by ts too, just in case.
  const sortedNavs = [...navs].sort((a, b) => a.ts - b.ts)

  const entries: PageEntry[] = []
  for (let i = 0; i < sortedNavs.length; i++) {
    const nav = sortedNavs[i]!
    const nextNav = sortedNavs[i + 1]
    const windowEnd = nextNav ? nextNav.ts : Number.POSITIVE_INFINITY
    let host = ''
    let pathname = '/'
    try {
      const u = new URL(nav.url)
      host = u.host
      pathname = u.pathname + u.search
    } catch {
      // leave as defaults
    }
    const local = urlToPath.get(nav.url) ?? urlToPath.get(stripQueryAndHash(nav.url))

    const apiCalls: PageEntry['apiCalls'] = []
    for (const c of sortedCalls) {
      if (c.ts < nav.ts || c.ts >= windowEnd) continue
      apiCalls.push(summarizeCall(c))
    }

    entries.push({
      url: nav.url,
      host,
      path: pathname,
      source: nav.source,
      ts: nav.ts,
      ...(local ? { localPath: local } : {}),
      apiCalls,
    })
  }
  return entries
}

function summarizeCall(c: ApiCall): PageEntry['apiCalls'][number] {
  let normalizedPath = c.url
  try {
    const u = new URL(c.url)
    normalizedPath = normalizePathForSitemap(u.pathname)
  } catch {
    // keep raw url
  }
  return {
    method: c.method.toUpperCase(),
    url: c.url,
    normalizedPath,
    status: c.status,
    mimeType: c.responseMimeType,
  }
}

// Same shape as api-inventory's normalizePath — kept local so this file
// stays self-contained and the mirror can be generated without pulling
// page rendering into the dependency graph.
function normalizePathForSitemap(p: string): string {
  return (
    '/' +
    p
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
}

function renderSitemap(session: StoredSession, pages: PageEntry[]): string {
  const meta = session.summary.meta
  // Group by URL so duplicate visits collapse into one row with a count.
  const byUrl = new Map<string, PageEntry[]>()
  for (const p of pages) {
    const list = byUrl.get(p.url) ?? []
    list.push(p)
    byUrl.set(p.url, list)
  }

  // Stable sort: first visit ts asc.
  const rows = [...byUrl.entries()]
    .map(([url, visits]) => ({ url, visits }))
    .sort((a, b) => a.visits[0]!.ts - b.visits[0]!.ts)

  const items = rows
    .map(({ url, visits }) => renderPageRow(url, visits))
    .join('\n')

  const totalCalls = pages.reduce((n, p) => n + p.apiCalls.length, 0)
  const capturedHtml = pages.filter((p) => p.localPath).length

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Sitemap — ${escapeHtml(meta.host || 'session')}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 980px; margin: 0 auto; padding: 24px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 20px; }
  .kpis { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0 20px; }
  .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; min-width: 120px; }
  .kpi .v { font-size: 18px; font-weight: 600; }
  .kpi .l { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .page { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .page-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
  .visits { color: #6b7280; font-size: 11px; }
  .local { display: inline-block; padding: 1px 8px; background: #ecfdf5; color: #065f46; border-radius: 4px; font-size: 11px; text-decoration: none; }
  .local:hover { background: #d1fae5; }
  .no-local { display: inline-block; padding: 1px 8px; background: #f3f4f6; color: #6b7280; border-radius: 4px; font-size: 11px; }
  details summary { cursor: pointer; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 8px; user-select: none; }
  ul.calls { list-style: none; padding: 0; margin: 8px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  ul.calls li { padding: 2px 0; }
  .method { display: inline-block; padding: 0 5px; border-radius: 3px; font-weight: 700; font-size: 10px; color: white; margin-right: 6px; min-width: 36px; text-align: center; }
  .m-get { background: #2f6feb; }
  .m-post { background: #1f9d55; }
  .m-put, .m-patch { background: #b88300; }
  .m-delete { background: #d64545; }
  .m-other { background: #6b7280; }
  .status { color: #6b7280; margin-left: 6px; }
</style>
</head><body>
<h1>${escapeHtml(meta.host || 'Session')}</h1>
<div class="sub">Captured ${escapeHtml(meta.startedAt)} · ${rows.length} unique page${rows.length === 1 ? '' : 's'} · ${pages.length} navigation${pages.length === 1 ? '' : 's'}</div>
<div class="kpis">
  <div class="kpi"><div class="v">${rows.length}</div><div class="l">Unique pages</div></div>
  <div class="kpi"><div class="v">${capturedHtml}</div><div class="l">With local HTML</div></div>
  <div class="kpi"><div class="v">${totalCalls}</div><div class="l">API calls fired</div></div>
</div>
${items}
</body></html>
`
}

function renderPageRow(url: string, visits: PageEntry[]): string {
  const first = visits[0]!
  const local = first.localPath
  const callCounts = new Map<string, number>()
  for (const v of visits) {
    for (const c of v.apiCalls) {
      const key = `${c.method} ${c.normalizedPath}`
      callCounts.set(key, (callCounts.get(key) ?? 0) + 1)
    }
  }
  // Dedupe but keep the original method/path for color and status sample.
  const sample = new Map<string, PageEntry['apiCalls'][number]>()
  for (const v of visits) for (const c of v.apiCalls) {
    const key = `${c.method} ${c.normalizedPath}`
    if (!sample.has(key)) sample.set(key, c)
  }
  const callItems = [...callCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => {
      const c = sample.get(key)!
      const cls = methodClass(c.method)
      return `<li><span class="method ${cls}">${escapeHtml(c.method)}</span><span>${escapeHtml(c.normalizedPath)}</span><span class="status">${c.status}${count > 1 ? ` · ×${count}` : ''}</span></li>`
    })
    .join('')

  const totalCalls = [...callCounts.values()].reduce((a, b) => a + b, 0)

  return `<div class="page">
  <div class="page-head">
    <span class="url">${escapeHtml(url)}</span>
    ${visits.length > 1 ? `<span class="visits">×${visits.length}</span>` : ''}
    ${local
      ? `<a class="local" href="${escapeHtml(local)}">↗ open local</a>`
      : `<span class="no-local">no HTML captured</span>`}
  </div>
  ${callItems
      ? `<details><summary>${totalCalls} API call${totalCalls === 1 ? '' : 's'} fired</summary><ul class="calls">${callItems}</ul></details>`
      : `<div class="visits" style="margin-top: 6px;">No API calls captured for this page.</div>`}
</div>`
}

function methodClass(method: string): string {
  const m = method.toLowerCase()
  if (m === 'get') return 'm-get'
  if (m === 'post') return 'm-post'
  if (m === 'put' || m === 'patch') return 'm-put'
  if (m === 'delete') return 'm-delete'
  return 'm-other'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
