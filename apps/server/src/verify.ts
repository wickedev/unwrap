import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer'
import type {
  SerializedAction,
  StoredSession,
  VerificationResult,
  VerifyScreenshotMeta,
  VerifyStep,
  VisualDiff,
} from '@unwrap/protocol'
import type { Env } from './env'
import { getScreenshot, putScreenshot } from './storage/sessions'
import { diffPng } from './pixeldiff'

const PER_STEP_TIMEOUT_MS = 8_000
const POST_ACTION_WAIT_MS = 250
const MAX_STEPS = 50

export async function verifySession(env: Env, email: string, session: StoredSession): Promise<VerificationResult> {
  if (!env.BROWSER) {
    return errorResult('Browser Rendering not available in this environment')
  }
  const startedAt = Date.now()
  const startUrl = session.summary.meta.url
  const sessionStartedAt = new Date(session.summary.meta.startedAt).getTime()
  const captured = (session.verifyScreenshotMeta ?? [])
    .slice()
    .sort((a, b) => a.originalTs - b.originalTs)
  const usedCaptured = new Set<string>()

  // Resolve dimensions for puppeteer's viewport — prefer the captured size
  // so pixelmatch doesn't bail on dimension drift.
  const viewport = captured[0]
    ? { width: captured[0].width, height: captured[0].height }
    : session.summary.meta.viewport

  let browser: Browser | null = null
  try {
    browser = await puppeteer.launch(env.BROWSER)
    const page = await browser.newPage()
    await page.setViewport({
      width: viewport.width || 1280,
      height: viewport.height || 800,
      deviceScaleFactor: 1,
    })

    try {
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: PER_STEP_TIMEOUT_MS })
    } catch (e) {
      return errorResult(`Failed to navigate to ${startUrl}: ${asMessage(e)}`)
    }

    const steps: VerifyStep[] = []
    const screenshotRefs: string[] = []

    // ---- Synthetic step 0: initial state (post-goto, no action) ----
    const initialStep: VerifyStep = {
      index: -1,
      actionType: 'initial',
      selector: startUrl,
      url: startUrl,
      status: 'ok',
      durationMs: 0,
    }
    const initialRef = `verify-${session.id}-init`
    const initialBytes = await takeScreenshot(page, env, email, session.id, initialRef)
    initialStep.screenshotRef = initialRef
    screenshotRefs.push(initialRef)
    const initialDiff = await tryDiff({
      env,
      email,
      sessionId: session.id,
      replayRef: initialRef,
      replayBytes: initialBytes,
      stepRelativeMs: 0,
      captured,
      usedCaptured,
    })
    if (initialDiff) {
      initialStep.visualDiff = initialDiff
      screenshotRefs.push(initialDiff.diffRef)
    }
    steps.push(initialStep)

    // ---- Replay actions ----
    const actions = session.summary.actions.slice(0, MAX_STEPS)
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!
      const step = await runStep(page, action, i)
      steps.push(step)

      if (step.status === 'ok') {
        try {
          await page.waitForNetworkIdle({ idleTime: POST_ACTION_WAIT_MS, timeout: PER_STEP_TIMEOUT_MS })
        } catch {
          // best-effort
        }
        const ref = `verify-${session.id}-step-${i}`
        try {
          const bytes = await takeScreenshot(page, env, email, session.id, ref)
          step.screenshotRef = ref
          screenshotRefs.push(ref)
          const stepRelativeMs = sessionStartedAt > 0 ? action.ts - sessionStartedAt : action.ts
          const diff = await tryDiff({
            env,
            email,
            sessionId: session.id,
            replayRef: ref,
            replayBytes: bytes,
            stepRelativeMs,
            captured,
            usedCaptured,
          })
          if (diff) {
            step.visualDiff = diff
            screenshotRefs.push(diff.diffRef)
          }
        } catch (e) {
          step.message = `screenshot failed: ${asMessage(e)}`
        }
      } else if (step.status === 'failed') {
        // First failure stops the replay — downstream selectors usually
        // don't make sense once the page is in an unexpected state.
        break
      }
    }

    const finalUrl = page.url()
    await browser.close()
    browser = null

    const totalActions = actions.length
    const passedSteps = steps.filter((s) => s.actionType !== 'initial' && s.status === 'ok').length
    const passed = totalActions > 0 ? passedSteps === totalActions : true

    return {
      ranAt: startedAt,
      durationMs: Date.now() - startedAt,
      passed,
      passedSteps,
      totalSteps: totalActions,
      steps,
      finalUrl,
      screenshotRefs,
      ...(captured.length === 0
        ? { visualDiffMessage: 'No captured screenshots uploaded for this session — re-record to enable visual diff.' }
        : {}),
    }
  } catch (e) {
    return errorResult(`Replay crashed: ${asMessage(e)}`)
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        // ignore
      }
    }
  }
}

interface DiffArgs {
  env: Env
  email: string
  sessionId: string
  replayRef: string
  replayBytes: ArrayBuffer
  stepRelativeMs: number
  captured: VerifyScreenshotMeta[]
  usedCaptured: Set<string>
}

