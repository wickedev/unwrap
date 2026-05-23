import type {
  RequestEvent,
  ResponseEvent,
  RequestFailedEvent,
  ScreenshotEvent,
  NavigationEvent,
  SessionMeta,
} from '@/shared/events'
import { appendEvent, getSession, makeId, putBlob, putSession } from '@/shared/storage'
import { redactHeaders, shouldCaptureResponseBody } from '@/shared/redact'
import { captureStorageState } from './storage-state'

const DEBUGGER_PROTOCOL = '1.3'

type RequestRecord = {
  requestId: string
  url: string
  method: string
  resourceType?: string
}

export class TabRecorder {
  readonly sessionId: string
  readonly tabId: number
  private attached = false
  private pendingRequests = new Map<string, RequestRecord>()

  constructor(sessionId: string, tabId: number) {
    this.sessionId = sessionId
    this.tabId = tabId
  }

  async start(): Promise<void> {
    const target: chrome.debugger.Debuggee = { tabId: this.tabId }
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL)
    this.attached = true

    await chrome.debugger.sendCommand(target, 'Network.enable', {})
    await chrome.debugger.sendCommand(target, 'Page.enable', {})
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {})

    chrome.debugger.onEvent.addListener(this.onDebuggerEvent)
    chrome.debugger.onDetach.addListener(this.onDetach)
    chrome.webNavigation.onCommitted.addListener(this.onNavCommitted)
    chrome.webNavigation.onHistoryStateUpdated.addListener(this.onHistoryStateUpdated)

    await this.captureScreenshot('navigation')
    await this.scheduleStorageStateCapture('session_start')
    await this.notifyContentScript('recording_started')
  }

  async stop(): Promise<void> {
    if (!this.attached) return
    chrome.debugger.onEvent.removeListener(this.onDebuggerEvent)
    chrome.debugger.onDetach.removeListener(this.onDetach)
    chrome.webNavigation.onCommitted.removeListener(this.onNavCommitted)
    chrome.webNavigation.onHistoryStateUpdated.removeListener(this.onHistoryStateUpdated)
    await this.notifyContentScript('recording_stopped')
    try {
      await chrome.debugger.detach({ tabId: this.tabId })
    } catch {
      // tab may already be closed
    }
    this.attached = false
  }

  private async scheduleStorageStateCapture(trigger: 'session_start' | 'navigation'): Promise<void> {
    setTimeout(() => {
      void captureStorageState(this.sessionId, trigger)
    }, 250)
  }

  private async notifyContentScript(kind: 'recording_started' | 'recording_stopped'): Promise<void> {
    try {
      await chrome.tabs.sendMessage(this.tabId, { kind, sessionId: this.sessionId })
    } catch {
      // content script may not be loaded yet (e.g., chrome:// pages)
    }
  }

  private onDetach = (source: chrome.debugger.Debuggee, reason: string): void => {
    if (source.tabId !== this.tabId) return
    this.attached = false
    void this.markError(`debugger detached: ${reason}`)
  }

  private onNavCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
    if (details.tabId !== this.tabId) return
    const event: NavigationEvent = {
      type: 'navigation',
      sessionId: this.sessionId,
      ts: Date.now(),
      url: details.url,
      frameId: String(details.frameId),
      transitionType: details.transitionType,
      source: 'committed',
    }
    void appendEvent(event)
    void this.bumpCounts({ navigations: 1 })
    if (details.frameId === 0) {
      void this.captureScreenshot('navigation')
      void this.scheduleStorageStateCapture('navigation')
      void this.notifyContentScript('recording_started')
    }
  }

  private onHistoryStateUpdated = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
    if (details.tabId !== this.tabId) return
    const event: NavigationEvent = {
      type: 'navigation',
      sessionId: this.sessionId,
      ts: Date.now(),
      url: details.url,
      frameId: String(details.frameId),
      transitionType: details.transitionType,
      source: 'history_state',
    }
    void appendEvent(event)
    void this.bumpCounts({ navigations: 1 })
  }

  private onDebuggerEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId !== this.tabId) return
    switch (method) {
      case 'Network.requestWillBeSent':
        this.handleRequest(params as Cdp.RequestWillBeSent)
        break
      case 'Network.responseReceived':
        this.handleResponseMeta(params as Cdp.ResponseReceived)
        break
      case 'Network.loadingFinished':
        void this.handleLoadingFinished(params as Cdp.LoadingFinished)
        break
      case 'Network.loadingFailed':
        this.handleLoadingFailed(params as Cdp.LoadingFailed)
        break
    }
  }

  private handleRequest(params: Cdp.RequestWillBeSent): void {
    const req = params.request
    this.pendingRequests.set(params.requestId, {
      requestId: params.requestId,
      url: req.url,
      method: req.method,
      resourceType: params.type,
    })
    const event: RequestEvent = {
      type: 'request',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers ?? {}),
      postData: req.postData,
      resourceType: params.type,
      initiator: params.initiator,
    }
    void appendEvent(event)
    void this.bumpCounts({ requests: 1 })
  }

  private handleResponseMeta(params: Cdp.ResponseReceived): void {
    const res = params.response
    const event: ResponseEvent = {
      type: 'response',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      headers: redactHeaders(res.headers ?? {}),
      mimeType: res.mimeType,
      fromServiceWorker: !!res.fromServiceWorker,
      fromDiskCache: !!res.fromDiskCache,
      encodedDataLength: res.encodedDataLength,
    }
    void appendEvent(event)
    void this.bumpCounts({ responses: 1 })
  }

  private async handleLoadingFinished(params: Cdp.LoadingFinished): Promise<void> {
    const rec = this.pendingRequests.get(params.requestId)
    if (!rec) return
    this.pendingRequests.delete(params.requestId)

    const mimeType = '' // not tracked here; redact module is conservative
    if (!shouldCaptureResponseBody(mimeType, params.encodedDataLength)) return

    try {
      const body = (await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Network.getResponseBody',
        { requestId: params.requestId },
      )) as { body: string; base64Encoded: boolean } | undefined
      if (!body) return
      const ref = makeId('body')
      const data = body.base64Encoded
        ? new Blob([Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0))])
        : new Blob([body.body], { type: 'text/plain' })
      await putBlob(ref, this.sessionId, 'application/octet-stream', data)

      const event: Partial<ResponseEvent> & { type: 'response'; sessionId: string; ts: number; requestId: string } = {
        type: 'response',
        sessionId: this.sessionId,
        ts: Date.now(),
        requestId: params.requestId,
        status: 0,
        statusText: 'body',
        url: rec.url,
        headers: {},
        mimeType,
        fromServiceWorker: false,
        fromDiskCache: false,
        bodyRef: ref,
        bodySize: data.size,
      }
      await appendEvent(event as ResponseEvent)
    } catch (e) {
      // body may not be available (e.g. preflight); ignore
      console.debug('[unwrap] getResponseBody failed', e)
    }
  }

  private handleLoadingFailed(params: Cdp.LoadingFailed): void {
    this.pendingRequests.delete(params.requestId)
    const event: RequestFailedEvent = {
      type: 'request_failed',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
      errorText: params.errorText,
      canceled: !!params.canceled,
    }
    void appendEvent(event)
  }

  async captureScreenshot(reason: ScreenshotEvent['reason']): Promise<void> {
    try {
      const tab = await chrome.tabs.get(this.tabId)
      const windowId = tab.windowId
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      const blob = await (await fetch(dataUrl)).blob()
      const ref = makeId('shot')
      await putBlob(ref, this.sessionId, 'image/png', blob)
      const event: ScreenshotEvent = {
        type: 'screenshot',
        sessionId: this.sessionId,
        ts: Date.now(),
        ref,
        reason,
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
      }
      await appendEvent(event)
      await this.bumpCounts({ screenshots: 1 })
    } catch (e) {
      console.debug('[unwrap] screenshot failed', e)
    }
  }

  async bumpCounts(delta: Partial<SessionMeta['counts']>): Promise<void> {
    const meta = await getSession(this.sessionId)
    if (!meta) return
    meta.counts.requests += delta.requests ?? 0
    meta.counts.responses += delta.responses ?? 0
    meta.counts.screenshots += delta.screenshots ?? 0
    meta.counts.navigations += delta.navigations ?? 0
    meta.counts.actions += delta.actions ?? 0
    meta.counts.storageStates += delta.storageStates ?? 0
    await putSession(meta)
  }

  private async markError(error: string): Promise<void> {
    const meta = await getSession(this.sessionId)
    if (!meta) return
    meta.status = 'error'
    meta.error = error
    meta.endedAt = Date.now()
    await putSession(meta)
  }
}

namespace Cdp {
  export interface RequestWillBeSent {
    requestId: string
    request: {
      url: string
      method: string
      headers: Record<string, string>
      postData?: string
    }
    type?: string
    initiator?: unknown
  }
  export interface ResponseReceived {
    requestId: string
    response: {
      url: string
      status: number
      statusText: string
      headers: Record<string, string>
      mimeType: string
      encodedDataLength?: number
      fromServiceWorker?: boolean
      fromDiskCache?: boolean
    }
  }
  export interface LoadingFinished {
    requestId: string
    encodedDataLength: number
  }
  export interface LoadingFailed {
    requestId: string
    errorText: string
    canceled?: boolean
  }
}
export type { Cdp }
