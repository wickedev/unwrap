// Service-worker-side video controller. Owns the offscreen document
// lifecycle and proxies start/stop requests through to the MediaRecorder
// that actually runs there.
//
// The offscreen API is single-document — there's at most one offscreen
// page per extension — so the recorder is implicitly a singleton too.
// We refuse to start a second session while one is active.

const OFFSCREEN_PATH = 'src/offscreen/index.html'

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

// Boots the offscreen document (if not already), trades the tabId for
// a media stream id, and asks the offscreen recorder to start. Throws
// if tabCapture refuses the tab (chrome:// pages, the Chrome Web Store,
// PDF viewer, etc.) so the caller can surface that to the user.
export async function startVideoRecording(sessionId: string, tabId: number): Promise<void> {
  if (active) {
    throw new Error(`Video recording already active for session ${active.sessionId}`)
  }
  await ensureOffscreen()
  const streamId = await getTabStreamId(tabId)
  if (!streamId) throw new Error('chrome.tabCapture refused to issue a stream id for this tab')
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const resp = (await chrome.runtime.sendMessage({
    kind: 'offscreen_video_start',
    streamId,
    videoBitsPerSecond: 800_000,
    // Cap dimensions to keep file size predictable. The MediaRecorder
    // downscales internally; doesn't change the captured tab.
    ...(tab?.width ? { width: Math.min(tab.width, 1280) } : {}),
    ...(tab?.height ? { height: Math.min(tab.height, 800) } : {}),
  })) as { ok: boolean; error?: string }
  if (!resp?.ok) throw new Error(resp?.error || 'offscreen video start failed')
  active = { sessionId, tabId, startedAt: Date.now() }
}

// Stops the MediaRecorder and returns the assembled blob (as base64).
// Always tears down the offscreen document afterwards — we keep it
// alive only during an active recording so it doesn't show up as
// "always-running" in the Chrome task manager.
export async function stopVideoRecording(): Promise<StopResult> {
  if (!active) return {}
  active = null
  let result: StopResult = {}
  try {
    const resp = (await chrome.runtime.sendMessage({ kind: 'offscreen_video_stop' })) as
      | { ok: boolean; base64?: string; mimeType?: string; durationMs?: number; sizeBytes?: number; error?: string }
      | undefined
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
  // hasDocument() lets us avoid the spurious "only a single offscreen
  // document may be created" error if a prior recording left one open.
  const exists = await chrome.offscreen.hasDocument()
  if (exists) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Record the active tab as video for session playback.',
  })
}

function getTabStreamId(tabId: number): Promise<string | null> {
  // Promise wrapper around the callback-style API — MV3 service workers
  // see the legacy callback form depending on Chrome version.
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          console.warn('[unwrap-video] tabCapture.getMediaStreamId failed', chrome.runtime.lastError.message)
          resolve(null)
        } else {
          resolve(streamId || null)
        }
      })
    } catch (e) {
      console.warn('[unwrap-video] tabCapture call threw', e)
      resolve(null)
    }
  })
}
