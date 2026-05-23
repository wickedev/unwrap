import type { AxTreeEvent, DomSnapshotEvent } from '@/shared/events'
import { appendEvent, makeId, putBlob } from '@/shared/storage'

export async function captureDomSnapshot(
  tabId: number,
  sessionId: string,
  url: string,
): Promise<DomSnapshotEvent | null> {
  try {
    const snapshot = (await chrome.debugger.sendCommand(
      { tabId },
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: [],
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      },
    )) as unknown

    const json = JSON.stringify(snapshot)
    const blob = new Blob([json], { type: 'application/json' })
    const ref = makeId('dom')
    await putBlob(ref, sessionId, 'application/json', blob)

    const event: DomSnapshotEvent = {
      type: 'dom_snapshot',
      sessionId,
      ts: Date.now(),
      ref,
      url,
      sizeBytes: blob.size,
    }
    await appendEvent(event)
    return event
  } catch (e) {
    console.debug('[unwrap] DOM snapshot failed', e)
    return null
  }
}

export async function captureAxTree(
  tabId: number,
  sessionId: string,
  url: string,
): Promise<AxTreeEvent | null> {
  try {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      'Accessibility.getFullAXTree',
      {},
    )) as { nodes?: unknown[] }
    const nodes = Array.isArray(result?.nodes) ? result.nodes : []
    const json = JSON.stringify(nodes)
    const blob = new Blob([json], { type: 'application/json' })
    const ref = makeId('ax')
    await putBlob(ref, sessionId, 'application/json', blob)

    const event: AxTreeEvent = {
      type: 'ax_tree',
      sessionId,
      ts: Date.now(),
      ref,
      url,
      nodeCount: nodes.length,
    }
    await appendEvent(event)
    return event
  } catch (e) {
    console.debug('[unwrap] AX tree capture failed', e)
    return null
  }
}
