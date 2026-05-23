import type { AuthStartResponse, AuthTokenResponse } from '@unwrap/protocol'
import { authIsValid, getSettings, setSettings, type AuthState } from '@/shared/settings'

export async function signInWithGoogle(): Promise<AuthState> {
  const { serverUrl } = await getSettings()
  if (!serverUrl) throw new Error('Server URL is not configured. Open Settings and enter the server URL first.')
  const extensionRedirect = chrome.identity.getRedirectURL('auth')

  const startResp = await fetch(`${trimSlash(serverUrl)}/auth/google/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ extensionRedirect }),
  })
  if (!startResp.ok) {
    const text = await startResp.text()
    throw new Error(`/auth/google/start failed (${startResp.status}): ${text.slice(0, 200)}`)
  }
  const { authUrl } = (await startResp.json()) as AuthStartResponse

  const resultUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (callbackUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'OAuth flow failed'))
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

export async function signOut(): Promise<void> {
  await setSettings({ auth: null })
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { serverUrl, auth } = await getSettings()
  if (!serverUrl) throw new Error('Server URL is not configured.')
  if (!authIsValid(auth)) throw new Error('Not signed in. Click "Sign in with Google" in Settings.')
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${auth!.token}`)
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json')
  return fetch(`${trimSlash(serverUrl)}${path}`, { ...init, headers })
}

export type { AuthState, AuthTokenResponse }

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}
