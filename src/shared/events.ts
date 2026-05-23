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
}

export interface ConsoleEvent extends BaseEvent {
  type: 'console'
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  args: string[]
}

export interface ExceptionEvent extends BaseEvent {
  type: 'exception'
  message: string
  stack?: string
  url?: string
  line?: number
}

export interface StorageStateEvent extends BaseEvent {
  type: 'storage_state'
  origin: string
  cookies: chrome.cookies.Cookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

export type RuntimeMessage =
  | { kind: 'start_session'; tabId: number }
  | { kind: 'stop_session'; sessionId: string }
  | { kind: 'list_sessions' }
  | { kind: 'get_session'; sessionId: string }
  | { kind: 'delete_session'; sessionId: string }
  | { kind: 'export_session'; sessionId: string; format: 'har' | 'json' }
  | { kind: 'capture_storage_state'; sessionId: string }
  | { kind: 'content_storage_state'; sessionId: string; origin: string; local: Record<string, string>; session: Record<string, string> }
