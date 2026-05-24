import type { WsChannel, WsMessageType } from '@unwrap/protocol'
import type { SessionEvent } from '@/shared/events'

// Hard caps so a chatty channel (heartbeat every second) can't bloat the
// upload — we only keep enough samples per message type to infer a shape,
// and cap the number of distinct types.
const SAMPLE_PAYLOAD_BYTES = 2000
const MAX_TYPES_PER_CHANNEL = 30
const MAX_CHANNELS = 30

// Walks the per-session event stream, groups ws_created/ws_frame/ws_closed
// by requestId into channels, and within each channel groups frames into
// distinct message types using a JSON discriminator field heuristic. The
// resulting WsChannel[] ships with the session upload so the server can
// render a WebSocket inventory next to the REST/GraphQL one.
export function collectWsChannels(events: SessionEvent[]): WsChannel[] {
  // Build by requestId — that's the CDP stream identifier the recorder
  // threads through ws_created → ws_frame → ws_closed.
  const channels = new Map<string, WsChannel>()

  for (const ev of events) {
    if (ev.type === 'ws_created') {
      const ch: WsChannel = {
        url: ev.url,
        openedAt: ev.ts,
        sendCount: 0,
        recvCount: 0,
        sendBytes: 0,
        recvBytes: 0,
        messageTypes: [],
      }
      channels.set(ev.requestId, ch)
    } else if (ev.type === 'ws_closed') {
      const ch = channels.get(ev.requestId)
      if (ch) ch.closedAt = ev.ts
    }
  }

  // Second pass to bucket frames — keeps the "channel headers first" model.
  // typesAcc keyed by `${requestId}|${typeKey}` → MutableType
  const typesAcc = new Map<string, MutableType>()
  for (const ev of events) {
    if (ev.type !== 'ws_frame') continue
    const ch = channels.get(ev.requestId)
    if (!ch) continue
    // Only text-ish payloads are worth keeping — binary frames (opcode 2)
    // would be base64 noise. opcode 1 = text, 8 = close, 9/10 = ping/pong.
    const isText = ev.opcode === 1
    if (ev.direction === 'send') { ch.sendCount++; ch.sendBytes += ev.payloadSize }
    else { ch.recvCount++; ch.recvBytes += ev.payloadSize }

    if (!isText) continue
    const key = discriminate(ev.payloadData)
    const acc = typesAcc.get(`${ev.requestId}|${key}`) ?? createType(key)
    acc.count++
    acc.bytes += ev.payloadSize
    if (ev.direction === 'send') acc.sendSeen = true
    else acc.recvSeen = true
    if (acc.samples.length < 10) acc.samples.push(ev.payloadData)
    if (!acc.firstSample) acc.firstSample = ev.payloadData.slice(0, SAMPLE_PAYLOAD_BYTES)
    typesAcc.set(`${ev.requestId}|${key}`, acc)
  }

  // Assemble per-channel message-type arrays.
  for (const [k, t] of typesAcc) {
    const reqId = k.slice(0, k.indexOf('|'))
    const ch = channels.get(reqId)
    if (!ch) continue
    const direction: WsMessageType['direction'] =
      t.sendSeen && t.recvSeen ? 'both' : t.sendSeen ? 'send' : 'recv'
    const msgType: WsMessageType = {
      key: t.key,
      direction,
      count: t.count,
      bytes: t.bytes,
      ...(t.firstSample !== undefined ? { sample: t.firstSample } : {}),
      ...(t.samples.length > 0 ? { inferredShape: inferShapeQuick(t.samples) } : {}),
    }
    ch.messageTypes.push(msgType)
  }

  for (const ch of channels.values()) {
    ch.messageTypes.sort((a, b) => b.count - a.count)
    if (ch.messageTypes.length > MAX_TYPES_PER_CHANNEL) {
      ch.messageTypes = ch.messageTypes.slice(0, MAX_TYPES_PER_CHANNEL)
    }
  }

  const list = [...channels.values()].sort((a, b) => (b.recvCount + b.sendCount) - (a.recvCount + a.sendCount))
  return list.slice(0, MAX_CHANNELS)
}

