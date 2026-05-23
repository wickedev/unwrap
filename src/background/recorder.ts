import type {
  ConsoleEvent,
  ExceptionEvent,
  NavigationEvent,
  RequestEvent,
  RequestFailedEvent,
  ResponseEvent,
  ScreenshotEvent,
  SessionMeta,
  WebSocketClosedEvent,
  WebSocketCreatedEvent,
  WebSocketFrameEvent,
} from '@/shared/events'
import { appendEvent, getSession, makeId, putBlob, putSession } from '@/shared/storage'
import { redactHeaders, shouldCaptureResponseBody } from '@/shared/redact'
import { captureStorageState } from './storage-state'
import { captureAxTree, captureDomSnapshot } from './snapshot'
import { CoverageTracker } from './coverage'

const DEBUGGER_PROTOCOL = '1.3'
const SNAPSHOT_DELAY_MS = 1500
const STORAGE_STATE_DELAY_MS = 250
const MAX_CONSOLE_ARG_LEN = 4_000
const MAX_WS_PAYLOAD_LEN = 64_000

type RequestRecord = {
  requestId: string
  url: string
  method: string
  resourceType?: string
  mimeType?: string
}

export class TabRecorder {
  readonly sessionId: string
  readonly tabId: number
  private attached = false
  private pendingRequests = new Map<string, RequestRecord>()
  private coverage: CoverageTracker
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(sessionId: string, tabId: number) {
    this.sessionId = sessionId
    this.tabId = tabId
    this.coverage = new CoverageTracker(tabId)
  }

  async start(): Promise<void> {
    const target: chrome.debugger.Debuggee = { tabId: this.tabId }
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL)
    this.attached = true

