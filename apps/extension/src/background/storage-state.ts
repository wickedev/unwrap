import { getSession } from '@/shared/storage'

export async function captureStorageState(
  sessionId: string,
  trigger: 'manual' | 'session_start' | 'navigation',
): Promise<void> {
  const meta = await getSession(sessionId)
  if (!meta) throw new Error('session not found')
  try {
    await chrome.scripting.executeScript({
      target: { tabId: meta.tabId },
      func: (sid: string, trig: string) => {
        const dump = (s: Storage) => {
          const out: Record<string, string> = {}
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i)
            if (k != null) out[k] = s.getItem(k) ?? ''
          }
          return out
        }
        chrome.runtime.sendMessage({
          kind: 'content_storage_state',
          sessionId: sid,
          origin: location.origin,
          local: dump(localStorage),
          session: dump(sessionStorage),
          trigger: trig,
        })
      },
      args: [sessionId, trigger],
    })
  } catch (e) {
    console.debug('[unwrap] captureStorageState failed', e)
  }
}
