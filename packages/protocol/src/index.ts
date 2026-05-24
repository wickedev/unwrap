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
  significantResponses: { url: string; status: number; mimeType: string; ts?: number; method?: string }[]
  axTreeSummary: { url: string; nodeCount: number }[]
  domSnapshotSummary: { url: string; sizeBytes: number }[]
  // Captured HTTP requests filtered to API-shaped traffic (JSON/GraphQL/REST
  // verbs), with request + response bodies up to a per-call and total cap.
  // Powers the /sessions/:id/api inventory page.
  apiCalls?: ApiCall[]
  // Captured HTML / CSS / JS responses plus URL-only references for
  // image/font/binary assets. Powers the /sessions/:id/static.zip
  // mirror download.
  staticAssets?: StaticAsset[]
  // V8 precise coverage + CSS rule usage summary distilled from the
  // CoverageEvent at upload time. Reveals dead code per script/stylesheet.
  // Only present when the extension successfully collected coverage
  // (requires Profiler / CSS CDP domain access).
  coverage?: CoverageSummary
  // WebSocket channels opened during the session. Each channel groups its
  // observed frames into distinct message types (keyed by a JSON discriminator
  // when present) with per-type counts and inferred payload shapes.
  wsChannels?: WsChannel[]
  // Accessibility findings distilled from the captured CDP AX tree blobs
  // at upload time. One AccessibilityPageReport per URL we have an AX
  // tree for; finding types are stable strings ("button-no-name",
  // "image-no-alt", …) so the server can group them across pages.
  accessibility?: AccessibilityPageReport[]
}

export interface AccessibilityPageReport {
  url: string
  // Total reachable (non-ignored) nodes scanned.
  nodeCount: number
  findings: AccessibilityFinding[]
}

export interface AccessibilityFinding {
  // Stable key so the server can aggregate the same finding across pages.
  kind:
    | 'button-no-name'
    | 'link-no-name'
    | 'image-no-alt'
    | 'input-no-label'
    | 'aria-hidden-focusable'
    | 'heading-skip'
    | 'duplicate-aria-id'
  // Up to ~12 sample evidence strings — element role plus any short name
  // hint we could extract, optionally with index for disambiguation.
  evidence: string[]
  count: number
}

export interface WsChannel {
  url: string
  openedAt: number
  closedAt?: number
  sendCount: number
  recvCount: number
  // Bytes sent / received aggregated from frame payloadSize.
  sendBytes: number
  recvBytes: number
  messageTypes: WsMessageType[]
}

export interface WsMessageType {
  // Heuristic key extracted from the payload — first match wins on the
  // common discriminator fields: type, op, method, kind, command, event.
  // Falls back to '__opaque__' for non-JSON or shapeless payloads.
  key: string
  direction: 'send' | 'recv' | 'both'
  count: number
  bytes: number
  // Up to one captured payload preserved verbatim (truncated to ~2KB)
  // so the reader can sanity-check the inferred shape.
  sample?: string
  // TypeScript-flavored type literal inferred from up to 10 sample
  // payloads, same inference machine the REST inventory uses.
  inferredShape?: string
}

export interface CoverageSummary {
  jsUsedBytes: number
  jsTotalBytes: number
  cssUsedBytes: number
  cssTotalBytes: number
  // Per-file breakdown, ordered by descending totalBytes so the biggest
  // dead-code offenders are at the top. Capped to ~50 entries on upload.
  files: CoverageFile[]
}

export interface CoverageFile {
  url: string
  kind: 'js' | 'css'
  totalBytes: number
  usedBytes: number
}

export interface StaticAsset {
  url: string
  status: number
  mimeType: string
  // Bytes-on-the-wire (from response headers / blob size at capture).
  size: number
  // Text body for HTML / CSS / JS / SVG (truncated to ~200KB). Absent
  // when the asset was filtered out by mime (image/font/binary) or by
  // the per-session size budget.
  body?: string
  // True when this row is a URL-only reference because the bytes weren't
  // captured (binary assets like images/fonts).
  urlOnly?: boolean
}

export interface ApiCall {
  ts: number
  method: string
  url: string
  // Headers as captured, already redacted on the extension side.
  requestHeaders?: Record<string, string>
  // Raw request body (post data) — typically JSON, may be form-encoded.
  // Truncated to ~50KB.
  requestBody?: string
  status: number
  responseMimeType: string
  // Raw response body (UTF-8 decoded). Truncated to ~50KB; bodies that
  // aren't textual (image/font/binary) are dropped.
  responseBody?: string
  // Bytes-on-the-wire for the response body. Set even when responseBody
  // is dropped or truncated, so the UI can show the real size.
  responseSize?: number
  responseHeaders?: Record<string, string>
  // Quick GraphQL identification — operationName / operationType
  // extracted from the request body's JSON if present.
  graphql?: {
    operationType?: 'query' | 'mutation' | 'subscription'
    operationName?: string
    queryHash?: string
  }
  // Wall-clock duration in milliseconds from request issuance to the
  // response body being fully received. Optional because some sessions
  // (older captures, or hops where we never saw the matching response)
  // don't have it.
  latencyMs?: number
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
  // Pointer coordinates in viewport pixels at action time, plus the
  // viewport size, so the heatmap can render at any screenshot scale.
  // Currently only populated for click events. Older sessions won't have it.
  position?: {
    x: number
    y: number
    viewport: { w: number; h: number }
  }
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
  regressionLevel?: RegressionLevel
  regressionHeadline?: string
  regressionBaselineId?: string
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
  // Compact diff against the previous session of the same host, computed
  // at upload time and surfaced as a regression badge on the sessions list.
  regression?: RegressionSummary
  // Tab-capture video uploaded alongside the session. Bytes live in a
  // separate KV blob (key `video:<email>:<sessionId>`); this metadata
  // is what the session detail page reads to render the <video> tag.
  video?: {
    mimeType: string
    sizeBytes: number
    durationMs: number
    uploadedAt: number
  }
}

export type RegressionLevel = 'pass' | 'minor' | 'fail'

export interface RegressionSummary {
  baselineId: string
  baselineUploadedAt: number
  level: RegressionLevel
  actionsKept: number
  actionsAdded: number
  actionsRemoved: number
  consoleErrorDelta: number
  exceptionDelta: number
  networkOnlyInBaseline: number
  networkOnlyInCurrent: number
  networkStatusChanges: number
  finalUrlMatch: boolean
  // One-line summary fit for a badge tooltip
  headline: string
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

// Cross-session captured-screenshot diff produced when comparing two
// uploads of the same host. Lives on `SessionDiff.visual` (computed at
// page render time and cached under `cmp:<baseline>:<current>`).
export interface CrossSessionVisualDiff {
  // Stable cache key carrying both session ids, exposed so /sessions/
  // <id>/screenshots/<ref> can validate access.
  cacheKey: string
  pairs: CrossSessionVisualDiffPair[]
  // Pairs that could not be diffed (dimension mismatch, decode failure)
  // with a one-line reason.
  skipped: { baselineRef: string; currentRef: string; reason: string }[]
  // Sum across all pairs — quick at-a-glance change percentage.
  totals: { diffPixels: number; totalPixels: number; ratio: number }
}

export interface CrossSessionVisualDiffPair {
  baselineRef: string
  currentRef: string
  diffRef: string
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  diffRatio: number
  baselineUrl: string
  currentUrl: string
  matchTimeDeltaMs: number
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
