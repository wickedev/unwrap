import type {
  ConsoleEvent,
  ExceptionEvent,
  NavigationEvent,
  RequestEvent,
  RequestFailedEvent,
  ResponseEvent,
  ScreenshotEvent,
  SessionMeta,
  StorageStateEvent,
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
// How long the network has to be quiet before we treat a navigation as
// "settled" and take the post-load screenshot. Longer = waits out late
// XHRs but risks missing flash-of-unstyled content; tuned to match
// Playwright's `networkidle` (~500ms idle).
const NETWORK_IDLE_MS = 600
// Hard cap on how long we'll wait for idle before screenshotting anyway,
// so a chatty page (analytics heartbeats, websockets) doesn't starve the
// capture entirely.
const NETWORK_IDLE_TIMEOUT_MS = 4_000
// When the recorder sees a logged-in session (auth cookie or token in
// storage), it tacks on this extra wait after idle to give post-auth
// dashboards their async render pass. Tuned conservatively — undershoots
// hurt screenshot quality more than the extra second hurts capture UX.
const LOGGED_IN_EXTRA_WAIT_MS = 1_200
// Heuristic patterns for "this storage state belongs to a logged-in
// user." Hit any cookie name OR localStorage key and we flag the session
// as authenticated. Intentionally loose — false positives cost us 1.2s,
// false negatives cost us a blurry screenshot.
const AUTH_KEY_PATTERN = /(session|auth|token|csrf|jwt|bearer|sid|access)/i

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
  // Reason → most recent screenshot debouncer. Multiple URL changes
  // landing in quick succession (SPA pushState bursts) collapse into a
  // single trailing capture per URL instead of N redundant shots.
  private screenshotDebouncers = new Map<string, ReturnType<typeof setTimeout>>()
  // Inflight request count powers the network-idle wait. Incremented
  // on requestWillBeSent, decremented on loadingFinished / loadingFailed.
  private inflightCount = 0
  private lastUrlScreenshotted = ''
  private loggedIn = false

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

    // Even though Network.enable only sees requests from now on, the page
    // was probably already loaded before recording started — meaning all
    // its HTML/CSS/JS requests have already fired and we'd miss them.
    // Page.getResourceTree gives us everything the page currently knows
    // about, and Page.getResourceContent lets us read each one's body.
    // Fire-and-forget — non-fatal if any of these fail.
    void this.captureExistingResources('session_start').catch((e) => {
      console.debug('[unwrap] captureExistingResources failed at start', e)
    })
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

    // Re-scan the resource tree at stop time — SPAs lazy-load chunks
    // after navigation, so the set is different from session_start.
    // Run BEFORE detach so the CDP commands still work.
    try {
      await this.captureExistingResources('session_end')
    } catch (e) {
      console.debug('[unwrap] captureExistingResources failed at stop', e)
    }

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

  // Called from the background message handler whenever a storage state
  // event lands. Updates the logged-in heuristic so the next post-load
  // screenshot uses the right wait budget.
  notifyStorageStateCaptured(event: StorageStateEvent): void {
    this.loggedIn = detectLoggedIn(event)
  }

  // Schedules a post-load screenshot for `url`, debounced so SPA route
  // bursts only fire once per destination. Waits for network idle (with
  // a hard ceiling) before snapping, and tacks on extra time when the
  // session looks logged-in so authenticated dashboards finish their
  // async render.
  private scheduleScreenshotAfterLoad(reason: ScreenshotEvent['reason'], url: string, debounceMs = 50): void {
    if (!this.attached) return
    const key = `screenshot:${url}`
    const existing = this.screenshotDebouncers.get(key)
    if (existing) clearTimeout(existing)
    const t = setTimeout(async () => {
      this.screenshotDebouncers.delete(key)
      if (!this.attached) return
      // Skip redundant captures on identical URLs (rapid double-fires
      // from onCommitted + an onHistoryStateUpdated to the same URL).
      if (url === this.lastUrlScreenshotted) {
        const since = Date.now() - (this.lastScreenshotAt ?? 0)
        if (since < 300) return
      }
      try {
        await this.waitForNetworkIdle(NETWORK_IDLE_MS, NETWORK_IDLE_TIMEOUT_MS)
        if (this.loggedIn) await sleep(LOGGED_IN_EXTRA_WAIT_MS)
        this.lastUrlScreenshotted = url
        this.lastScreenshotAt = Date.now()
        await this.captureScreenshot(reason, true)
      } catch (e) {
        console.debug('[unwrap] post-load screenshot failed', e)
      }
    }, debounceMs)
    this.screenshotDebouncers.set(key, t)
  }

  // Resolves once the inflight network request count has been zero for
  // `idleMs` consecutive ms, or after `timeoutMs`. Hard timeout always
  // wins so a long-polling page can't block the capture indefinitely.
  private waitForNetworkIdle(idleMs: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = Date.now()
      const tick = () => {
        if (!this.attached) return resolve()
        if (this.inflightCount === 0) return resolve()
        if (Date.now() - start >= timeoutMs) return resolve()
        setTimeout(tick, 100)
      }
      // Brief grace period before first check — gives the navigation a
      // chance to register its first request, so we don't fire immediately
      // on a transient zero.
      setTimeout(() => {
        if (this.inflightCount === 0) {
          setTimeout(() => {
            if (this.inflightCount === 0) resolve()
            else tick()
          }, idleMs)
        } else {
          tick()
        }
      }, 100)
    })
  }

  private lastScreenshotAt = 0

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
      // Deferred screenshot — wait for the page's network + render to
      // settle before snapping. The session_start screenshot at start()
      // captures the pre-nav state; this one captures the destination.
      this.scheduleScreenshotAfterLoad('navigation', details.url)
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
      // SPA route change — no onCommitted fires, so we own both the
      // snapshot AND the screenshot here. Same network-idle + login-aware
      // wait pipeline as a hard navigation.
      this.scheduleScreenshotAfterLoad('navigation', details.url)
      this.scheduleStorageStateCapture('navigation')
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
    this.inflightCount++
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
    this.decrementInflight()

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
    if (this.pendingRequests.has(params.requestId)) {
      this.pendingRequests.delete(params.requestId)
      this.decrementInflight()
    }
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

  private decrementInflight(): void {
    if (this.inflightCount > 0) this.inflightCount--
  }

  // Walks the page's current frame tree, fetches every resource the
  // page knows about via Page.getResourceContent, and synthesizes
  // request/response/body events so collectStaticAssets can pick them
  // up the same way as live captures. Crucial for capturing assets
  // that loaded BEFORE the recorder attached.
  private resourcesSeen = new Set<string>()
  private async captureExistingResources(phase: 'session_start' | 'session_end'): Promise<void> {
    if (!this.attached) return
    const target: chrome.debugger.Debuggee = { tabId: this.tabId }
    let tree: ResourceTreeResult
    try {
      tree = (await chrome.debugger.sendCommand(target, 'Page.getResourceTree', {})) as ResourceTreeResult
    } catch (e) {
      console.debug('[unwrap] Page.getResourceTree failed', e)
      return
    }
    const flat = flattenResources(tree.frameTree)
    let added = 0
    for (const r of flat) {
      if (this.resourcesSeen.has(r.url)) continue
      if (!isCaptureCandidate(r)) continue
      this.resourcesSeen.add(r.url)
      try {
        const resp = (await chrome.debugger.sendCommand(target, 'Page.getResourceContent', {
          frameId: r.frameId,
          url: r.url,
        })) as { content: string; base64Encoded: boolean } | undefined
        if (!resp || resp.content === undefined) continue
        const bytes = resp.base64Encoded
          ? Uint8Array.from(atob(resp.content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(resp.content)
        if (bytes.byteLength === 0) continue
        const mime = r.mimeType || guessMimeFromUrl(r.url)
        const blob = new Blob([bytes], { type: mime || 'application/octet-stream' })
        const ref = makeId('body')
        await putBlob(ref, this.sessionId, mime, blob)
        const fakeId = `resource-tree-${phase}-${ref}`
        const now = Date.now()
        const reqEvent: RequestEvent = {
          type: 'request',
          sessionId: this.sessionId,
          ts: now,
          requestId: fakeId,
          method: 'GET',
          url: r.url,
          headers: {},
          resourceType: r.type,
        }
        const respMeta: ResponseEvent = {
          type: 'response',
          sessionId: this.sessionId,
          ts: now,
          requestId: fakeId,
          status: 200,
          statusText: `from-resource-tree:${phase}`,
          url: r.url,
          headers: {},
          mimeType: mime,
          fromServiceWorker: false,
          fromDiskCache: true,
        }
        const respBody: ResponseEvent = {
          type: 'response',
          sessionId: this.sessionId,
          ts: now,
          requestId: fakeId,
          status: 0,
          statusText: 'body',
          url: r.url,
          headers: {},
          mimeType: mime,
          fromServiceWorker: false,
          fromDiskCache: true,
          bodyRef: ref,
          bodySize: bytes.byteLength,
        }
        await appendEvent(reqEvent)
        await appendEvent(respMeta)
        await appendEvent(respBody)
        await this.bumpCounts({ requests: 1, responses: 1 })
        added++
      } catch (e) {
        console.debug('[unwrap] Page.getResourceContent failed for', r.url, e)
      }
    }
    if (added > 0) console.info('[unwrap] captured', added, 'pre-existing resources at', phase)
  }
}

interface FrameResource {
  url: string
  type: string
  mimeType: string
  frameId: string
}

interface ResourceTreeFrame {
  frame: { id: string; parentId?: string; url: string }
  childFrames?: ResourceTreeFrame[]
  resources: { url: string; type: string; mimeType: string; failed?: boolean }[]
}

interface ResourceTreeResult {
  frameTree: ResourceTreeFrame
}

function flattenResources(tree: ResourceTreeFrame): FrameResource[] {
  const out: FrameResource[] = []
  const walk = (node: ResourceTreeFrame) => {
    const frameId = node.frame.id
    for (const r of node.resources ?? []) {
      if (r.failed) continue
      out.push({ url: r.url, type: r.type, mimeType: r.mimeType, frameId })
    }
    for (const child of node.childFrames ?? []) walk(child)
  }
  walk(tree)
  return out
}

function isCaptureCandidate(r: FrameResource): boolean {
  if (!r.url) return false
  if (r.url.startsWith('data:') || r.url.startsWith('blob:') || r.url.startsWith('chrome-extension:')) return false
  // Same filter as static-assets.ts isStaticAssetMime — accept text-ish
  // resources, skip media/binary that would just bloat the upload.
  const m = (r.mimeType || guessMimeFromUrl(r.url)).toLowerCase()
  if (!m) return false
  if (m.startsWith('text/')) return true
  if (m.includes('javascript')) return true
  if (m.includes('json')) return true
  if (m.includes('xml')) return true
  if (m.includes('svg')) return true
  if (m.includes('font') || m === 'application/vnd.ms-fontobject') return true
  if (m.startsWith('image/')) return true
  return false
}

function guessMimeFromUrl(url: string): string {
  const ext = (url.split('?')[0] || '').split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript', mjs: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    xml: 'application/xml',
  }
  return map[ext] ?? ''
}

// Heuristic — a storage state "looks logged in" if a cookie name or
// localStorage key matches the auth pattern. Intentionally loose to
// minimize false negatives; cost of a false positive is just an extra
// ~1.2s wait before the next screenshot.
function detectLoggedIn(event: StorageStateEvent): boolean {
  for (const c of event.cookies) if (AUTH_KEY_PATTERN.test(c.name)) return true
  for (const k of Object.keys(event.localStorage)) if (AUTH_KEY_PATTERN.test(k)) return true
  for (const k of Object.keys(event.sessionStorage)) if (AUTH_KEY_PATTERN.test(k)) return true
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
