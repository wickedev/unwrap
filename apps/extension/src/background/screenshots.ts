import type { ScreenshotInline } from '@unwrap/protocol'
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
