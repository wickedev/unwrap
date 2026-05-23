import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer'
import type {
  SerializedAction,
  StoredSession,
  VerificationResult,
  VerifyStep,
} from '@unwrap/protocol'
import type { Env } from './env'
import { getScreenshot, putScreenshot } from './storage/sessions'
import { diffEndState } from './pixeldiff'

const PER_STEP_TIMEOUT_MS = 8_000
const POST_ACTION_WAIT_MS = 250
const MAX_STEPS = 50

export async function verifySession(env: Env, email: string, session: StoredSession): Promise<VerificationResult> {
  if (!env.BROWSER) {
    return errorResult('Browser Rendering not available in this environment')
  }
  const startedAt = Date.now()
  const startUrl = session.summary.meta.url

  // Match the original capture's viewport when we have a verify screenshot
  // we can diff against, so pixelmatch doesn't bail out on dimension drift.
  const verifyFinal = session.verifyScreenshotMeta?.find((m) => m.position === 'final')
  const viewport = verifyFinal
    ? { width: verifyFinal.width, height: verifyFinal.height }
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

    // 1. Land on the start URL.
    try {
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: PER_STEP_TIMEOUT_MS })
    } catch (e) {
      return errorResult(`Failed to navigate to ${startUrl}: ${asMessage(e)}`)
    }

    // 2. Walk the action trace, screenshot each step.
    const steps: VerifyStep[] = []
    const screenshotRefs: string[] = []
    const actions = session.summary.actions.slice(0, MAX_STEPS)

    // initial screenshot
    const initialRef = `verify-${session.id}-init`
    await captureScreenshot(env, email, session.id, initialRef, page)
    screenshotRefs.push(initialRef)

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
          await captureScreenshot(env, email, session.id, ref, page)
          step.screenshotRef = ref
          screenshotRefs.push(ref)
        } catch (e) {
          step.message = `screenshot failed: ${asMessage(e)}`
        }
      } else if (step.status === 'failed') {
        // Stop replay on first failure — downstream selectors usually don't make sense.
        break
      }
    }

    // Final screenshot — kept in memory so we can pixel-diff against the
    // captured 'final' verify screenshot without re-encoding from KV.
    const finalRef = `verify-${session.id}-final`
    const finalBytesView = (await page.screenshot({ type: 'png', fullPage: false })) as Uint8Array
    const finalBytes = finalBytesView.buffer.slice(
      finalBytesView.byteOffset,
      finalBytesView.byteOffset + finalBytesView.byteLength,
    ) as ArrayBuffer
    await putScreenshot(env, email, session.id, finalRef, finalBytes)
    screenshotRefs.push(finalRef)

    const finalUrl = page.url()
    await browser.close()
    browser = null

    let visualDiff: VerificationResult['visualDiff']
    let visualDiffMessage: string | undefined
    if (verifyFinal) {
      const originalBytes = await getScreenshot(env, email, session.id, verifyFinal.ref)
      if (originalBytes) {
        const result = await diffEndState({
          env,
          email,
          sessionId: session.id,
          originalRef: verifyFinal.ref,
          originalBytes,
          replayRef: finalRef,
          replayBytes: finalBytes,
        })
        if (result.diff) {
          visualDiff = result.diff
          screenshotRefs.push(result.diff.diffRef)
        }
        if (result.message) visualDiffMessage = result.message
      } else {
        visualDiffMessage = 'captured final screenshot has expired from storage'
      }
    } else {
      visualDiffMessage = 'no captured final screenshot to diff against'
    }

    const passedSteps = steps.filter((s) => s.status === 'ok').length
    return {
      ranAt: startedAt,
      durationMs: Date.now() - startedAt,
      passed: passedSteps === actions.length && actions.length > 0,
      passedSteps,
      totalSteps: actions.length,
      steps,
      finalUrl,
      screenshotRefs,
      ...(visualDiff ? { visualDiff } : {}),
      ...(visualDiffMessage ? { visualDiffMessage } : {}),
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
        // We don't pull in DOM lib types here — submit lives on the form node
        // at runtime; trust puppeteer's evaluation to typecheck the body.
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

  // Try data-testid attribute selectors first if available.
  if (testId) {
    const m = testId.match(/\[(?:data-test(?:id)?|data-qa|data-cy)="([^"]+)"\]/)
    if (m) candidates.push(`[data-testid="${m[1]}"]`, `[data-test="${m[1]}"]`, testId)
    else candidates.push(testId)
  }
  // Fall back to the captured CSS path.
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

async function captureScreenshot(
  env: Env,
  email: string,
  sessionId: string,
  ref: string,
  page: Page,
): Promise<void> {
  const data = (await page.screenshot({ type: 'png', fullPage: false })) as Uint8Array
  // Ensure we hand KV a proper ArrayBuffer.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  await putScreenshot(env, email, sessionId, ref, buf)
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
