import type { RuntimeMessage, SessionMeta } from '@/shared/events'
import {
  appendEvent,
  deleteSession,
  getSession,
  listSessions,
  makeId,
  putSession,
} from '@/shared/storage'
import { TabRecorder } from './recorder'
import { exportSessionAsHar, exportSessionAsJson, exportSessionAsPlaywright } from './export'
import { captureStorageState } from './storage-state'
import { uploadSessionToServer } from './llm'
import { getActiveVideoSession, startVideoRecording, stopVideoRecording, type StopResult } from './video'
import { putBlob } from '@/shared/storage'
import { authIsValid, getSettings, setSettings } from '@/shared/settings'

const recorders = new Map<number, TabRecorder>()

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId })
  }
})

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  ;(async () => {
    try {
      const result = await handle(msg, sender)
      sendResponse({ ok: true, result })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[unwrap] message handler failed', msg.kind, e)
      sendResponse({ ok: false, error: message })
    }
  })()
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  const rec = recorders.get(tabId)
  if (!rec) return
  const sessionId = rec.sessionId
  void rec.stop().finally(async () => {
    recorders.delete(tabId)
    const activeVideo = getActiveVideoSession()
    if (activeVideo && activeVideo.sessionId === sessionId) {
      try {
        const result = await stopVideoRecording()
        await persistVideo(sessionId, result)
      } catch (e) {
        console.warn('[unwrap] video stop on tab close failed', e)
      }
    }
    await markStopped(sessionId)
    void autoUpload(sessionId, { openTab: false })
  })
})

async function handle(msg: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.kind) {
    case 'start_session':
      return startSession(msg.tabId)
    case 'stop_session':
      return stopSession(msg.sessionId, { autoUpload: true })
    case 'list_sessions': {
      const list = await listSessions()
      void backfillUnuploaded(list)
      return list
    }
    case 'get_session':
      return getSession(msg.sessionId)
    case 'delete_session':
      return deleteSession(msg.sessionId)
    case 'export_session':
      switch (msg.format) {
        case 'har':
          return exportSessionAsHar(msg.sessionId)
        case 'playwright':
          return exportSessionAsPlaywright(msg.sessionId)
        case 'json':
        default:
          return exportSessionAsJson(msg.sessionId)
      }
    case 'capture_storage_state':
      return captureStorageState(msg.sessionId, msg.trigger ?? 'manual')
    case 'content_storage_state': {
      const meta = await getSession(msg.sessionId)
      if (!meta) return
      const storageEvent = {
        type: 'storage_state' as const,
        sessionId: msg.sessionId,
        ts: Date.now(),
        origin: msg.origin,
        cookies: await chrome.cookies.getAll({ url: msg.origin }),
        localStorage: msg.local,
        sessionStorage: msg.session,
        trigger: msg.trigger,
      }
      await appendEvent(storageEvent)
      const recorder = findRecorder(msg.sessionId)
      if (recorder) {
        await recorder.bumpCounts({ storageStates: 1 })
        recorder.notifyStorageStateCaptured(storageEvent)
      }
      return
    }
    case 'is_recording': {
      const tabId = msg.tabId ?? sender.tab?.id
      if (tabId == null) return { recording: false }
      const rec = recorders.get(tabId)
      return rec ? { recording: true, sessionId: rec.sessionId } : { recording: false }
    }
    case 'action_event': {
      const event = msg.event
      const recorder = findRecorder(event.sessionId)
      if (!recorder) return
      await appendEvent(event)
      await recorder.bumpCounts({ actions: 1 })
      return
    }
    case 'get_settings':
      return getSettings()
    case 'set_settings': {
      const next = await setSettings(msg.patch)
      void backfillUnuploaded()
      return next
    }
    case 'upload_session':
      return autoUpload(msg.sessionId, { openTab: true, force: true })
    default:
      throw new Error(`unknown message: ${(msg as { kind: string }).kind}`)
  }
}

function findRecorder(sessionId: string): TabRecorder | undefined {
  for (const r of recorders.values()) {
    if (r.sessionId === sessionId) return r
  }
  return undefined
}

async function startSession(tabId: number): Promise<SessionMeta> {
  if (recorders.has(tabId)) {
    throw new Error('a session is already recording in this tab')
  }
  const tab = await chrome.tabs.get(tabId)
  const sessionId = makeId('ses')
  const meta: SessionMeta = {
    id: sessionId,
    createdAt: Date.now(),
    startedAt: Date.now(),
    tabId,
    startUrl: tab.url ?? '',
    userAgent: navigator.userAgent,
    viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    devicePixelRatio: 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    status: 'recording',
    counts: {
      requests: 0,
      responses: 0,
      screenshots: 0,
      navigations: 0,
      actions: 0,
      storageStates: 0,
      consoleMessages: 0,
      exceptions: 0,
      wsFrames: 0,
      domSnapshots: 0,
      axTrees: 0,
    },
  }
  await putSession(meta)
  const recorder = new TabRecorder(sessionId, tabId)
  recorders.set(tabId, recorder)
  try {
    await recorder.start()
  } catch (e) {
    recorders.delete(tabId)
    meta.status = 'error'
    meta.error = e instanceof Error ? e.message : String(e)
    await putSession(meta)
    throw e
  }
  // Fire-and-forget video recording — non-fatal if it fails (chrome://
  // pages, PDF viewer, etc.). We just log and let the rest of the
  // session capture proceed without video.
  void startVideoRecording(sessionId, tabId).catch((e) => {
    console.warn('[unwrap] video recording could not start', e)
  })
  return meta
}

