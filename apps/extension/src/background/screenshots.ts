import type { ScreenshotInline, VerifyScreenshotInline } from '@unwrap/protocol'
import type { ScreenshotEvent, SessionEvent } from '@/shared/events'
import { listBlobs } from '@/shared/storage'

export async function pickScreenshotsForLlm(
  sessionId: string,
  events: SessionEvent[],
  max = 2,
  maxLongEdge = 1024,
): Promise<ScreenshotInline[]> {
  const screenshotEvents = events.filter((e): e is ScreenshotEvent => e.type === 'screenshot')
  if (screenshotEvents.length === 0) return []

  const picks: ScreenshotEvent[] = []
  picks.push(screenshotEvents[0]!)
  if (max >= 2 && screenshotEvents.length > 1) picks.push(screenshotEvents[screenshotEvents.length - 1]!)
  if (max >= 3 && screenshotEvents.length > 2) picks.push(screenshotEvents[Math.floor(screenshotEvents.length / 2)]!)

  const blobs = await listBlobs(sessionId)
  const byRef = new Map(blobs.map((b) => [b.ref, b]))
  const out: ScreenshotInline[] = []

  for (const ev of picks) {
    const blob = byRef.get(ev.ref)
    if (!blob) continue
    const downsampled = await downsampleImage(blob.data, maxLongEdge)
    const finalBlob = downsampled ?? blob.data
    const dataBase64 = await blobToBase64(finalBlob)
    out.push({
      ts: ev.ts,
      reason: ev.reason,
      mediaType: finalBlob.type || 'image/png',
      dataBase64,
    })
  }
  return out
}

// Picks captured screenshots at their NATIVE viewport resolution (no
// downsampling) for server-side pixel-diff. Returns up to `max` shots
// — keeps the first + last and evenly samples in between so we don't
// blow the upload size on noisy sessions.
export async function pickScreenshotsForVerify(
  sessionId: string,
  events: SessionEvent[],
  max = 20,
): Promise<VerifyScreenshotInline[]> {
  const screenshotEvents = events.filter((e): e is ScreenshotEvent => e.type === 'screenshot')
  if (screenshotEvents.length === 0) return []

  const picked = pickEvenly(screenshotEvents, max)
  const urlByTs = buildUrlIndex(events)

  const blobs = await listBlobs(sessionId)
  const byRef = new Map(blobs.map((b) => [b.ref, b]))
  const out: VerifyScreenshotInline[] = []
  for (const ev of picked) {
    const blob = byRef.get(ev.ref)
    if (!blob) continue
    const dims = await readImageDimensions(blob.data)
    const dataBase64 = await blobToBase64(blob.data)
    out.push({
      originalRef: ev.ref,
      originalTs: ev.ts,
      url: nearestUrl(urlByTs, ev.ts),
      width: dims?.width ?? ev.viewport.width,
      height: dims?.height ?? ev.viewport.height,
      mediaType: blob.mimeType || 'image/png',
      dataBase64,
    })
  }
  return out
}

function pickEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  // Always include first
  out.push(items[0]!)
  // Evenly-spaced middle picks
  const innerCount = max - 2
  if (innerCount > 0) {
    for (let i = 1; i <= innerCount; i++) {
      const idx = Math.round((i * (items.length - 1)) / (innerCount + 1))
      const item = items[idx]
      if (item && item !== out[out.length - 1]) out.push(item)
    }
  }
  // Always include last
  const last = items[items.length - 1]!
  if (last !== out[out.length - 1]) out.push(last)
  return out
}

function buildUrlIndex(events: SessionEvent[]): { ts: number; url: string }[] {
  const out: { ts: number; url: string }[] = []
  for (const e of events) {
    if (e.type === 'navigation') out.push({ ts: e.ts, url: (e as { url: string }).url })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function nearestUrl(index: { ts: number; url: string }[], ts: number): string {
  let best = ''
  for (const entry of index) {
    if (entry.ts <= ts) best = entry.url
    else break
  }
  return best
}

async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const dims = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dims
  } catch {
    return null
  }
}

async function downsampleImage(source: Blob, maxLongEdge: number): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(source)
    const longEdge = Math.max(bitmap.width, bitmap.height)
    if (longEdge <= maxLongEdge) {
      bitmap.close()
      return null
    }
    const scale = maxLongEdge / longEdge
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/png' })
  } catch (e) {
    console.debug('[unwrap] downsampleImage failed', e)
    return null
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}
