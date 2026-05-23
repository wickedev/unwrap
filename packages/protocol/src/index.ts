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
    // Human-readable Playwright-style locator used in generated specs.
    primary: string
    // Flat key-value of fallback signals the replay tries in order.
    alternatives: Record<string, string | undefined>
    // Optional structured fields the replay needs beyond simple strings.
    role?: string
    roleName?: string
    // Open-shadow piercing path: each segment is a CSS selector inside
    // its shadow boundary, walked outermost → innermost.
    piercedCss?: string[]
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

// One per captured screenshot in the original session, at the recording's
// native viewport resolution. Used by the server to pixel-diff replay
// output step-by-step. The LLM-bound `screenshots` field is downsampled
// and not suitable here.
export interface VerifyScreenshotInline {
  // Extension-side ScreenshotEvent.ref, preserved end-to-end for KV keys.
  originalRef: string
  // Absolute timestamp (ms epoch) when the screenshot was captured.
  // Server converts to relative ms to match against replay step times.
  originalTs: number
  // URL active when the screenshot was taken (best-effort: nearest
  // preceding navigation in the event stream).
  url: string
  width: number
  height: number
  mediaType: string
  dataBase64: string
}

// Server-side metadata stored on StoredSession; the actual PNG bytes
// live in a separate KV entry (key `orig-<originalRef>`).
export interface VerifyScreenshotMeta {
  originalRef: string
  originalTs: number
  url: string
  width: number
  height: number
  storedRef: string
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
  // Metadata for every full-res captured screenshot the extension shipped.
  // Bytes live separately under storedRef (KV key `orig-<originalRef>`)
  // to keep the StoredSession JSON small.
  verifyScreenshotMeta?: VerifyScreenshotMeta[]
  generated?: GenerateResponse & { generatedAt: number }
  verification?: VerificationResult
}

export interface VerifyStep {
  index: number
  // 'initial' is a synthetic step for the post-goto state (before any action)
  actionType: SerializedAction['type'] | 'initial'
  selector: string
  url: string
  status: 'ok' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  screenshotRef?: string
  visualDiff?: VisualDiff
}

export interface VisualDiff {
  // Storage refs of the captured (original) PNG and the replay's PNG
  originalRef: string
  replayRef: string
  diffRef: string
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  diffRatio: number
  // Diagnostic — how far apart the matched screenshots were in
  // relative session time (helps explain unexpected drift)
  matchTimeDeltaMs?: number
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
  // each via /api/sessions/:id/screenshots/:ref. Diff PNGs and replay
  // screenshots are included here so the screenshot-serving endpoint
  // can validate authorized access.
  screenshotRefs: string[]
  // Set when the engine couldn't run any diffs (e.g. extension didn't
  // upload verify screenshots — old session, signed-out at capture, etc.)
  visualDiffMessage?: string
}

export interface GenerateForStoredSessionResponse extends GenerateResponse {
  sessionId: string
  generatedAt: number
}
