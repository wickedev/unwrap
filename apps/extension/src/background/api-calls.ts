import type { ApiCall } from '@unwrap/protocol'
import type { RequestEvent, ResponseEvent, SessionEvent } from '@/shared/events'
import { getBlob } from '@/shared/storage'

// Per-call body cap. Keep small enough to fit many calls per session;
// schemas are inferable from a few hundred bytes for most APIs.
const MAX_BODY_BYTES = 50_000
// Hard cap on total body bytes per session so we don't blow KV upload.
const MAX_TOTAL_BYTES = 5_000_000
// Hard cap on number of distinct calls (most heavy sessions have <100).
const MAX_CALLS = 200

// Walks the captured request/response events, picks the API-shaped ones,
// pulls their response bodies out of the per-session blob store, and
// hands back a list ready to ship with the upload payload.
export async function collectApiCalls(
  _sessionId: string,
  events: SessionEvent[],
): Promise<ApiCall[]> {
  // The recorder emits TWO response events per request: one with the
  // headers/status (no body) and a second one carrying the bodyRef
  // pointer. Walk both, keyed by requestId.
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

  const out: ApiCall[] = []
  let totalBytes = 0

  for (const [reqId, req] of requests) {
    if (out.length >= MAX_CALLS) break
    const resp = responseMeta.get(reqId)
    if (!isApiLike(req, resp)) continue

    const bodyEntry = responseBodyRefs.get(reqId)
    let responseBody: string | undefined
    if (bodyEntry && isTextualMime(resp?.mimeType)) {
      const blob = await getBlob(bodyEntry.ref)
      if (blob) {
        const text = await readBlobAsText(blob)
        const truncated = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text
        if (totalBytes + truncated.length <= MAX_TOTAL_BYTES) {
          responseBody = truncated
          totalBytes += truncated.length
        }
      }
    }

    const requestBody = req.postData
      ? req.postData.slice(0, MAX_BODY_BYTES)
      : undefined

    const call: ApiCall = {
      ts: req.ts,
      method: req.method,
      url: req.url,
      requestHeaders: req.headers,
      status: resp?.status ?? 0,
      responseMimeType: resp?.mimeType ?? '',
      responseHeaders: resp?.headers,
    }
    if (requestBody) call.requestBody = requestBody
    if (responseBody) call.responseBody = responseBody
    if (bodyEntry?.size != null) call.responseSize = bodyEntry.size

    const gql = detectGraphql(req)
    if (gql) call.graphql = gql

    out.push(call)
  }

  out.sort((a, b) => a.ts - b.ts)
  return out
}

function isApiLike(req: RequestEvent, resp?: ResponseEvent): boolean {
  if (req.url.startsWith('chrome://') || req.url.startsWith('chrome-extension://')) return false
  if (resp?.mimeType && isTextualMime(resp.mimeType)) {
    if (resp.mimeType.includes('json') || resp.mimeType.includes('graphql')) return true
    if (resp.mimeType.includes('xml')) return true
    if (resp.mimeType.includes('event-stream')) return true
  }
  if (/\/api\/|\/graphql|\/rpc|\/rest\//i.test(req.url)) return true
  // POST/PUT/PATCH/DELETE on any URL is usually an API call even if
  // the response shape is something else (CSRF tokens etc).
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) return true
  return false
}

function isTextualMime(mime?: string): boolean {
  if (!mime) return false
  return (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    mime.includes('xml') ||
    mime.includes('graphql') ||
    mime.includes('event-stream') ||
    mime.includes('x-www-form-urlencoded')
  )
}

async function readBlobAsText(blob: Blob): Promise<string> {
  try {
    return await blob.text()
  } catch {
    return ''
  }
}

function detectGraphql(req: RequestEvent): ApiCall['graphql'] | null {
  if (!/\/graphql(?:\?|$|\/)/i.test(req.url) && req.method.toUpperCase() !== 'POST') return null
  if (!req.postData) return null
  try {
    const body = JSON.parse(req.postData)
    const query: string | undefined =
      typeof body?.query === 'string' ? body.query : Array.isArray(body) ? body[0]?.query : undefined
    if (!query) return null
    const operationName: string | undefined =
      typeof body?.operationName === 'string' ? body.operationName : Array.isArray(body) ? body[0]?.operationName : undefined
    const opMatch = query.match(/^\s*(query|mutation|subscription)\b/i)
    const opType = (opMatch?.[1]?.toLowerCase() as 'query' | 'mutation' | 'subscription' | undefined) ?? 'query'
    return {
      operationType: opType,
      operationName,
      queryHash: simpleHash(query),
    }
  } catch {
    return null
  }
}

function simpleHash(s: string): string {
  // Lightweight FNV-1a 32-bit so we can dedupe queries without lugging
  // crypto.subtle through every call.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
