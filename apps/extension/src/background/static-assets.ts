import type { StaticAsset } from '@unwrap/protocol'
import type { RequestEvent, ResponseEvent, SessionEvent } from '@/shared/events'
import { getBlob } from '@/shared/storage'

// Per-asset cap. HTML/CSS/JS files can be large but the goal is
// readability + structure inspection, not byte-perfect mirroring.
const MAX_BODY_BYTES = 200_000
// Hard cap on the total bytes shipped per session so KV upload stays
// well under the 25MB per-value ceiling.
const MAX_TOTAL_BYTES = 12_000_000
// Hard cap on number of distinct asset URLs.
const MAX_ASSETS = 400

// Walks the captured request/response events, picks the static-asset
// shaped ones (HTML / CSS / JS / images / fonts), pulls their text
// bodies out of the per-session blob store, and returns a list ready
// to ship in the upload. Binary assets (images, fonts, video) become
// URL-only references — useful for showing what existed without
// bloating the payload.
export async function collectStaticAssets(events: SessionEvent[]): Promise<StaticAsset[]> {
  // Mirror collectApiCalls' pairing logic: each request has a meta
  // response (headers/status) plus a separate body event.
  const requests = new Map<string, RequestEvent>()
  const responseMeta = new Map<string, ResponseEvent>()
  const responseBodyRefs = new Map<string, { ref: string; size?: number }>()

  for (const ev of events) {
    if (ev.type === 'request') {
      requests.set(ev.requestId, ev)
    } else if (ev.type === 'response') {
      if (ev.bodyRef) responseBodyRefs.set(ev.requestId, { ref: ev.bodyRef, size: ev.bodySize })
      else if (ev.status > 0) responseMeta.set(ev.requestId, ev)
    }
  }

  // Dedupe by URL — same asset hit twice keeps the most recent.
  const byUrl = new Map<string, { req: RequestEvent; resp?: ResponseEvent; bodyRef?: string; size?: number }>()
  for (const [reqId, req] of requests) {
    if (req.method.toUpperCase() !== 'GET') continue
    if (!isAssetUrl(req.url)) continue
    const resp = responseMeta.get(reqId)
    const body = responseBodyRefs.get(reqId)
    const mime = resp?.mimeType ?? guessMime(req.url)
    if (!isStaticAssetMime(mime)) continue
    byUrl.set(req.url, { req, resp, bodyRef: body?.ref, size: body?.size })
  }

  const out: StaticAsset[] = []
  let totalBytes = 0

  for (const [url, entry] of byUrl) {
    if (out.length >= MAX_ASSETS) break
    const mime = entry.resp?.mimeType ?? guessMime(url)
    const status = entry.resp?.status ?? 200
    const size = entry.size ?? 0

    if (isTextual(mime)) {
      let body: string | undefined
      if (entry.bodyRef) {
        const blob = await getBlob(entry.bodyRef)
        if (blob) {
          const text = await readBlobAsText(blob)
          const truncated = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text
          if (totalBytes + truncated.length <= MAX_TOTAL_BYTES) {
            body = truncated
            totalBytes += truncated.length
          }
        }
      }
      const asset: StaticAsset = { url, status, mimeType: mime, size }
      if (body !== undefined) asset.body = body
      out.push(asset)
    } else {
      // Binary — just record that the URL existed at that size/mime.
      out.push({ url, status, mimeType: mime, size, urlOnly: true })
    }
  }

  out.sort((a, b) => a.url.localeCompare(b.url))
  return out
}

function isAssetUrl(url: string): boolean {
  if (!url) return false
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return false
  if (url.startsWith('data:') || url.startsWith('blob:')) return false
  return true
}

function isStaticAssetMime(mime: string): boolean {
  if (!mime) return false
  if (mime.startsWith('text/html')) return true
  if (mime.startsWith('text/css')) return true
  if (mime.startsWith('application/javascript') || mime.startsWith('text/javascript')) return true
  if (mime.startsWith('application/x-javascript')) return true
  if (mime.startsWith('image/')) return true
  if (mime.startsWith('font/') || mime.includes('font-woff') || mime === 'application/vnd.ms-fontobject') return true
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return false // skip media
  if (mime.startsWith('text/plain') || mime.startsWith('text/markdown')) return true
  if (mime.includes('svg')) return true
  if (mime.includes('xml') && !mime.includes('xhtml')) return true
  return false
}

function isTextual(mime: string): boolean {
  if (!mime) return false
  if (mime.startsWith('image/svg')) return true
  if (mime.startsWith('image/')) return false
  if (mime.startsWith('font/') || mime.includes('font-woff') || mime === 'application/vnd.ms-fontobject') return false
  return (
    mime.startsWith('text/') ||
    mime.includes('javascript') ||
    mime.includes('json') ||
    mime.includes('xml')
  )
}

function guessMime(url: string): string {
  const ext = (url.split('?')[0] || '').split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    json: 'application/json',
    xml: 'application/xml',
  }
  return map[ext] ?? ''
}

async function readBlobAsText(blob: Blob): Promise<string> {
  try {
    return await blob.text()
  } catch {
    return ''
  }
}
