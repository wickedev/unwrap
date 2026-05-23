import type {
  SerializedAction,
  SerializedStorageState,
  SessionSummary,
} from '@unwrap/protocol'
import type {
  ActionEvent,
  AxTreeEvent,
  ChangeEvent as UnwrapChangeEvent,
  ClickEvent,
  ConsoleEvent,
  DomSnapshotEvent,
  ExceptionEvent,
  InputEvent as UnwrapInputEvent,
  KeyEvent,
  NavigationEvent,
  ResponseEvent,
  SelectorSet,
  SessionEvent,
  SessionMeta,
  StorageStateEvent,
  SubmitEvent as UnwrapSubmitEvent,
} from '@/shared/events'

export function summarizeSession(meta: SessionMeta, events: SessionEvent[]): SessionSummary {
  let host = ''
  try {
    host = new URL(meta.startUrl).host
  } catch {
    // ignore
  }

  const navigations: SessionSummary['navigations'] = []
  const actions: SerializedAction[] = []
  const consoleErrors: SessionSummary['consoleErrors'] = []
  const exceptions: SessionSummary['exceptions'] = []
  const significantResponses: SessionSummary['significantResponses'] = []
  const axTreeSummary: SessionSummary['axTreeSummary'] = []
  const domSnapshotSummary: SessionSummary['domSnapshotSummary'] = []
  let storageState: SerializedStorageState | null = null

  for (const ev of events) {
    switch (ev.type) {
      case 'navigation': {
        const n = ev as NavigationEvent
        navigations.push({ ts: n.ts, url: n.url, source: n.source })
        break
      }
      case 'click':
      case 'input':
      case 'change':
      case 'submit':
      case 'key':
        actions.push(serializeAction(ev as ActionEvent))
        break
      case 'console':
        if ((ev as ConsoleEvent).level === 'error') {
          consoleErrors.push({
            ts: ev.ts,
            message: (ev as ConsoleEvent).args.join(' ').slice(0, 400),
          })
        }
        break
      case 'exception': {
        const e = ev as ExceptionEvent
        exceptions.push({
          ts: ev.ts,
          message: e.message.slice(0, 400),
          ...(e.stack ? { stack: e.stack.slice(0, 800) } : {}),
        })
        break
      }
      case 'response': {
        const r = ev as ResponseEvent
        if (!r.bodyRef && r.status && (r.status >= 400 || /\/api\/|\/graphql/.test(r.url))) {
          significantResponses.push({ url: r.url, status: r.status, mimeType: r.mimeType })
        }
        break
      }
      case 'storage_state': {
        const s = ev as StorageStateEvent
        if (!storageState || s.trigger === 'session_start') {
          storageState = {
            origin: s.origin,
            localStorageKeys: Object.keys(s.localStorage),
            sessionStorageKeys: Object.keys(s.sessionStorage),
            cookies: s.cookies.map((c) => ({ name: c.name, domain: c.domain })),
          }
        }
        break
      }
      case 'ax_tree':
        axTreeSummary.push({
          url: (ev as AxTreeEvent).url,
          nodeCount: (ev as AxTreeEvent).nodeCount,
        })
        break
      case 'dom_snapshot':
        domSnapshotSummary.push({
          url: (ev as DomSnapshotEvent).url,
          sizeBytes: (ev as DomSnapshotEvent).sizeBytes,
        })
        break
    }
  }

  return {
    meta: {
      url: meta.startUrl,
      host,
      viewport: meta.viewport,
      locale: meta.locale,
      timezone: meta.timezone,
      startedAt: new Date(meta.startedAt).toISOString(),
      durationMs: (meta.endedAt ?? Date.now()) - meta.startedAt,
      counts: meta.counts as unknown as Record<string, number>,
    },
    navigations: navigations.slice(0, 40),
    actions: actions.slice(0, 120),
    storageState,
    consoleErrors: consoleErrors.slice(0, 30),
    exceptions: exceptions.slice(0, 30),
    significantResponses: dedupeResponses(significantResponses).slice(0, 30),
    axTreeSummary: axTreeSummary.slice(0, 20),
    domSnapshotSummary: domSnapshotSummary.slice(0, 20),
  }
}

