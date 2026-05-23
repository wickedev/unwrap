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
import { exportSessionAsHar, exportSessionAsJson } from './export'

const recorders = new Map<number, TabRecorder>()

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId })
  }
})

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  ;(async () => {
    try {
      const result = await handle(msg)
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

async function handle(msg: RuntimeMessage): Promise<unknown> {
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
      return msg.format === 'har'
        ? exportSessionAsHar(msg.sessionId)
        : exportSessionAsJson(msg.sessionId)
    case 'capture_storage_state':
      return captureStorageState(msg.sessionId)
    case 'content_storage_state':
      return appendEvent({
        type: 'storage_state',
        sessionId: msg.sessionId,
        ts: Date.now(),
        origin: msg.origin,
        cookies: await chrome.cookies.getAll({ url: msg.origin }),
        localStorage: msg.local,
        sessionStorage: msg.session,
      })
    default:
      throw new Error(`unknown message: ${(msg as { kind: string }).kind}`)
  }
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
    counts: { requests: 0, responses: 0, screenshots: 0, navigations: 0 },
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

async function captureStorageState(sessionId: string): Promise<void> {
  const meta = await getSession(sessionId)
  if (!meta) throw new Error('session not found')
  try {
    await chrome.scripting.executeScript({
      target: { tabId: meta.tabId },
      func: (sid: string) => {
        const dump = (s: Storage) => {
          const out: Record<string, string> = {}
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i)
            if (k != null) out[k] = s.getItem(k) ?? ''
          }
          return out
        }
        chrome.runtime.sendMessage({
          kind: 'content_storage_state',
          sessionId: sid,
          origin: location.origin,
          local: dump(localStorage),
          session: dump(sessionStorage),
        })
      },
      args: [sessionId],
    })
  } catch (e) {
    console.warn('[unwrap] captureStorageState failed', e)
  }
}
