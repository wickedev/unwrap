import type { CoverageEvent } from '@/shared/events'
import { appendEvent, makeId, putBlob } from '@/shared/storage'

interface PreciseCoverage {
  result?: PreciseCoverageScript[]
}

interface PreciseCoverageScript {
  scriptId: string
  url: string
  functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[]
}

interface CssRuleUsageDelta {
  coverage?: CssRuleUsage[]
}

interface CssRuleUsage {
  styleSheetId: string
  startOffset: number
  endOffset: number
  used: boolean
}

interface ScriptSource {
  scriptId: string
  url: string
  contentLength?: number
}

interface StylesheetMeta {
  styleSheetId: string
  sourceURL: string
  length?: number
}

export class CoverageTracker {
  private tabId: number
  private active = false
  private scripts = new Map<string, ScriptSource>()
  private stylesheets = new Map<string, StylesheetMeta>()
  private onDebuggerEventBound = this.onDebuggerEvent.bind(this)

  constructor(tabId: number) {
    this.tabId = tabId
  }

  async start(): Promise<void> {
    if (this.active) return
    const target = { tabId: this.tabId }
    try {
      await chrome.debugger.sendCommand(target, 'Profiler.enable', {})
      await chrome.debugger.sendCommand(target, 'Profiler.startPreciseCoverage', {
        callCount: true,
        detailed: true,
        allowTriggeredUpdates: false,
      })
      await chrome.debugger.sendCommand(target, 'Debugger.enable', {})
      await chrome.debugger.sendCommand(target, 'CSS.enable', {})
      await chrome.debugger.sendCommand(target, 'DOM.enable', {})
      await chrome.debugger.sendCommand(target, 'CSS.startRuleUsageTracking', {})
      chrome.debugger.onEvent.addListener(this.onDebuggerEventBound)
      this.active = true
    } catch (e) {
      console.debug('[unwrap] coverage start failed', e)
    }
  }

  async stopAndCollect(sessionId: string): Promise<CoverageEvent | null> {
    if (!this.active) return null
    chrome.debugger.onEvent.removeListener(this.onDebuggerEventBound)
    this.active = false
    const target = { tabId: this.tabId }

    let jsResult: PreciseCoverage = {}
    let cssDelta: CssRuleUsageDelta = {}
    try {
      jsResult = (await chrome.debugger.sendCommand(
        target,
        'Profiler.takePreciseCoverage',
        {},
      )) as PreciseCoverage
    } catch (e) {
      console.debug('[unwrap] takePreciseCoverage failed', e)
    }
    try {
      cssDelta = (await chrome.debugger.sendCommand(
        target,
        'CSS.stopRuleUsageTracking',
        {},
      )) as CssRuleUsageDelta
    } catch (e) {
      console.debug('[unwrap] stopRuleUsageTracking failed', e)
    }
    try {
      await chrome.debugger.sendCommand(target, 'Profiler.stopPreciseCoverage', {})
      await chrome.debugger.sendCommand(target, 'Profiler.disable', {})
    } catch {
      // ignore
    }

    const summary = summarize(jsResult.result ?? [], cssDelta.coverage ?? [], this.scripts, this.stylesheets)

    const payload = {
      js: jsResult.result ?? [],
      css: cssDelta.coverage ?? [],
      scripts: Array.from(this.scripts.values()),
      stylesheets: Array.from(this.stylesheets.values()),
    }
    const json = JSON.stringify(payload)
    const blob = new Blob([json], { type: 'application/json' })
    const ref = makeId('cov')
    await putBlob(ref, sessionId, 'application/json', blob)

    const event: CoverageEvent = {
      type: 'coverage',
      sessionId,
      ts: Date.now(),
      ref,
      jsScriptCount: jsResult.result?.length ?? 0,
      cssStylesheetCount: this.stylesheets.size,
      jsUsedBytes: summary.jsUsedBytes,
      jsTotalBytes: summary.jsTotalBytes,
      cssUsedBytes: summary.cssUsedBytes,
      cssTotalBytes: summary.cssTotalBytes,
    }
    await appendEvent(event)
    return event
  }

  private onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
    if (source.tabId !== this.tabId) return
    if (method === 'Debugger.scriptParsed') {
      const p = params as { scriptId: string; url: string; length?: number }
      this.scripts.set(p.scriptId, { scriptId: p.scriptId, url: p.url, contentLength: p.length })
    } else if (method === 'CSS.styleSheetAdded') {
      const p = params as { header?: { styleSheetId: string; sourceURL: string; length?: number } }
      if (p.header) {
        this.stylesheets.set(p.header.styleSheetId, {
          styleSheetId: p.header.styleSheetId,
          sourceURL: p.header.sourceURL,
          length: p.header.length,
        })
      }
    }
  }
}

function summarize(
  js: PreciseCoverageScript[],
  css: CssRuleUsage[],
  scripts: Map<string, ScriptSource>,
  stylesheets: Map<string, StylesheetMeta>,
): { jsUsedBytes: number; jsTotalBytes: number; cssUsedBytes: number; cssTotalBytes: number } {
  let jsUsed = 0
  let jsTotal = 0
  for (const script of js) {
    const total = scripts.get(script.scriptId)?.contentLength ?? scriptTotalFromRanges(script)
    jsTotal += total
    jsUsed += scriptUsedBytes(script)
  }

  let cssUsed = 0
  let cssTotal = 0
  for (const rule of css) {
    const span = Math.max(0, rule.endOffset - rule.startOffset)
    cssTotal += span
    if (rule.used) cssUsed += span
  }
  for (const sheet of stylesheets.values()) {
    if (sheet.length && cssTotal < sheet.length) {
      // ensure we don't undercount when rules are sparse
    }
  }
  return { jsUsedBytes: jsUsed, jsTotalBytes: jsTotal, cssUsedBytes: cssUsed, cssTotalBytes: cssTotal }
}

function scriptTotalFromRanges(script: PreciseCoverageScript): number {
  let max = 0
  for (const fn of script.functions) {
    for (const r of fn.ranges) {
      if (r.endOffset > max) max = r.endOffset
    }
  }
  return max
}

function scriptUsedBytes(script: PreciseCoverageScript): number {
  let used = 0
  for (const fn of script.functions) {
    for (const r of fn.ranges) {
      if (r.count > 0) used += r.endOffset - r.startOffset
    }
  }
  return used
}
