// Wire protocol shared between @unwrap/extension and @unwrap/server.
// Only put types here that cross the network — keep extension-internal types
// (CDP, IndexedDB schema, etc.) in the extension package.

export interface SessionSummary {
  meta: {
    url: string
    host: string
    viewport: { width: number; height: number }
    locale: string
    timezone: string
    startedAt: string
    durationMs: number
    counts: Record<string, number>
  }
  navigations: { ts: number; url: string; source: string }[]
  actions: SerializedAction[]
  storageState: SerializedStorageState | null
  consoleErrors: { ts: number; message: string }[]
  exceptions: { ts: number; message: string; stack?: string }[]
  significantResponses: { url: string; status: number; mimeType: string }[]
  axTreeSummary: { url: string; nodeCount: number }[]
  domSnapshotSummary: { url: string; sizeBytes: number }[]
}

export interface SerializedAction {
  type: 'click' | 'input' | 'change' | 'submit' | 'key'
  ts: number
  url: string
  selector: {
    primary: string
    alternatives: Record<string, string | undefined>
  }
  details: Record<string, unknown>
}

export interface SerializedStorageState {
  origin: string
  localStorageKeys: string[]
  sessionStorageKeys: string[]
  cookies: { name: string; domain: string }[]
}

export interface ScreenshotInline {
  ts: number
  reason: string
  mediaType: string
  dataBase64: string
}

export interface GenerateRequest {
  sessionId: string
  summary: SessionSummary
  fallbackSpec: string
  screenshots: ScreenshotInline[]
}

export interface GenerateResponse {
  spec: string
  description: string
  assertionsAdded: number
  warnings: string[]
  model: string
  usage: {
    promptTokens: number
    candidatesTokens: number
    totalTokens: number
  }
}

export interface ErrorResponse {
  error: string
  detail?: string
}

export interface AuthStartResponse {
  authUrl: string
  state: string
}

export interface AuthTokenResponse {
  token: string
  email: string
  expiresAt: number
}

export interface MeResponse {
  email: string
  expiresAt: number
}

// ---------- Session upload + retrieval ----------

export interface UploadSessionRequest {
  // Local extension-side id, preserved for cross-referencing
  clientSessionId: string
  summary: SessionSummary
  fallbackSpec: string
  screenshots: ScreenshotInline[]
}

export interface UploadSessionResponse {
  id: string
  url: string
}

export interface SessionListItem {
  id: string
  host: string
  startUrl: string
  startedAt: string
  durationMs: number
  uploadedAt: number
  hasGeneratedSpec: boolean
}

export interface SessionListResponse {
  sessions: SessionListItem[]
}

export interface StoredSession {
  id: string
  email: string
  uploadedAt: number
  clientSessionId: string
  summary: SessionSummary
  fallbackSpec: string
  screenshots: ScreenshotInline[]
  generated?: GenerateResponse & { generatedAt: number }
}

export interface GenerateForStoredSessionResponse extends GenerateResponse {
  sessionId: string
  generatedAt: number
}
