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

// Two checkpoint screenshots (initial + final) kept at the recording's
// native viewport resolution. Used for pixel-diffing replay output
// against captured state — the LLM-bound `screenshots` are
// downsampled and not suitable for diffs.
export interface VerifyScreenshotInline {
  position: 'initial' | 'final'
  width: number
  height: number
  mediaType: string
  dataBase64: string
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
  verifyScreenshots?: VerifyScreenshotInline[]
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
  verificationStatus?: 'pass' | 'fail' | 'error'
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
  // Metadata for full-res checkpoint screenshots; the PNG bytes live in
  // a separate KV entry (orig-<position>) to keep the StoredSession JSON small.
  verifyScreenshotMeta?: { position: 'initial' | 'final'; width: number; height: number; ref: string }[]
  generated?: GenerateResponse & { generatedAt: number }
  verification?: VerificationResult
}

export interface VerifyStep {
  index: number
  actionType: SerializedAction['type']
  selector: string
  url: string
  status: 'ok' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  screenshotRef?: string
}

export interface VisualDiff {
  position: 'final'
  originalRef: string
  replayRef: string
  diffRef: string
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  diffRatio: number
}

export interface VerificationResult {
  ranAt: number
  durationMs: number
  passed: boolean
  passedSteps: number
  totalSteps: number
  steps: VerifyStep[]
  finalUrl?: string
  errorBeforeStart?: string
  // Stored under the same session record as opaque refs; web UI fetches
  // each via /api/sessions/:id/screenshots/:ref
  screenshotRefs: string[]
  visualDiff?: VisualDiff
  visualDiffMessage?: string
}

export interface GenerateForStoredSessionResponse extends GenerateResponse {
  sessionId: string
  generatedAt: number
}
