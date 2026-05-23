import { authIsValid, getSettings } from '@/shared/settings'

// Used by background callers (e.g. /api/generate). The OAuth sign-in
// itself runs from the side panel (sidepanel/auth.ts) so that
// launchWebAuthFlow isn't tied to the SW's lifecycle.
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { serverUrl, auth } = await getSettings()
  if (!serverUrl) throw new Error('Server URL is not configured.')
  if (!authIsValid(auth)) throw new Error('Not signed in. Click "Sign in with Google" in Settings.')
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${auth!.token}`)
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json')
  return fetch(`${trimSlash(serverUrl)}${path}`, { ...init, headers })
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}