interface MutableType {
  key: string
  count: number
  bytes: number
  sendSeen: boolean
  recvSeen: boolean
  samples: string[]
  firstSample?: string
}

function createType(key: string): MutableType {
  return { key, count: 0, bytes: 0, sendSeen: false, recvSeen: false, samples: [] }
}

// Extracts a discriminator key from a JSON payload. WebSocket protocols
// almost always use a tagged-union style — Socket.IO ("event"), Pusher
// ("event"), GraphQL-WS ("type"), JSON-RPC ("method"). Tries the obvious
// fields in priority order; falls back to a stable hash of top-level keys
// so similarly-shaped messages still group together.
function discriminate(payload: string): string {
  if (!payload) return '__empty__'
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { return '__opaque__' }
  if (!parsed || typeof parsed !== 'object') return '__opaque__'
  const obj = parsed as Record<string, unknown>
  for (const k of ['type', 'op', 'method', 'kind', 'command', 'event', 'action']) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0 && v.length < 64) return `${k}:${v}`
  }
  // Fall back to "shape:<top-level keys joined>" so messages with the same
  // shape but no discriminator still bucket together.
  const keys = Object.keys(obj).slice(0, 8).sort().join(',')
  return `shape:${keys || '__empty__'}`
}

// Very light shape inference for WS payloads — calls into a tiny inline
// walker rather than depending on the server's inferType so we keep the
// extension bundle small. Only used to give the user a "this is what these
// messages look like" hint; precision isn't critical.
function inferShapeQuick(samples: string[]): string | undefined {
  if (samples.length === 0) return undefined
  let merged: Shape | null = null
  for (const s of samples.slice(0, 10)) {
    try {
      const obj = JSON.parse(s)
      merged = mergeShape(merged, shapeOf(obj, 0))
    } catch {
      return undefined
    }
  }
  if (!merged) return undefined
  return renderShape(merged, 0)
}

type Shape =
  | { kind: 'null' | 'string' | 'number' | 'boolean' | 'unknown' }
  | { kind: 'array'; element: Shape }
  | { kind: 'object'; props: Record<string, Shape> }

function shapeOf(v: unknown, depth: number): Shape {
  if (depth > 4) return { kind: 'unknown' }
  if (v === null) return { kind: 'null' }
  if (Array.isArray(v)) {
    let elt: Shape | null = null
    for (const i of v.slice(0, 8)) elt = mergeShape(elt, shapeOf(i, depth + 1))
    return { kind: 'array', element: elt ?? { kind: 'unknown' } }
  }
  if (typeof v === 'object') {
    const props: Record<string, Shape> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) props[k] = shapeOf(val, depth + 1)
    return { kind: 'object', props }
  }
  if (typeof v === 'string') return { kind: 'string' }
  if (typeof v === 'number') return { kind: 'number' }
  if (typeof v === 'boolean') return { kind: 'boolean' }
  return { kind: 'unknown' }
}

function mergeShape(a: Shape | null, b: Shape): Shape {
  if (!a) return b
  if (a.kind !== b.kind) return { kind: 'unknown' }
  if (a.kind === 'object' && b.kind === 'object') {
    const props: Record<string, Shape> = {}
    for (const k of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
      const av = a.props[k]
      const bv = b.props[k]
      props[k] = av && bv ? mergeShape(av, bv) : (av ?? bv!)
    }
    return { kind: 'object', props }
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', element: mergeShape(a.element, b.element) }
  }
  return a
}

function renderShape(s: Shape, depth: number): string {
  switch (s.kind) {
    case 'null': return 'null'
    case 'unknown': return 'unknown'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return `${renderShape(s.element, depth + 1)}[]`
    case 'object': {
      const keys = Object.keys(s.props)
      if (keys.length === 0) return 'Record<string, unknown>'
      const indent = '  '.repeat(depth + 1)
      const close = '  '.repeat(depth)
      const lines = keys.sort().map((k) => {
        const propName = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)
        return `${indent}${propName}: ${renderShape(s.props[k]!, depth + 1)}`
      })
      return `{\n${lines.join('\n')}\n${close}}`
    }
  }
}
