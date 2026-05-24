import { zipSync, strToU8 } from 'fflate'
import type { StaticAsset, StoredSession } from '@unwrap/protocol'

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
  files['MIRROR.md'] = strToU8(renderReadme(session, inlined, urlOnly, rewriteCounts))

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
  lines.push('')
  lines.push('## How to use')
  lines.push('')
  lines.push('```sh')
  lines.push('unzip mirror-*.zip -d mirror && cd mirror')
  lines.push(`python -m http.server 8080            # serve over http://localhost:8080`)
  lines.push('```')
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