function serializeAction(ev: ActionEvent): SerializedAction {
  if (ev.type === 'click') {
    const c = ev as ClickEvent
    return {
      type: 'click',
      ts: c.ts,
      url: c.url,
      selector: pickSelector(c.selectors),
      details: {
        tag: c.element.tag,
        inputType: c.element.inputType,
        href: c.element.href,
        visibleText: c.element.visibleText,
        button: c.button,
      },
    }
  }
  if (ev.type === 'input') {
    const i = ev as UnwrapInputEvent
    return {
      type: 'input',
      ts: i.ts,
      url: i.url,
      selector: pickSelector(i.selectors),
      details: {
        tag: i.element.tag,
        inputType: i.element.inputType,
        redacted: i.redacted,
        value: i.redacted ? `[REDACTED:length=${i.valueLength}]` : i.value,
        valueLength: i.valueLength,
      },
    }
  }
  if (ev.type === 'change') {
    const c = ev as UnwrapChangeEvent
    return {
      type: 'change',
      ts: c.ts,
      url: c.url,
      selector: pickSelector(c.selectors),
      details: {
        tag: c.element.tag,
        inputType: c.element.inputType,
        checked: c.checked,
        value: c.redacted ? '[REDACTED]' : c.value,
      },
    }
  }
  if (ev.type === 'submit') {
    const s = ev as UnwrapSubmitEvent
    return {
      type: 'submit',
      ts: s.ts,
      url: s.url,
      selector: pickSelector(s.selectors),
      details: { formAction: s.formAction },
    }
  }
  const k = ev as KeyEvent
  return {
    type: 'key',
    ts: k.ts,
    url: k.url,
    selector: k.selectors ? pickSelector(k.selectors) : { primary: 'page.keyboard', alternatives: {} },
    details: { key: k.key, code: k.code, modifiers: k.modifiers },
  }
}

function pickSelector(s: SelectorSet): SerializedAction['selector'] {
  let primary = 'page.locator(\'body\')'
  if (s.testId) {
    const m = s.testId.match(/\[(?:data-test(?:id)?|data-qa|data-cy)="([^"]+)"\]/)
    primary = m ? `getByTestId(${JSON.stringify(m[1]!)})` : `locator(${JSON.stringify(s.testId)})`
  } else if (s.role && s.roleName) {
    primary = `getByRole(${JSON.stringify(s.role)}, { name: ${JSON.stringify(s.roleName)} })`
  } else if (s.label) primary = `getByLabel(${JSON.stringify(s.label)})`
  else if (s.placeholder) primary = `getByPlaceholder(${JSON.stringify(s.placeholder)})`
  else if (s.text) primary = `getByText(${JSON.stringify(s.text)}, { exact: false })`
  else if (s.role) primary = `getByRole(${JSON.stringify(s.role)})`
  else if (s.css) primary = `locator(${JSON.stringify(s.css)})`
  return {
    primary,
    alternatives: {
      testId: s.testId,
      role: s.role && s.roleName ? `${s.role}/${s.roleName}` : s.role,
      label: s.label,
      placeholder: s.placeholder,
      text: s.text,
      css: s.css,
    },
    ...(s.role ? { role: s.role } : {}),
    ...(s.roleName ? { roleName: s.roleName } : {}),
    ...(s.piercedCss && s.piercedCss.length > 0 ? { piercedCss: s.piercedCss } : {}),
  }
}

function dedupeResponses(list: SessionSummary['significantResponses']): SessionSummary['significantResponses'] {
  const seen = new Set<string>()
  const out: SessionSummary['significantResponses'] = []
  for (const r of list) {
    const key = `${r.status}:${r.url}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
