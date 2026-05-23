export type ISO = string

export interface SessionMeta {
  id: string
  createdAt: number
  startedAt: number
  endedAt?: number
  tabId: number
  startUrl: string
  userAgent: string
  viewport: { width: number; height: number }
  devicePixelRatio: number
  timezone: string
  locale: string
  status: 'recording' | 'stopped' | 'error'
  error?: string
  counts: {
    requests: number
    responses: number
    screenshots: number
    navigations: number
    actions: number
    storageStates: number
    consoleMessages: number
    exceptions: number
    wsFrames: number
    domSnapshots: number
    axTrees: number
  }
}

export type SessionEvent =
  | NavigationEvent
  | RequestEvent
  | ResponseEvent
  | RequestFailedEvent
  | ScreenshotEvent
  | ConsoleEvent
  | ExceptionEvent
  | StorageStateEvent
  | ClickEvent
  | InputEvent
  | ChangeEvent
  | SubmitEvent
  | KeyEvent
  | WebSocketCreatedEvent
  | WebSocketFrameEvent
  | WebSocketClosedEvent
  | DomSnapshotEvent
  | AxTreeEvent
  | CoverageEvent

interface BaseEvent {
  sessionId: string
  ts: number
  frameId?: string
}

export interface NavigationEvent extends BaseEvent {
  type: 'navigation'
  url: string
  transitionType?: string
  source: 'committed' | 'history_state'
}

export interface RequestEvent extends BaseEvent {
  type: 'request'
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
  resourceType?: string
  initiator?: unknown
}

export interface ResponseEvent extends BaseEvent {
  type: 'response'
  requestId: string
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  mimeType: string
  fromServiceWorker: boolean
  fromDiskCache: boolean
  bodyRef?: string
  bodySize?: number
  encodedDataLength?: number
}

export interface RequestFailedEvent extends BaseEvent {
  type: 'request_failed'
  requestId: string
  errorText: string
  canceled: boolean
}

export interface ScreenshotEvent extends BaseEvent {
  type: 'screenshot'
  ref: string
  reason: 'navigation' | 'manual' | 'interval'
  viewport: { width: number; height: number }
  fullPage: boolean
}

export interface ConsoleEvent extends BaseEvent {
  type: 'console'
  level: 'log' | 'info' | 'warning' | 'error' | 'debug' | 'dir' | 'dirxml' | 'table' | 'trace' | 'clear' | 'startGroup' | 'startGroupCollapsed' | 'endGroup' | 'assert' | 'profile' | 'profileEnd' | 'count' | 'timeEnd'
  args: string[]
  stackUrl?: string
  stackLine?: number
}

export interface ExceptionEvent extends BaseEvent {
  type: 'exception'
  message: string
  stack?: string
  url?: string
  line?: number
  column?: number
}

export interface WebSocketCreatedEvent extends BaseEvent {
  type: 'ws_created'
  requestId: string
  url: string
  initiator?: unknown
}

export interface WebSocketFrameEvent extends BaseEvent {
  type: 'ws_frame'
  requestId: string
  direction: 'send' | 'recv'
  opcode: number
  payloadData: string
  payloadSize: number
  mask: boolean
}

export interface WebSocketClosedEvent extends BaseEvent {
  type: 'ws_closed'
  requestId: string
}

export interface DomSnapshotEvent extends BaseEvent {
  type: 'dom_snapshot'
  ref: string
  url: string
  sizeBytes: number
}

export interface AxTreeEvent extends BaseEvent {
  type: 'ax_tree'
  ref: string
  url: string
  nodeCount: number
}

export interface CoverageEvent extends BaseEvent {
  type: 'coverage'
  ref: string
  jsScriptCount: number
  cssStylesheetCount: number
  jsUsedBytes: number
  jsTotalBytes: number
  cssUsedBytes: number
  cssTotalBytes: number
}

export interface StorageStateEvent extends BaseEvent {
  type: 'storage_state'
  origin: string
  cookies: chrome.cookies.Cookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
  trigger: 'manual' | 'session_start' | 'navigation'
}

export interface SelectorSet {
  testId?: string
  role?: string
  roleName?: string
  text?: string
  label?: string
  placeholder?: string
  css?: string
  xpath?: string
  piercedCss?: string[]
}

export interface ElementInfo {
  tag: string
  type?: string
  name?: string
  inputType?: string
  isContentEditable?: boolean
  visibleText?: string
  href?: string
}

export interface ClickEvent extends BaseEvent {
  type: 'click'
  selectors: SelectorSet
  element: ElementInfo
  button: number
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
  url: string
}

export interface InputEvent extends BaseEvent {
  type: 'input'
  selectors: SelectorSet
  element: ElementInfo
  redacted: boolean
  value?: string
  valueLength: number
  url: string
}

export interface ChangeEvent extends BaseEvent {
  type: 'change'
  selectors: SelectorSet
  element: ElementInfo
  redacted: boolean
  value?: string
  checked?: boolean
  url: string
}

export interface SubmitEvent extends BaseEvent {
  type: 'submit'
  selectors: SelectorSet
  formAction?: string
  url: string
}

export interface KeyEvent extends BaseEvent {
  type: 'key'
  key: string
  code: string
  selectors?: SelectorSet
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
  url: string
}

export type ActionEvent = ClickEvent | InputEvent | ChangeEvent | SubmitEvent | KeyEvent

export type RuntimeMessage =
  | { kind: 'start_session'; tabId: number }
  | { kind: 'stop_session'; sessionId: string }
  | { kind: 'list_sessions' }
  | { kind: 'get_session'; sessionId: string }
  | { kind: 'delete_session'; sessionId: string }
  | { kind: 'export_session'; sessionId: string; format: 'har' | 'json' | 'playwright' }
  | { kind: 'capture_storage_state'; sessionId: string; trigger?: 'manual' | 'session_start' | 'navigation' }
  | {
      kind: 'content_storage_state'
      sessionId: string
      origin: string
      local: Record<string, string>
      session: Record<string, string>
      trigger: 'manual' | 'session_start' | 'navigation'
    }
  | { kind: 'is_recording'; tabId?: number }
  | { kind: 'action_event'; event: ActionEvent }
  | { kind: 'get_settings' }
  | { kind: 'set_settings'; patch: Partial<import('./settings').UnwrapSettings> }
  | { kind: 'generate_ai_test'; sessionId: string }
