import type { RequestEvent, ResponseEvent, SessionEvent, SessionMeta } from '@/shared/events'
import { getBlob, getSession, listBlobs, listEvents } from '@/shared/storage'

export interface ExportResult {
  filename: string
  downloadId: number
}

export async function exportSessionAsJson(sessionId: string): Promise<ExportResult> {
  const meta = await getSession(sessionId)
  if (!meta) throw new Error('session not found')
  const events = await listEvents(sessionId)
  const blobs = await listBlobs(sessionId)
  const blobIndex: Record<string, { mimeType: string; size: number }> = {}
  for (const b of blobs) blobIndex[b.ref] = { mimeType: b.mimeType, size: b.data.size }

  const payload = {
    meta,
    events,
    blobIndex,
  }
  const json = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  return download(json, `${safeName(meta)}.json`)
}

export async function exportSessionAsHar(sessionId: string): Promise<ExportResult> {
  const meta = await getSession(sessionId)
  if (!meta) throw new Error('session not found')
  const events = await listEvents(sessionId)
  const har = await buildHar(meta, events)
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' })
  return download(blob, `${safeName(meta)}.har`)
}

function safeName(meta: SessionMeta): string {
  const dt = new Date(meta.startedAt).toISOString().replace(/[:.]/g, '-')
  let host = 'session'
  try {
    host = new URL(meta.startUrl).host || 'session'
  } catch {
    // ignore
  }
  return `unwrap-${host}-${dt}`
}

async function download(blob: Blob, filename: string): Promise<ExportResult> {
  const url = await blobToDataUrl(blob)
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: true })
  return { filename, downloadId }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

interface HarEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    headers: { name: string; value: string }[]
    queryString: { name: string; value: string }[]
    cookies: never[]
    headersSize: number
    bodySize: number
    postData?: { mimeType: string; text: string }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: { name: string; value: string }[]
    cookies: never[]
    content: { size: number; mimeType: string; text?: string; encoding?: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
  _fromServiceWorker?: boolean
}

async function buildHar(meta: SessionMeta, events: SessionEvent[]): Promise<unknown> {
  const requests = new Map<string, RequestEvent>()
  const responsesMeta = new Map<string, ResponseEvent>()
  const responsesBody = new Map<string, ResponseEvent>()

  for (const ev of events) {
    if (ev.type === 'request') requests.set(ev.requestId, ev)
    else if (ev.type === 'response') {
      if (ev.bodyRef) responsesBody.set(ev.requestId, ev)
      else responsesMeta.set(ev.requestId, ev)
    }
  }

  const entries: HarEntry[] = []
  for (const [reqId, req] of requests) {
    const resp = responsesMeta.get(reqId)
    const body = responsesBody.get(reqId)
    const entry = await toEntry(req, resp, body)
    entries.push(entry)
  }

  return {
    log: {
      version: '1.2',
      creator: { name: 'Unwrap', version: '0.1.0' },
      browser: { name: 'Chrome', version: '' },
      pages: [
        {
          startedDateTime: new Date(meta.startedAt).toISOString(),
          id: meta.id,
          title: meta.startUrl,
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries,
    },
  }
}

async function toEntry(
  req: RequestEvent,
  resp: ResponseEvent | undefined,
  body: ResponseEvent | undefined,
): Promise<HarEntry> {
  const startedDateTime = new Date(req.ts).toISOString()
  const time = resp ? Math.max(0, resp.ts - req.ts) : 0

  let bodyText: string | undefined
  let encoding: string | undefined
  if (body?.bodyRef) {
    const blob = await getBlob(body.bodyRef)
    if (blob) {
      const buf = await blob.arrayBuffer()
      const looksTextual = (resp?.mimeType ?? '').match(/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/)
      if (looksTextual) {
        bodyText = new TextDecoder().decode(buf)
      } else {
        bodyText = arrayBufferToBase64(buf)
        encoding = 'base64'
      }
    }
  }

  const query: { name: string; value: string }[] = []
  try {
    const url = new URL(req.url)
    url.searchParams.forEach((v, k) => query.push({ name: k, value: v }))
  } catch {
    // ignore
  }

  return {
    startedDateTime,
    time,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: 'HTTP/1.1',
      headers: toHarHeaders(req.headers),
      queryString: query,
      cookies: [],
      headersSize: -1,
      bodySize: req.postData?.length ?? 0,
      ...(req.postData
        ? { postData: { mimeType: req.headers['content-type'] ?? '', text: req.postData } }
        : {}),
    },
    response: {
      status: resp?.status ?? 0,
      statusText: resp?.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      headers: toHarHeaders(resp?.headers ?? {}),
      cookies: [],
      content: {
        size: body?.bodySize ?? 0,
        mimeType: resp?.mimeType ?? '',
        ...(bodyText !== undefined ? { text: bodyText } : {}),
        ...(encoding ? { encoding } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: body?.bodySize ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    _fromServiceWorker: resp?.fromServiceWorker,
  }
}

function toHarHeaders(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}
