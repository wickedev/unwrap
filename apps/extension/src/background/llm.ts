import type { ErrorResponse, UploadSessionRequest, UploadSessionResponse } from '@unwrap/protocol'
import { getSession, listBlobs, listEvents } from '@/shared/storage'
import { authedFetch } from './auth'
import { generatePlaywrightScript } from './playwright'
import { pickScreenshotsForLlm, pickScreenshotsForVerify } from './screenshots'
import { summarizeSession } from './summarize'
import { collectApiCalls } from './api-calls'
import { collectStaticAssets } from './static-assets'
import { collectCoverageSummary } from './coverage-summary'
import { collectWsChannels } from './ws-channels'
import { collectAccessibilitySummary } from './a11y-summary'

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
  // Augment the summary with API calls + bodies for the reverse-engineering
  // pages on the server. Done outside summarizeSession because it has to
  // read blob data (async + I/O).
  summary.apiCalls = await collectApiCalls(sessionId, events)
  summary.staticAssets = await collectStaticAssets(events)
  const coverage = await collectCoverageSummary(events)
  if (coverage) summary.coverage = coverage
  const wsChannels = collectWsChannels(events)
  if (wsChannels.length > 0) summary.wsChannels = wsChannels
  const a11y = await collectAccessibilitySummary(events)
  if (a11y) summary.accessibility = a11y
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

  // Ship the captured tab video as a separate raw-bytes POST so the
  // primary upload payload stays small. Best-effort — a video failure
  // doesn't fail the session upload.
  if (meta.video) {
    try {
      const blobs = await listBlobs(sessionId)
      const videoBlob = blobs.find((b) => b.ref === meta.video!.ref)
      if (videoBlob) {
        await authedFetch(`/api/sessions/${encodeURIComponent(result.id)}/video`, {
          method: 'POST',
          headers: {
            'content-type': meta.video.mimeType,
            'x-unwrap-duration-ms': String(meta.video.durationMs),
          },
          body: videoBlob.data,
        })
      }
    } catch (e) {
      console.warn('[unwrap] video upload failed', e)
    }
  }
  return result
}
