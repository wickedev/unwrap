export interface UnwrapSettings {
  serverUrl: string
  auth: AuthState | null
}

export interface AuthState {
  token: string
  email: string
  expiresAt: number
}

const DEFAULTS: UnwrapSettings = {
  serverUrl: '',
  auth: null,
}

const KEY = 'unwrap_settings'

export async function getSettings(): Promise<UnwrapSettings> {
  const result = await chrome.storage.local.get(KEY)
  const stored = result[KEY] as Partial<UnwrapSettings> | undefined
  return { ...DEFAULTS, ...(stored ?? {}) }
}

export async function setSettings(patch: Partial<UnwrapSettings>): Promise<UnwrapSettings> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [KEY]: next })
  return next
}

export function authIsValid(auth: AuthState | null | undefined): boolean {
  if (!auth?.token) return false
  return auth.expiresAt > Date.now() + 60_000
}
