import type { AuthStartResponse } from '@unwrap/protocol'
import { getSettings, setSettings, type AuthState } from '@/shared/settings'

// Runs in the side panel context (not the background service worker),
// so launchWebAuthFlow stays attached to a long-lived caller — the side
// panel window — and won't be cut off by SW eviction.
export async function signInWithGoogleFromPanel(): Promise<AuthState> {
  const { serverUrl } = await getSettings()
  if (!serverUrl) throw new Error('Server URL is not configured.')
  const extensionRedirect = chrome.identity.getRedirectURL('auth')

  const startResp = await fetch(`${trimSlash(serverUrl)}/auth/google/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ extensionRedirect }),
  })
  if (!startResp.ok) {
    const text = await startResp.text().catch(() => '')
    throw new Error(`/auth/google/start failed (${startResp.status}): ${text.slice(0, 300)}`)
  }
  const { authUrl } = (await startResp.json()) as AuthStartResponse

  const resultUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (callbackUrl) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(new Error(err.message ?? 'OAuth flow failed'))
        return
      }
      if (!callbackUrl) {
        reject(new Error('OAuth flow returned no URL'))
        return
      }
      resolve(callbackUrl)
    })
  })

  const url = new URL(resultUrl)
  const token = url.searchParams.get('token')
  const email = url.searchParams.get('email')
  const expiresAtStr = url.searchParams.get('expires_at')
  if (!token || !email || !expiresAtStr) {
    throw new Error('OAuth callback missing token/email/expires_at')
  }
  const auth: AuthState = { token, email, expiresAt: Number(expiresAtStr) }
  await setSettings({ auth })
  return auth
}

export async function signOutFromPanel(): Promise<void> {
  await setSettings({ auth: null })
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}
