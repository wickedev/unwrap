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
  const candidates = buildLocatorCandidates(action)
  const deadline = Date.now() + PER_STEP_TIMEOUT_MS
  for (const candidate of candidates) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeout = Math.min(700, remaining)
    try {
      const handle = await waitForCandidate(page, candidate, timeout)
      if (handle) return handle
    } catch {
      // try next
    }
  }
  return null
}

type Candidate =
  | { kind: 'puppeteer'; value: string } // hand to page.waitForSelector
  | { kind: 'text'; value: string } // page.evaluateHandle — text/ engine breaks Workers V8 isolate
  | { kind: 'name'; value: string } // accessible-name walk

async function waitForCandidate(page: Page, c: Candidate, timeout: number) {
  if (c.kind === 'puppeteer') {
    return page.waitForSelector(c.value, { timeout })
  }
  if (c.kind === 'text') return queryByText(page, c.value, timeout)
  return queryByAccessibleName(page, c.value, timeout)
}

// Single page.evaluate computes a unique nth-of-type CSS path to the
// best-matching element, then page.$ promotes that path to a real
// puppeteer ElementHandle. Avoids the asElement() pitfall (where
// returning a DOM Element from evaluateHandle silently degrades to
// null) and keeps the per-locate work to one round-trip per attempt.
async function queryByText(page: Page, needle: string, timeoutMs: number) {
  const path = await page.evaluate(
    (n: string): string | null => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const G: any = (globalThis as unknown as Record<string, unknown>)
      const doc = G.document
      const lc = n.toLowerCase().trim()
      if (!lc || !doc?.body) return null
      const all = doc.querySelectorAll('body *')
      let best: unknown = null
      let bestArea = Number.POSITIVE_INFINITY
      for (let i = 0; i < all.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const el: any = all[i]
        const tag = el.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE') continue
        const t = String(el.textContent ?? '').toLowerCase().trim()
        if (!t || !t.includes(lc)) continue
        const rect = el.getBoundingClientRect()
        const area = rect.width * rect.height || Number.MAX_SAFE_INTEGER
        if (area < bestArea) {
          best = el
          bestArea = area
        }
      }
      if (!best) return null

      const segs: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cur: any = best
      while (cur && cur.parentElement) {
        const parent = cur.parentElement
        const same: unknown[] = []
        for (let k = 0; k < parent.children.length; k++) {
          if (parent.children[k].tagName === cur.tagName) same.push(parent.children[k])
        }
        const idx = same.indexOf(cur) + 1
        segs.unshift(`${String(cur.tagName).toLowerCase()}:nth-of-type(${idx})`)
        cur = parent
      }
      return segs.join(' > ')
    },
    needle,
  )
  if (!path) return null
  return page.waitForSelector(path, { timeout: timeoutMs })
}

async function queryByAccessibleName(page: Page, target: string, timeoutMs: number) {
  const path = await page.evaluate(
    (n: string): string | null => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const G: any = (globalThis as unknown as Record<string, unknown>)
      const doc = G.document
      const lc = n.toLowerCase().trim()
      if (!lc) return null
      const els = doc.querySelectorAll(
        'a, button, [role], input, select, textarea, summary, details, label',
      )
      for (let i = 0; i < els.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const el: any = els[i]
        const aria = String(el.getAttribute('aria-label') ?? '')
        const labelledBy = String(el.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id: string) => String(doc.getElementById(id)?.textContent ?? ''))
          .join(' ')
        const imgAlt = el.tagName === 'IMG' ? String(el.alt ?? '') : ''
        let labels = ''
        if (el.labels && typeof el.labels.length === 'number') {
          const acc: string[] = []
          for (let j = 0; j < el.labels.length; j++) acc.push(String(el.labels[j].textContent ?? ''))
          labels = acc.join(' ')
        }
        const textContent = String(el.textContent ?? '').trim()
        const candidate = [aria, labelledBy, imgAlt, labels, textContent].join(' ').toLowerCase()
        if (candidate.includes(lc)) return cssPathTo(el as unknown)
      }
      return null

      function cssPathTo(node: unknown): string {
        const segs: string[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cur: any = node
        while (cur && cur.parentElement) {
          const parent = cur.parentElement
          const same: unknown[] = []
          for (let k = 0; k < parent.children.length; k++) {
            if (parent.children[k].tagName === cur.tagName) same.push(parent.children[k])
          }
          const idx = same.indexOf(cur) + 1
          segs.unshift(`${String(cur.tagName).toLowerCase()}:nth-of-type(${idx})`)
          cur = parent
        }
        return segs.join(' > ')
      }
    },
    target,
  )
  if (!path) return null
  return page.waitForSelector(path, { timeout: timeoutMs })
}


// Build an ordered list of locator candidates. We split between native
// puppeteer selectors (CSS / `pierce/...`) and in-page evaluate paths
// (name / text). Puppeteer's `text/` engine can't run on Cloudflare
// Workers (V8 isolate blocks `new Function()`), and `aria/` here didn't
// match — so we fall back to our own page.evaluate walk for both.
function buildLocatorCandidates(action: SerializedAction): Candidate[] {
  const out: Candidate[] = []
  const sel = action.selector
  const alt = sel.alternatives

  // 1. data-* test attributes
  const testId = alt.testId as string | undefined
  if (testId) {
    const m = testId.match(/\[(?:data-test(?:id)?|data-qa|data-cy)="([^"]+)"\]/)
    if (m) {
      const val = m[1]!
      pup(out, `[data-testid="${val}"]`)
      pup(out, `[data-test="${val}"]`)
      pup(out, `[data-qa="${val}"]`)
      pup(out, `[data-cy="${val}"]`)
      pup(out, `pierce/[data-testid="${val}"]`)
    } else {
      pup(out, testId)
    }
  }

  // 2. ARIA accessible name — our own page.evaluate walk (handles
  //    open shadow via querySelectorAll; closed shadow is unreachable
  //    from page JS by definition).
  if (sel.roleName) {
    name(out, sel.roleName)
  }

  // 3. label / placeholder
  const label = alt.label as string | undefined
  if (label && label !== sel.roleName) {
    name(out, label)
  }
  const placeholder = alt.placeholder as string | undefined
  if (placeholder) {
    pup(out, `[placeholder="${escAttr(placeholder)}"]`)
    pup(out, `pierce/[placeholder="${escAttr(placeholder)}"]`)
  }

  // 4. visible text
  const txt = alt.text as string | undefined
  if (txt && txt.length <= 60) {
    text(out, txt)
  }

  // 5. captured CSS path
  const css = alt.css as string | undefined
  if (css) {
    pup(out, css)
    pup(out, `pierce/${css}`)
  }

  // 6. captured shadow-piercing path
  if (sel.piercedCss && sel.piercedCss.length > 0) {
    const last = sel.piercedCss[sel.piercedCss.length - 1]
    if (last) pup(out, `pierce/${last}`)
  }

  return dedupeCandidates(out)
}

function pup(out: Candidate[], value: string): void {
  out.push({ kind: 'puppeteer', value })
}
function name(out: Candidate[], value: string): void {
  out.push({ kind: 'name', value })
}
function text(out: Candidate[], value: string): void {
  out.push({ kind: 'text', value })
}

function escAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function dedupeCandidates(xs: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const x of xs) {
    const key = `${x.kind}:${x.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
  }
  return out
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
