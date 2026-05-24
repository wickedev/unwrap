// Offscreen-document video recorder. Service workers can't host a
// MediaRecorder (no DOM, no media elements), so we run it here. The
// background SW posts us a tab-capture stream id; we trade it for a
// MediaStream, pipe into MediaRecorder, and post the assembled webm
// blob back as a base64 string when stop is requested.
//
// Why base64 over postMessage instead of structured-cloned Blob: the
// background SW marshals our message via chrome.runtime.sendMessage,
// which serializes via JSON. Blobs don't survive that — we'd lose the
// bytes silently. base64 is bulky but reliable.

interface StartMsg {
  kind: 'offscreen_video_start'
  streamId: string
  // The bitrate cap shapes file size. 800 kbps ~= 6 MB for 60s, which
  // keeps base64 round-trips under 10 MB for typical sessions.
  videoBitsPerSecond?: number
  width?: number
  height?: number
}
interface StopMsg {
  kind: 'offscreen_video_stop'
}

interface RecorderState {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  startedAt: number
}

let state: RecorderState | null = null

type OffscreenMsg = StartMsg | StopMsg

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !('kind' in msg)) return
  const m = msg as OffscreenMsg
  if (m.kind === 'offscreen_video_start') {
    void startRecording(m).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    )
    return true
  }
  if (m.kind === 'offscreen_video_stop') {
    void stopRecording().then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    )
    return true
  }
  return
})

async function startRecording(msg: StartMsg): Promise<void> {
  if (state) {
    try { state.recorder.stop() } catch {}
    try { for (const t of state.stream.getTracks()) t.stop() } catch {}
    state = null
  }
  // The mandatory constraints object is Chrome's non-standard hook into
  // tabCapture — the streamId from getMediaStreamId is the only way to
  // bridge SW-side capture authorization into a getUserMedia call.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error — non-standard but Chrome-only API
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: msg.streamId,
        ...(msg.width ? { maxWidth: msg.width } : {}),
        ...(msg.height ? { maxHeight: msg.height } : {}),
      },
    },
  })
  const mime = pickMimeType()
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: msg.videoBitsPerSecond ?? 800_000,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  recorder.start(1000)
  state = { recorder, stream, chunks, startedAt: Date.now() }
}

async function stopRecording(): Promise<{ base64?: string; mimeType?: string; durationMs?: number; sizeBytes?: number }> {
  if (!state) return {}
  const { recorder, stream, chunks, startedAt } = state
  state = null
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    try { recorder.requestData() } catch {}
    try { recorder.stop() } catch { resolve() }
  })
  try { for (const t of stream.getTracks()) t.stop() } catch {}
  if (chunks.length === 0) return {}
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
  const base64 = await blobToBase64(blob)
  return {
    base64,
    mimeType: blob.type,
    durationMs: Date.now() - startedAt,
    sizeBytes: blob.size,
  }
}

function pickMimeType(): string {
  // Prefer vp9 (smaller files at same quality) but fall back to vp8/webm
  // — Chrome generally has both, Firefox via the same offscreen API only
  // has webm. We don't target Firefox today but cheap to be lenient.
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return 'video/webm'
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
