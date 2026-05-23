import type { ErrorResponse, UploadSessionRequest, UploadSessionResponse } from '@unwrap/protocol'
import { getSession, listEvents } from '@/shared/storage'
import { authedFetch } from './auth'
import { generatePlaywrightScript } from './playwright'
import { pickScreenshotsForLlm, pickScreenshotsForVerify } from './screenshots'
import { summarizeSession } from './summarize'

export interface UploadResult {
  id: string
  url: string
}

// Bundles the session, ships it to the server, and returns the URL of the
// uploaded session page so the side panel can open it in a new tab.
export async function uploadSessionToServer(sessionId: string): Promise<UploadResult> {
  const meta = await getSession(sessionId)
  if (!meta) throw new Error('session not found')
  const events = await listEvents(sessionId)

  const summary = summarizeSession(meta, events)
  const fallbackSpec = generatePlaywrightScript(meta, events)
  const screenshots = await pickScreenshotsForLlm(sessionId, events, 2)
  const verifyScreenshots = await pickScreenshotsForVerify(sessionId, events)

  const body: UploadSessionRequest = {
    clientSessionId: sessionId,
    summary,
    fallbackSpec,
    screenshots,
    verifyScreenshots,
  }

  const resp = await authedFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    let message = `Server returned ${resp.status}`
    try {
      const j = (await resp.json()) as ErrorResponse
      if (j.error) message = j.detail ? `${j.error}: ${j.detail}` : j.error
    } catch {
      // fall through
    }
    throw new Error(message)
  }

  const result = (await resp.json()) as UploadSessionResponse
  return result
}
