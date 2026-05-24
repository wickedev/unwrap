import type {
  ActionEvent,
  ClickEvent,
  InputEvent as UnwrapInputEvent,
  ChangeEvent as UnwrapChangeEvent,
  KeyEvent,
  SubmitEvent as UnwrapSubmitEvent,
  RuntimeMessage,
} from '@/shared/events'
import { buildSelectors, elementInfo, isSensitiveInput } from './selector'

const NAV_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

const INPUT_DEBOUNCE_MS = 350
let inputTimer: number | null = null
let pendingInput: { target: Element; ts: number } | null = null

export class ContentRecorder {
  private sessionId: string
  private active = false

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  start(): void {
    if (this.active) return
    this.active = true
    document.addEventListener('click', this.onClick, { capture: true })
    document.addEventListener('input', this.onInput, { capture: true })
    document.addEventListener('change', this.onChange, { capture: true })
    document.addEventListener('submit', this.onSubmit, { capture: true })
    document.addEventListener('keydown', this.onKeyDown, { capture: true })
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    document.removeEventListener('click', this.onClick, { capture: true } as EventListenerOptions)
    document.removeEventListener('input', this.onInput, { capture: true } as EventListenerOptions)
    document.removeEventListener('change', this.onChange, { capture: true } as EventListenerOptions)
    document.removeEventListener('submit', this.onSubmit, { capture: true } as EventListenerOptions)
    document.removeEventListener('keydown', this.onKeyDown, { capture: true } as EventListenerOptions)
    this.flushInput()
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId
  }

  private send(event: ActionEvent): void {
    const msg: RuntimeMessage = { kind: 'action_event', event }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {
        // background may be temporarily unavailable; drop the event
      })
    } catch {
      // ignore
    }
  }

  private onClick = (e: MouseEvent): void => {
    const target = primaryTarget(e)
    if (!target) return
    this.flushInput()
    const event: ClickEvent = {
      type: 'click',
      sessionId: this.sessionId,
      ts: Date.now(),
      selectors: buildSelectors(target, e.composedPath()),
      element: elementInfo(target),
      button: e.button,
      modifiers: { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey },
      url: location.href,
      position: {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      },
    }
    this.send(event)
  }

  private onInput = (e: Event): void => {
    const target = primaryTarget(e)
    if (!target) return
    if (!isEditable(target)) return
    pendingInput = { target, ts: Date.now() }
    if (inputTimer != null) window.clearTimeout(inputTimer)
    inputTimer = window.setTimeout(() => this.flushInput(), INPUT_DEBOUNCE_MS)
  }

  private flushInput = (): void => {
    if (inputTimer != null) {
      window.clearTimeout(inputTimer)
      inputTimer = null
    }
    if (!pendingInput) return
    const { target, ts } = pendingInput
    pendingInput = null
    const sensitive = isSensitiveInput(target)
    const value = readValue(target)
    const event: UnwrapInputEvent = {
      type: 'input',
      sessionId: this.sessionId,
      ts,
      selectors: buildSelectors(target, [target]),
      element: elementInfo(target),
      redacted: sensitive,
      ...(sensitive ? {} : { value }),
      valueLength: value?.length ?? 0,
      url: location.href,
    }
    this.send(event)
  }

  private onChange = (e: Event): void => {
    const target = primaryTarget(e)
    if (!target) return
    if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
      const event: UnwrapChangeEvent = {
        type: 'change',
        sessionId: this.sessionId,
        ts: Date.now(),
        selectors: buildSelectors(target, e.composedPath()),
        element: elementInfo(target),
        redacted: false,
        checked: target.checked,
        url: location.href,
      }
      this.send(event)
      return
    }
    if (target instanceof HTMLSelectElement) {
      const event: UnwrapChangeEvent = {
        type: 'change',
        sessionId: this.sessionId,
        ts: Date.now(),
        selectors: buildSelectors(target, e.composedPath()),
        element: elementInfo(target),
        redacted: false,
        value: target.value,
        url: location.href,
      }
      this.send(event)
    }
  }

  private onSubmit = (e: Event): void => {
    const target = e.target instanceof HTMLFormElement ? e.target : null
    if (!target) return
    this.flushInput()
    const event: UnwrapSubmitEvent = {
      type: 'submit',
      sessionId: this.sessionId,
      ts: Date.now(),
      selectors: buildSelectors(target, e.composedPath()),
      formAction: target.action || undefined,
      url: location.href,
    }
    this.send(event)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!NAV_KEYS.has(e.key)) return
    const target = primaryTarget(e)
    if (e.key === 'Enter' && target && isEditable(target)) this.flushInput()
    const event: KeyEvent = {
      type: 'key',
      sessionId: this.sessionId,
      ts: Date.now(),
      key: e.key,
      code: e.code,
      ...(target ? { selectors: buildSelectors(target, e.composedPath()) } : {}),
      modifiers: { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey },
      url: location.href,
    }
    this.send(event)
  }
}

function primaryTarget(e: Event): Element | null {
  const path = e.composedPath()
  for (const node of path) {
    if (node instanceof Element) return node
  }
  return e.target instanceof Element ? e.target : null
}

function isEditable(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(el.type)
  }
  if (el instanceof HTMLTextAreaElement) return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

function readValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText
  return undefined
}
