// Service-worker-side video controller. Owns the offscreen document
// lifecycle and proxies start/stop requests through to the MediaRecorder
// that actually runs there.
//
// The offscreen API is single-document — there's at most one offscreen
// page per extension — so the recorder is implicitly a singleton too.
// We refuse to start a second session while one is active.

const OFFSCREEN_PATH = 'src/offscreen/index.html'

// How long to keep retrying the readiness ping before giving up. The
// offscreen doc loads its module script asynchronously after
// createDocument resolves — sending the start message before the
// recorder's onMessage listener is attached just gets swallowed.
const OFFSCREEN_READY_TIMEOUT_MS = 3_000
const OFFSCREEN_PING_INTERVAL_MS = 50

interface ActiveRecording {
  sessionId: string
  tabId: number
  startedAt: number
}

let active: ActiveRecording | null = null

export function getActiveVideoSession(): ActiveRecording | null {
  return active
}

export interface StopResult {
  base64?: string
  mimeType?: string
  durationMs?: number
  sizeBytes?: number
}

// Boots the offscreen document and asks the recorder to start. The
// stream id is usually minted by the sidepanel (where the user-gesture
// transient state is fresh); if not provided, falls back to a SW-side
// mint which mostly fails outside of an action-onClicked context.
export async function startVideoRecording(sessionId: string, tabId: number, providedStreamId?: string): Promise<void> {
  if (active) {
    throw new Error(`Video recording already active for session ${active.sessionId}`)
  }
  console.info('[unwrap-video] start requested', { sessionId, tabId, providedStreamId: !!providedStreamId })
  let streamId = providedStreamId
  if (!streamId) {
    const result = await getTabStreamIdWithError(tabId)
    if (result.error) throw new Error(result.error)
    streamId = result.streamId
  }
  if (!streamId) throw new Error('chrome.tabCapture returned no stream id')
  console.info('[unwrap-video] got stream id', { length: streamId.length })

  await ensureOffscreen()
  await waitForOffscreenReady()

  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const resp = (await chrome.runtime.sendMessage({
    kind: 'offscreen_video_start',
    streamId,
    videoBitsPerSecond: 800_000,
    // Cap dimensions to keep file size predictable. The MediaRecorder
    // downscales internally; doesn't change the captured tab.
    ...(tab?.width ? { width: Math.min(tab.width, 1280) } : {}),
    ...(tab?.height ? { height: Math.min(tab.height, 800) } : {}),
  })) as { ok: boolean; error?: string } | undefined
  console.info('[unwrap-video] offscreen start response', resp)
  if (!resp?.ok) throw new Error(resp?.error || 'offscreen video start: no response')
  active = { sessionId, tabId, startedAt: Date.now() }
}

// Stops the MediaRecorder and returns the assembled blob (as base64).
// Always tears down the offscreen document afterwards.
export async function stopVideoRecording(): Promise<StopResult> {
  if (!active) return {}
  const startedAt = active.startedAt
  active = null
  let result: StopResult = {}
  try {
    const resp = (await chrome.runtime.sendMessage({ kind: 'offscreen_video_stop' })) as
      | { ok: boolean; base64?: string; mimeType?: string; durationMs?: number; sizeBytes?: number; error?: string }
      | undefined
    console.info('[unwrap-video] offscreen stop response', {
      ok: resp?.ok,
      hasBase64: !!resp?.base64,
      base64Length: resp?.base64?.length ?? 0,
      mimeType: resp?.mimeType,
      sizeBytes: resp?.sizeBytes,
      durationMs: resp?.durationMs,
      error: resp?.error,
      elapsedMs: Date.now() - startedAt,
    })
    if (resp?.ok && resp.base64) {
      result = { base64: resp.base64, mimeType: resp.mimeType, durationMs: resp.durationMs, sizeBytes: resp.sizeBytes }
    } else if (resp && !resp.ok) {
      console.warn('[unwrap-video] offscreen stop reported error', resp.error)
    }
  } catch (e) {
    console.warn('[unwrap-video] offscreen stop call failed', e)
  } finally {
    try { await chrome.offscreen.closeDocument() } catch {}
  }
  return result
}

async function ensureOffscreen(): Promise<void> {
  // Always start from a clean slate — a prior session's offscreen may
  // have crashed or been left mid-state. closeDocument is a no-op if
  // nothing's open.
  try {
    const exists = await chrome.offscreen.hasDocument()
    if (exists) {
      console.info('[unwrap-video] closing stale offscreen document before recreate')
      await chrome.offscreen.closeDocument()
    }
  } catch (e) {
    console.warn('[unwrap-video] hasDocument/closeDocument failed (continuing)', e)
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Record the active tab as video for session playback.',
  })
  console.info('[unwrap-video] offscreen document created')
}

// createDocument resolves when the HTML is fetched, NOT when the module
// scripts have parsed + attached their onMessage listeners. Bombarding
// the offscreen with a sendMessage immediately after often misses the
// listener. We poll a ping until the offscreen replies pong.
async function waitForOffscreenReady(): Promise<void> {
  const deadline = Date.now() + OFFSCREEN_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const resp = (await chrome.runtime.sendMessage({ kind: 'offscreen_video_ping' })) as
        | { ok: boolean }
        | undefined
      if (resp?.ok) {
        console.info('[unwrap-video] offscreen ready')
        return
      }
    } catch {
      // The offscreen receiving end might not exist yet — that's exactly
      // the case we're waiting through. Treat as not-ready and retry.
    }
    await new Promise((r) => setTimeout(r, OFFSCREEN_PING_INTERVAL_MS))
  }
  throw new Error('offscreen recorder did not become ready in time')
}

function getTabStreamIdWithError(tabId: number): Promise<{ streamId?: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const lastErr = chrome.runtime.lastError
        if (lastErr) {
          console.warn('[unwrap-video] tabCapture.getMediaStreamId failed', lastErr.message)
          resolve({ error: lastErr.message || 'getMediaStreamId failed' })
        } else if (!streamId) {
          resolve({ error: 'getMediaStreamId returned empty id' })
        } else {
          resolve({ streamId })
        }
      })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      console.warn('[unwrap-video] tabCapture call threw', m)
      resolve({ error: m })
    }
  })
}