async function tryDiff(args: DiffArgs): Promise<VisualDiff | null> {
  if (args.captured.length === 0) return null
  // Pick the captured shot whose relative timestamp is closest to the
  // step's relative timestamp, with a slight preference for "next after"
  // (so initial state matches the first captured shot, etc).
  const sessionStart = args.captured[0]!.originalTs
  let best: VerifyScreenshotMeta | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const c of args.captured) {
    if (args.usedCaptured.has(c.storedRef)) continue
    const relTs = c.originalTs - sessionStart
    const delta = Math.abs(relTs - args.stepRelativeMs)
    if (delta < bestDelta) {
      bestDelta = delta
      best = c
    }
  }
  if (!best) return null

  const originalBytes = await getScreenshot(args.env, args.email, args.sessionId, best.storedRef)
  if (!originalBytes) return null

  const diffRef = `verify-${args.sessionId}-${args.replayRef.split('-').pop()}-diff`
  const result = diffPng({
    originalBytes,
    replayBytes: args.replayBytes,
  })
  if (!result) return null

  await putScreenshot(args.env, args.email, args.sessionId, diffRef, result.diffPng)
  args.usedCaptured.add(best.storedRef)

  return {
    originalRef: best.storedRef,
    replayRef: args.replayRef,
    diffRef,
    width: result.width,
    height: result.height,
    diffPixels: result.diffPixels,
    totalPixels: result.totalPixels,
    diffRatio: result.totalPixels > 0 ? result.diffPixels / result.totalPixels : 0,
    matchTimeDeltaMs: bestDelta,
  }
}

async function takeScreenshot(
  page: Page,
  env: Env,
  email: string,
  sessionId: string,
  ref: string,
): Promise<ArrayBuffer> {
  const view = (await page.screenshot({ type: 'png', fullPage: false })) as Uint8Array
  const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  await putScreenshot(env, email, sessionId, ref, buf)
  return buf
}

async function runStep(page: Page, action: SerializedAction, index: number): Promise<VerifyStep> {
  const startedAt = Date.now()
  const cssSelector = (action.selector.alternatives.css as string | undefined) ?? null
  const base: VerifyStep = {
    index,
    actionType: action.type,
    selector: action.selector.primary,
    url: action.url,
    status: 'skipped',
    durationMs: 0,
  }

  try {
    switch (action.type) {
      case 'click': {
        const handle = await locate(page, action)
        if (!handle) return fail(base, 'element not found', startedAt)
        await handle.click({ delay: 30 })
        return ok(base, startedAt)
      }
      case 'input': {
        const value = (action.details.value as string | undefined) ?? ''
        const redacted = action.details.redacted as boolean | undefined
        if (redacted) {
          return skip(base, 'redacted input — manual fill required', startedAt)
        }
        const handle = await locate(page, action)
        if (!handle) return fail(base, 'element not found', startedAt)
        await handle.focus()
        await page.keyboard.down('Meta')
        await page.keyboard.press('A')
        await page.keyboard.up('Meta')
        await page.keyboard.press('Backspace')
        await handle.type(value, { delay: 5 })
        return ok(base, startedAt)
      }
      case 'change': {
        const inputType = action.details.inputType as string | undefined
        if (inputType === 'checkbox' || inputType === 'radio') {
          const handle = await locate(page, action)
          if (!handle) return fail(base, 'element not found', startedAt)
          await handle.click({ delay: 20 })
          return ok(base, startedAt)
        }
        if (cssSelector && action.details.value != null) {
          await page.select(cssSelector, String(action.details.value))
          return ok(base, startedAt)
        }
        return skip(base, 'unhandled change variant', startedAt)
      }
      case 'submit': {
        const handle = await locate(page, action)
        if (!handle) return fail(base, 'form not found', startedAt)
        await handle.evaluate((form: unknown) => (form as { submit: () => void }).submit())
        return ok(base, startedAt)
      }
      case 'key': {
        const key = action.details.key as string
        await page.keyboard.press(key as never)
        return ok(base, startedAt)
      }
      default:
        return skip(base, `unhandled action type: ${action.type}`, startedAt)
    }
  } catch (e) {
    return fail(base, asMessage(e), startedAt)
  }
}

async function locate(page: Page, action: SerializedAction) {
  const candidates: string[] = []
  const alt = action.selector.alternatives
  const testId = alt.testId as string | undefined
  const css = alt.css as string | undefined

  if (testId) {
    const m = testId.match(/\[(?:data-test(?:id)?|data-qa|data-cy)="([^"]+)"\]/)
    if (m) candidates.push(`[data-testid="${m[1]}"]`, `[data-test="${m[1]}"]`, testId)
    else candidates.push(testId)
  }
  if (css) candidates.push(css)

  for (const sel of candidates) {
    try {
      const handle = await page.waitForSelector(sel, { visible: true, timeout: 2_000 })
      if (handle) return handle
    } catch {
      // try next
    }
  }
  return null
}

function ok(step: VerifyStep, startedAt: number): VerifyStep {
  step.status = 'ok'
  step.durationMs = Date.now() - startedAt
  return step
}

function fail(step: VerifyStep, message: string, startedAt: number): VerifyStep {
  step.status = 'failed'
  step.message = message
  step.durationMs = Date.now() - startedAt
  return step
}

function skip(step: VerifyStep, message: string, startedAt: number): VerifyStep {
  step.status = 'skipped'
  step.message = message
  step.durationMs = Date.now() - startedAt
  return step
}

function errorResult(message: string): VerificationResult {
  return {
    ranAt: Date.now(),
    durationMs: 0,
    passed: false,
    passedSteps: 0,
    totalSteps: 0,
    steps: [],
    screenshotRefs: [],
    errorBeforeStart: message,
  }
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
