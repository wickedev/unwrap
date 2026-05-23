import type { ElementInfo, SelectorSet } from '@/shared/events'

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']

export function buildSelectors(el: Element, composedPath: EventTarget[]): SelectorSet {
  const set: SelectorSet = {}

  for (const attr of TESTID_ATTRS) {
    const v = el.getAttribute(attr)
    if (v) {
      set.testId = `[${attr}="${escapeAttr(v)}"]`
      break
    }
  }

  const role = el.getAttribute('role') ?? implicitRole(el)
  if (role) {
    set.role = role
    const name = accessibleName(el)
    if (name) set.roleName = name
  }

  const text = visibleText(el)
  if (text && text.length <= 80) set.text = text

  const label = associatedLabel(el)
  if (label) set.label = label

  const placeholder = el.getAttribute('placeholder')
  if (placeholder) set.placeholder = placeholder

  set.css = uniqueCss(el)

  const pierced = piercedPath(composedPath)
  if (pierced.length > 1) set.piercedCss = pierced

  return set
}

export function elementInfo(el: Element): ElementInfo {
  const info: ElementInfo = { tag: el.tagName.toLowerCase() }
  if (el instanceof HTMLInputElement) {
    info.type = 'input'
    info.inputType = el.type
    info.name = el.name || undefined
  } else if (el instanceof HTMLSelectElement) {
    info.type = 'select'
    info.name = el.name || undefined
  } else if (el instanceof HTMLTextAreaElement) {
    info.type = 'textarea'
    info.name = el.name || undefined
  } else if (el instanceof HTMLButtonElement) {
    info.type = 'button'
    info.name = el.name || undefined
  } else if (el instanceof HTMLAnchorElement) {
    info.type = 'a'
    info.href = el.href
  }
  if ((el as HTMLElement).isContentEditable) info.isContentEditable = true
  const txt = visibleText(el)
  if (txt) info.visibleText = txt
  return info
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'a':
      return (el as HTMLAnchorElement).href ? 'link' : undefined
    case 'button':
      return 'button'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'header':
      return 'banner'
    case 'footer':
      return 'contentinfo'
    case 'input': {
      const t = (el as HTMLInputElement).type
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'range') return 'slider'
      if (t === 'search') return 'searchbox'
      return 'textbox'
    }
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'img':
      return (el as HTMLImageElement).alt ? 'img' : undefined
  }
  return undefined
}

function accessibleName(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return ariaLabel.trim()

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean)
    const parts: string[] = []
    for (const id of ids) {
      const ref = el.ownerDocument?.getElementById(id)
      if (ref?.textContent) parts.push(ref.textContent.trim())
    }
    if (parts.length) return parts.join(' ')
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt

  if (el instanceof HTMLInputElement) {
    if (el.labels?.length) {
      const txt = Array.from(el.labels)
        .map((l) => l.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      if (txt) return txt
    }
    if (el.placeholder) return el.placeholder
    if (el.title) return el.title
  }

  if (el instanceof HTMLButtonElement || el.tagName === 'A') {
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (t && t.length <= 80) return t
  }
  return undefined
}

function visibleText(el: Element): string | undefined {
  let t = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return undefined
  if (t.length > 80) t = t.slice(0, 80) + '…'
  return t
}

function associatedLabel(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels && el.labels.length) {
      return el.labels[0]?.textContent?.trim() || undefined
    }
  }
  return undefined
}

function uniqueCss(el: Element): string {
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
    const sel = `#${el.id}`
    if (el.ownerDocument && el.ownerDocument.querySelectorAll(sel).length === 1) return sel
  }
  const path: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && path.length < 6) {
    let part = node.tagName.toLowerCase()
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      part = `${part}#${node.id}`
      path.unshift(part)
      break
    }
    const cls = stableClass(node)
    if (cls) part += cls
    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(node) + 1
        part += `:nth-of-type(${idx})`
      }
    }
    path.unshift(part)
    node = parent
  }
  return path.join(' > ')
}

function stableClass(el: Element): string {
  const cls = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((c) => c && !/^(?:_|css-|sc-|jsx-|ng-|svelte-)/.test(c) && !/\d{4}/.test(c) && c.length < 30)
    .slice(0, 2)
  return cls.length ? '.' + cls.join('.') : ''
}

function piercedPath(composedPath: EventTarget[]): string[] {
  const segments: string[] = []
  let current = ''
  for (let i = 0; i < composedPath.length; i++) {
    const node = composedPath[i]
    if (node instanceof ShadowRoot) {
      if (current) segments.push(current)
      current = ''
      continue
    }
    if (node instanceof Element && !current) {
      current = uniqueCss(node)
    }
  }
  if (current) segments.push(current)
  return segments.reverse()
}

function escapeAttr(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}

export function isSensitiveInput(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false
  if (el.type === 'password') return true
  const ac = (el.autocomplete ?? '').toLowerCase()
  if (/(?:cc-|credit|cardnum|cvv|csc|new-password|current-password|one-time-code|otp)/.test(ac)) return true
  const name = (el.name + ' ' + el.id + ' ' + (el.getAttribute('aria-label') ?? '')).toLowerCase()
  if (/(password|passwd|pwd|otp|ssn|secret|token|cvv|card.?number|pin)/.test(name)) return true
  return false
}
