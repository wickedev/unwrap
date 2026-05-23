import type {
  ActionEvent,
  ClickEvent,
  ChangeEvent,
  InputEvent as UnwrapInputEvent,
  KeyEvent,
  NavigationEvent,
  SelectorSet,
  SessionEvent,
  SessionMeta,
  StorageStateEvent,
  SubmitEvent,
} from '@/shared/events'

const NAVIGATION_WAIT_MS = 500

export function generatePlaywrightScript(meta: SessionMeta, events: SessionEvent[]): string {
  const lines: string[] = []
  const storageState = pickInitialStorageState(events)

  lines.push("import { test, expect } from '@playwright/test'")
  lines.push('')

  if (storageState) {
    lines.push('// Storage state captured at session start — paste alongside this test.')
    lines.push(`const storageState = ${JSON.stringify(storageStateToPlaywright(storageState), null, 2)}`)
    lines.push('')
  }

  lines.push(`test('${escapeJs(testTitle(meta))}', async ({ browser }) => {`)
  if (storageState) {
    lines.push('  const context = await browser.newContext({')
    lines.push(`    viewport: { width: ${meta.viewport.width || 1280}, height: ${meta.viewport.height || 800} },`)
    lines.push('    storageState,')
    lines.push('  })')
  } else {
    lines.push('  const context = await browser.newContext({')
    lines.push(`    viewport: { width: ${meta.viewport.width || 1280}, height: ${meta.viewport.height || 800} },`)
    lines.push('  })')
  }
  lines.push('  const page = await context.newPage()')
  lines.push('')

  const filtered = filterActionable(events)
  let lastUrl: string | null = null

  for (const ev of filtered) {
    switch (ev.type) {
      case 'navigation': {
        if (ev.url === lastUrl) break
        if (ev.source === 'committed' && (!lastUrl || isMainNavigation(ev))) {
          lines.push(`  await page.goto(${jsString(ev.url)})`)
          lines.push(`  await page.waitForLoadState('networkidle').catch(() => {})`)
          lastUrl = ev.url
        }
        break
      }
      case 'click':
        lines.push(`  await ${locatorFor(ev.selectors)}.click(${clickOpts(ev)})`)
        break
      case 'input': {
        if (ev.redacted) {
          lines.push(`  // [REDACTED] sensitive input of length ${ev.valueLength}`)
          lines.push(`  await ${locatorFor(ev.selectors)}.fill(${jsString('REPLACE_ME')})`)
        } else if (ev.value != null) {
          lines.push(`  await ${locatorFor(ev.selectors)}.fill(${jsString(ev.value)})`)
        }
        break
      }
      case 'change': {
        if (ev.element.inputType === 'checkbox' || ev.element.inputType === 'radio') {
          const fn = ev.checked ? 'check' : 'uncheck'
          lines.push(`  await ${locatorFor(ev.selectors)}.${fn}()`)
        } else if (ev.value != null) {
          lines.push(`  await ${locatorFor(ev.selectors)}.selectOption(${jsString(ev.value)})`)
        }
        break
      }
      case 'submit':
        lines.push(`  await ${locatorFor(ev.selectors)}.evaluate((form) => (form as HTMLFormElement).submit())`)
        break
      case 'key':
        if (ev.key === 'Enter' && ev.selectors) {
          lines.push(`  await ${locatorFor(ev.selectors)}.press(${jsString(ev.key)})`)
        } else {
          lines.push(`  await page.keyboard.press(${jsString(ev.key)})`)
        }
        break
    }
    if (isNavigationProvoker(ev)) {
      lines.push(`  await page.waitForLoadState('networkidle').catch(() => {})`)
    }
  }

  lines.push('')
  lines.push('  await context.close()')
  lines.push('})')
  lines.push('')
  return lines.join('\n')
}

function pickInitialStorageState(events: SessionEvent[]): StorageStateEvent | undefined {
  return events.find(
    (e): e is StorageStateEvent => e.type === 'storage_state' && e.trigger === 'session_start',
  ) ?? events.find((e): e is StorageStateEvent => e.type === 'storage_state')
}