async function stopSession(
  sessionId: string,
  opts: { autoUpload?: boolean } = {},
): Promise<SessionMeta | undefined> {
  for (const [tabId, rec] of recorders) {
    if (rec.sessionId === sessionId) {
      await rec.stop()
      recorders.delete(tabId)
      break
    }
  }
  // Tear down the video recorder for THIS session. Skip if the offscreen
  // captured a different session (multi-tab; shouldn't happen with our
  // current 1-active-recording invariant, but defensive).
  const activeVideo = getActiveVideoSession()
  if (activeVideo && activeVideo.sessionId === sessionId) {
    try {
      const result = await stopVideoRecording()
      await persistVideo(sessionId, result)
    } catch (e) {
      console.warn('[unwrap] video stop/persist failed', e)
    }
  }
  const meta = await markStopped(sessionId)
  if (opts.autoUpload) {
    void autoUpload(sessionId, { openTab: true })
  }
  return meta
}

async function persistVideo(sessionId: string, result: StopResult): Promise<void> {
  console.info('[unwrap-video] persistVideo', {
    sessionId,
    hasBase64: !!result.base64,
    base64Length: result.base64?.length ?? 0,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    durationMs: result.durationMs,
  })
  if (!result.base64 || !result.mimeType) {
    console.warn('[unwrap-video] persistVideo skipped — offscreen returned no blob (no chunks captured?)')
    return
  }
  const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: result.mimeType })
  // Store under a deterministic ref so the uploader can find it without
  // walking events. Cleaned up alongside the session record on delete.
  await putBlob(`video-${sessionId}`, sessionId, result.mimeType, blob)
  const meta = await getSession(sessionId)
  if (!meta) return
  meta.video = {
    ref: `video-${sessionId}`,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes ?? blob.size,
    durationMs: result.durationMs ?? 0,
  }
  await putSession(meta)
  console.info('[unwrap-video] persisted to IndexedDB; will upload on session POST')
}

async function markStopped(sessionId: string): Promise<SessionMeta | undefined> {
  const meta = await getSession(sessionId)
  if (!meta) return
  if (meta.status === 'recording') {
    meta.status = 'stopped'
    meta.endedAt = Date.now()
    await putSession(meta)
  }
  return meta
}

const uploadsInFlight = new Set<string>()

// Walks every locally-stored session and queues an auto-upload for the
// ones that are stopped but haven't successfully uploaded yet. Triggered
// after sign-in (settings change) and on every side-panel refresh.
async function backfillUnuploaded(preloaded?: SessionMeta[]): Promise<void> {
  const settings = await getSettings()
  if (!settings.serverUrl || !authIsValid(settings.auth)) return
  const all = preloaded ?? (await listSessions())
  for (const s of all) {
    if (s.status !== 'stopped') continue
    if (s.upload?.state === 'done' || s.upload?.state === 'pending') continue
    if (uploadsInFlight.has(s.id)) continue
    void autoUpload(s.id, { openTab: false })
  }
}

chrome.runtime.onStartup?.addListener(() => {
  void backfillUnuploaded()
})

interface AutoUploadOptions {
  openTab?: boolean
  force?: boolean
}

interface AutoUploadResult {
  state: 'skipped' | 'done' | 'error'
  url?: string
  message?: string
}

async function autoUpload(sessionId: string, opts: AutoUploadOptions = {}): Promise<AutoUploadResult> {
  if (uploadsInFlight.has(sessionId)) return { state: 'skipped', message: 'already in flight' }
  uploadsInFlight.add(sessionId)
  try {
    const meta = await getSession(sessionId)
    if (!meta) return { state: 'skipped', message: 'session not found' }

    // Already uploaded — just (optionally) re-open the existing tab.
    if (!opts.force && meta.upload?.state === 'done') {
      if (opts.openTab) await chrome.tabs.create({ url: meta.upload.url })
      return { state: 'done', url: meta.upload.url }
    }

    const settings = await getSettings()
    if (!settings.serverUrl || !authIsValid(settings.auth)) {
      return { state: 'skipped', message: 'not signed in' }
    }

    await putSession({ ...meta, upload: { state: 'pending' } })
    const result = await uploadSessionToServer(sessionId)
    const next = await getSession(sessionId)
    if (next) {
      next.upload = {
        state: 'done',
        serverSessionId: result.id,
        url: result.url,
        uploadedAt: Date.now(),
      }
      await putSession(next)
    }
    if (opts.openTab) await chrome.tabs.create({ url: result.url })
    return { state: 'done', url: result.url }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[unwrap] auto-upload failed', sessionId, message)
    const next = await getSession(sessionId)
    if (next) {
      next.upload = { state: 'error', message, failedAt: Date.now() }
      await putSession(next)
    }
    return { state: 'error', message }
  } finally {
    uploadsInFlight.delete(sessionId)
  }
}