    await chrome.debugger.sendCommand(target, 'Network.enable', {})
    await chrome.debugger.sendCommand(target, 'Page.enable', {})
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {})
    await chrome.debugger.sendCommand(target, 'DOM.enable', {})
    await chrome.debugger.sendCommand(target, 'DOMSnapshot.enable', {}).catch(() => {})
    await chrome.debugger.sendCommand(target, 'Accessibility.enable', {})

    chrome.debugger.onEvent.addListener(this.onDebuggerEvent)
    chrome.debugger.onDetach.addListener(this.onDetach)
    chrome.webNavigation.onCommitted.addListener(this.onNavCommitted)
    chrome.webNavigation.onHistoryStateUpdated.addListener(this.onHistoryStateUpdated)

    await this.coverage.start()

    await this.captureScreenshot('navigation', true)
    this.scheduleStorageStateCapture('session_start')
    this.scheduleSnapshot('session_start')
    await this.notifyContentScript('recording_started')
  }

  async stop(): Promise<void> {
    if (!this.attached) return
    for (const t of this.snapshotTimers.values()) clearTimeout(t)
    this.snapshotTimers.clear()

    chrome.debugger.onEvent.removeListener(this.onDebuggerEvent)
    chrome.debugger.onDetach.removeListener(this.onDetach)
    chrome.webNavigation.onCommitted.removeListener(this.onNavCommitted)
    chrome.webNavigation.onHistoryStateUpdated.removeListener(this.onHistoryStateUpdated)
    await this.notifyContentScript('recording_stopped')

    try {
      const cov = await this.coverage.stopAndCollect(this.sessionId)
      if (cov) await this.bumpCounts({})
    } catch (e) {
      console.debug('[unwrap] coverage stop failed', e)
    }

    try {
      await chrome.debugger.detach({ tabId: this.tabId })
    } catch {
      // tab may already be closed
    }
    this.attached = false
  }

  private scheduleStorageStateCapture(trigger: 'session_start' | 'navigation'): void {
    setTimeout(() => {
      void captureStorageState(this.sessionId, trigger)
    }, STORAGE_STATE_DELAY_MS)
  }

  private scheduleSnapshot(key: string): void {
    const existing = this.snapshotTimers.get(key)
    if (existing) clearTimeout(existing)
    const t = setTimeout(async () => {
      this.snapshotTimers.delete(key)
      if (!this.attached) return
      const tab = await chrome.tabs.get(this.tabId).catch(() => null)
      const url = tab?.url ?? ''
      const dom = await captureDomSnapshot(this.tabId, this.sessionId, url)
      const ax = await captureAxTree(this.tabId, this.sessionId, url)
      await this.bumpCounts({
        domSnapshots: dom ? 1 : 0,
        axTrees: ax ? 1 : 0,
      })
    }, SNAPSHOT_DELAY_MS)
    this.snapshotTimers.set(key, t)
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
      void this.captureScreenshot('navigation', true)
      this.scheduleStorageStateCapture('navigation')
      this.scheduleSnapshot(`nav-${details.url}`)
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
    if (details.frameId === 0) {
      this.scheduleSnapshot(`hist-${details.url}`)
    }
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
      case 'Network.webSocketCreated':
        this.handleWsCreated(params as Cdp.WebSocketCreated)
        break
      case 'Network.webSocketFrameSent':
        this.handleWsFrame(params as Cdp.WebSocketFrameParams, 'send')
        break
      case 'Network.webSocketFrameReceived':
        this.handleWsFrame(params as Cdp.WebSocketFrameParams, 'recv')
        break
      case 'Network.webSocketClosed':
        this.handleWsClosed(params as { requestId: string })
        break
      case 'Runtime.consoleAPICalled':
        this.handleConsole(params as Cdp.ConsoleAPICalled)
        break
      case 'Runtime.exceptionThrown':
        this.handleException(params as Cdp.ExceptionThrown)
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
    const rec = this.pendingRequests.get(params.requestId)
    if (rec) rec.mimeType = res.mimeType
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

    const mimeType = rec.mimeType ?? ''
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
      await putBlob(ref, this.sessionId, mimeType || 'application/octet-stream', data)

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

  private handleWsCreated(params: Cdp.WebSocketCreated): void {
    const event: WebSocketCreatedEvent = {
      type: 'ws_created',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
      url: params.url,
      initiator: params.initiator,
    }
    void appendEvent(event)
  }

  private handleWsFrame(params: Cdp.WebSocketFrameParams, direction: 'send' | 'recv'): void {
    const payload = params.response.payloadData ?? ''
    const truncated = payload.length > MAX_WS_PAYLOAD_LEN ? payload.slice(0, MAX_WS_PAYLOAD_LEN) : payload
    const event: WebSocketFrameEvent = {
      type: 'ws_frame',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
      direction,
      opcode: params.response.opcode,
      payloadData: truncated,
      payloadSize: payload.length,
      mask: !!params.response.mask,
    }
    void appendEvent(event)
    void this.bumpCounts({ wsFrames: 1 })
  }

  private handleWsClosed(params: { requestId: string }): void {
    const event: WebSocketClosedEvent = {
      type: 'ws_closed',
      sessionId: this.sessionId,
      ts: Date.now(),
      requestId: params.requestId,
    }
    void appendEvent(event)
  }

  private handleConsole(params: Cdp.ConsoleAPICalled): void {
    const args = (params.args ?? []).map((a) => stringifyConsoleArg(a))
    const frame = params.stackTrace?.callFrames?.[0]
    const event: ConsoleEvent = {
      type: 'console',
      sessionId: this.sessionId,
      ts: Date.now(),
      level: params.type as ConsoleEvent['level'],
      args,
      ...(frame?.url ? { stackUrl: frame.url } : {}),
      ...(frame?.lineNumber != null ? { stackLine: frame.lineNumber } : {}),
    }
    void appendEvent(event)
    void this.bumpCounts({ consoleMessages: 1 })
  }

  private handleException(params: Cdp.ExceptionThrown): void {
    const ed = params.exceptionDetails
    const msg = ed.exception?.description ?? ed.text ?? 'exception'
    const event: ExceptionEvent = {
      type: 'exception',
      sessionId: this.sessionId,
      ts: Date.now(),
      message: msg,
      ...(ed.stackTrace ? { stack: stackTraceToString(ed.stackTrace) } : {}),
      ...(ed.url ? { url: ed.url } : {}),
      ...(ed.lineNumber != null ? { line: ed.lineNumber } : {}),
      ...(ed.columnNumber != null ? { column: ed.columnNumber } : {}),
    }
    void appendEvent(event)
    void this.bumpCounts({ exceptions: 1 })
  }

  async captureScreenshot(reason: ScreenshotEvent['reason'], fullPage: boolean): Promise<void> {
    try {
      if (fullPage) {
        await this.captureFullPageScreenshot(reason)
      } else {
        await this.captureViewportScreenshot(reason)
      }
    } catch (e) {
      console.debug('[unwrap] screenshot failed', e)
    }
  }

  private async captureViewportScreenshot(reason: ScreenshotEvent['reason']): Promise<void> {
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
      fullPage: false,
    }
    await appendEvent(event)
    await this.bumpCounts({ screenshots: 1 })
  }

  private async captureFullPageScreenshot(reason: ScreenshotEvent['reason']): Promise<void> {
    try {
      const tab = await chrome.tabs.get(this.tabId)
      const result = (await chrome.debugger.sendCommand(
        { tabId: this.tabId },
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true, fromSurface: true },
      )) as { data: string }
      const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'image/png' })
      const ref = makeId('shot')
      await putBlob(ref, this.sessionId, 'image/png', blob)
      const event: ScreenshotEvent = {
        type: 'screenshot',
        sessionId: this.sessionId,
        ts: Date.now(),
        ref,
        reason,
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
        fullPage: true,
      }
      await appendEvent(event)
      await this.bumpCounts({ screenshots: 1 })
    } catch (e) {
      console.debug('[unwrap] full-page screenshot failed, falling back to viewport', e)
      await this.captureViewportScreenshot(reason)
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
    meta.counts.consoleMessages += delta.consoleMessages ?? 0
    meta.counts.exceptions += delta.exceptions ?? 0
    meta.counts.wsFrames += delta.wsFrames ?? 0
    meta.counts.domSnapshots += delta.domSnapshots ?? 0
    meta.counts.axTrees += delta.axTrees ?? 0
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

function stringifyConsoleArg(arg: Cdp.RemoteObject): string {
  if (arg.unserializableValue != null) return String(arg.unserializableValue).slice(0, MAX_CONSOLE_ARG_LEN)
  if (arg.value !== undefined) {
    try {
      const s = typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
      return s.length > MAX_CONSOLE_ARG_LEN ? s.slice(0, MAX_CONSOLE_ARG_LEN) + '…' : s
    } catch {
      return String(arg.value).slice(0, MAX_CONSOLE_ARG_LEN)
    }
  }
  if (arg.description) return arg.description.slice(0, MAX_CONSOLE_ARG_LEN)
  return `[${arg.type}]`
}

function stackTraceToString(st: Cdp.StackTrace): string {
  return (st.callFrames ?? [])
    .map((f) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join('\n')
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
  export interface WebSocketCreated {
    requestId: string
    url: string
    initiator?: unknown
  }
  export interface WebSocketFrameParams {
    requestId: string
    response: {
      opcode: number
      mask?: boolean
      payloadData?: string
    }
  }
  export interface RemoteObject {
    type: string
    subtype?: string
    value?: unknown
    unserializableValue?: string
    description?: string
  }
  export interface StackFrame {
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
  }
  export interface StackTrace {
    callFrames: StackFrame[]
  }
  export interface ConsoleAPICalled {
    type: string
    args?: RemoteObject[]
    stackTrace?: StackTrace
  }
  export interface ExceptionThrown {
    exceptionDetails: {
      text?: string
      exception?: RemoteObject
      stackTrace?: StackTrace
      url?: string
      lineNumber?: number
      columnNumber?: number
    }
  }
}
export type { Cdp }
