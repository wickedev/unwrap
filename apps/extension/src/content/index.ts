import type { RuntimeMessage } from '@/shared/events'
import { ContentRecorder } from './recorder'

let recorder: ContentRecorder | null = null

async function bootstrap(): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({ kind: 'is_recording' } satisfies RuntimeMessage)) as
      | { ok: true; result: { recording: boolean; sessionId?: string } }
      | { ok: false; error: string }
    if (reply?.ok && reply.result.recording && reply.result.sessionId) {
      attach(reply.result.sessionId)
    }
  } catch {
    // background not ready yet, ignore
  }
}

function attach(sessionId: string): void {
  if (recorder) {
    recorder.setSession(sessionId)
    return
  }
  recorder = new ContentRecorder(sessionId)
  recorder.start()
}

function detach(): void {
  recorder?.stop()
  recorder = null
}

chrome.runtime.onMessage.addListener((msg: { kind: string; sessionId?: string }, _sender, sendResponse) => {
  if (msg?.kind === 'recording_started' && msg.sessionId) {
    attach(msg.sessionId)
    sendResponse({ ok: true })
  } else if (msg?.kind === 'recording_stopped') {
    detach()
    sendResponse({ ok: true })
  }
  return false
})

void bootstrap()
