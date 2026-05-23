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
import { getSettings, setSettings } from '@/shared/settings'

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
  if (rec) {
    void rec.stop().finally(() => recorders.delete(tabId))
    void markStopped(rec.sessionId)
  }
})

async function handle(msg: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.kind) {
    case 'start_session':
      return startSession(msg.tabId)
    case 'stop_session':
      return stopSession(msg.sessionId)
    case 'list_sessions':
      return listSessions()
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
      await appendEvent({
        type: 'storage_state',
        sessionId: msg.sessionId,
        ts: Date.now(),
        origin: msg.origin,
        cookies: await chrome.cookies.getAll({ url: msg.origin }),
        localStorage: msg.local,
        sessionStorage: msg.session,
        trigger: msg.trigger,
      })
      const recorder = findRecorder(msg.sessionId)
      if (recorder) await recorder.bumpCounts({ storageStates: 1 })
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
    case 'set_settings':
      return setSettings(msg.patch)
    case 'upload_session': {
      const result = await uploadSessionToServer(msg.sessionId)
      await chrome.tabs.create({ url: result.url })
      return result
    }
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
  return meta
}

async function stopSession(sessionId: string): Promise<SessionMeta | undefined> {
  for (const [tabId, rec] of recorders) {
    if (rec.sessionId === sessionId) {
      await rec.stop()
      recorders.delete(tabId)
      break
    }
  }
  return markStopped(sessionId)
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