function storageStateToPlaywright(ss: StorageStateEvent): unknown {
  return {
    cookies: ss.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expirationDate ?? -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: normalizeSameSite(c.sameSite),
    })),
    origins: [
      {
        origin: ss.origin,
        localStorage: Object.entries(ss.localStorage).map(([name, value]) => ({ name, value })),
      },
    ],
  }
}

function normalizeSameSite(v: chrome.cookies.SameSiteStatus | undefined): 'Strict' | 'Lax' | 'None' {
  switch (v) {
    case 'strict':
      return 'Strict'
    case 'no_restriction':
      return 'None'
    case 'lax':
    case 'unspecified':
    default:
      return 'Lax'
  }
}

function filterActionable(events: SessionEvent[]): (ActionEvent | NavigationEvent)[] {
  const out: (ActionEvent | NavigationEvent)[] = []
  for (const e of events) {
    if (
      e.type === 'navigation' ||
      e.type === 'click' ||
      e.type === 'input' ||
      e.type === 'change' ||
      e.type === 'submit' ||
      e.type === 'key'
    ) {
      out.push(e)
    }
  }
  return out
}

function isMainNavigation(ev: NavigationEvent): boolean {
  return ev.frameId === '0' || ev.frameId === undefined
}

function isNavigationProvoker(ev: SessionEvent): boolean {
  if (ev.type === 'submit') return true
  if (ev.type === 'click') {
    const tag = (ev as ClickEvent).element.tag
    if (tag === 'a' || tag === 'button') return true
    if ((ev as ClickEvent).element.inputType === 'submit') return true
  }
  if (ev.type === 'key' && (ev as KeyEvent).key === 'Enter') return true
  return false
}

function locatorFor(sel: SelectorSet): string {
  if (sel.testId) {
    const m = sel.testId.match(/\[(?:data-test(?:id)?|data-qa|data-cy)="([^"]+)"\]/)
    if (m) return `page.getByTestId(${jsString(m[1]!)})`
    return `page.locator(${jsString(sel.testId)})`
  }
  if (sel.role && sel.roleName) {
    return `page.getByRole(${jsString(sel.role)}, { name: ${jsString(sel.roleName)} })`
  }
  if (sel.label) {
    return `page.getByLabel(${jsString(sel.label)})`
  }
  if (sel.placeholder) {
    return `page.getByPlaceholder(${jsString(sel.placeholder)})`
  }
  if (sel.role) {
    return `page.getByRole(${jsString(sel.role)})`
  }
  if (sel.text) {
    return `page.getByText(${jsString(sel.text)}, { exact: false })`
  }
  if (sel.css) {
    return `page.locator(${jsString(sel.css)})`
  }
  return 'page.locator(\'body\')'
}

function clickOpts(ev: ClickEvent): string {
  const opts: string[] = []
  if (ev.button === 2) opts.push("button: 'right'")
  else if (ev.button === 1) opts.push("button: 'middle'")
  const modifiers: string[] = []
  if (ev.modifiers.alt) modifiers.push("'Alt'")
  if (ev.modifiers.ctrl) modifiers.push("'Control'")
  if (ev.modifiers.meta) modifiers.push("'Meta'")
  if (ev.modifiers.shift) modifiers.push("'Shift'")
  if (modifiers.length) opts.push(`modifiers: [${modifiers.join(', ')}]`)
  return opts.length ? `{ ${opts.join(', ')} }` : ''
}

function testTitle(meta: SessionMeta): string {
  try {
    const u = new URL(meta.startUrl)
    return `recorded session — ${u.host}`
  } catch {
    return 'recorded session'
  }
}

function jsString(s: string): string {
  return JSON.stringify(s)
}

function escapeJs(s: string): string {
  return s.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n')
}

// satisfy strict ts about unused warning import-only helpers
void (NAVIGATION_WAIT_MS)
void ({} as UnwrapInputEvent)
void ({} as ChangeEvent)
void ({} as SubmitEvent)
