import { useCallback, useEffect, useState } from 'react'
import type { RuntimeMessage, SessionMeta } from '@/shared/events'
import { authIsValid, type UnwrapSettings } from '@/shared/settings'
import { signInWithGoogleFromPanel, signOutFromPanel } from './auth'

async function send<T>(msg: RuntimeMessage): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string }
  if (!res?.ok) throw new Error(res?.error ?? 'unknown error')
  return res.result as T
}

export function App() {
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [settings, setSettingsState] = useState<UnwrapSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([
        send<SessionMeta[]>({ kind: 'list_sessions' }),
        send<UnwrapSettings>({ kind: 'get_settings' }),
      ])
      setSessions(list)
      setSettingsState(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      setActiveTab(tabs[0] ?? null)
    })
    void refresh()
    const updateHandler = (
      _tabId: number,
      _changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tab.active) setActiveTab(tab)
    }
    const activateHandler = async ({ tabId }: chrome.tabs.TabActiveInfo) => {
      const tab = await chrome.tabs.get(tabId)
      setActiveTab(tab)
    }
    chrome.tabs.onActivated.addListener(activateHandler)
    chrome.tabs.onUpdated.addListener(updateHandler)
    const interval = setInterval(refresh, 1500)
    return () => {
      chrome.tabs.onActivated.removeListener(activateHandler)
      chrome.tabs.onUpdated.removeListener(updateHandler)
      clearInterval(interval)
    }
  }, [refresh])

  const activeSession = sessions.find(
    (s) => s.status === 'recording' && activeTab && s.tabId === activeTab.id,
  )

  const start = async () => {
    if (!activeTab?.id) return
    setBusy(true)
    setError(null)
    try {
      await send({ kind: 'start_session', tabId: activeTab.id })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (sessionId: string) => {
    setBusy(true)
    try {
      await send({ kind: 'stop_session', sessionId })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const captureStorage = async (sessionId: string) => {
    try {
      await send({ kind: 'capture_storage_state', sessionId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const exportSession = async (sessionId: string, format: 'har' | 'json' | 'playwright') => {
    try {
      await send({ kind: 'export_session', sessionId, format })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const uploadAndOpen = async (sessionId: string) => {
    setBusy(true)
    setError(null)
    try {
      await send({ kind: 'upload_session', sessionId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (sessionId: string) => {
    if (!confirm('Delete this session and all its data?')) return
    try {
      await send({ kind: 'delete_session', sessionId })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const aiReady = !!settings && !!settings.serverUrl && authIsValid(settings.auth)

  return (
    <div className="app">
      <header>
        <div>
          <h1>Unwrap</h1>
          <div className="target">{activeTab?.url ?? 'No active tab'}</div>
        </div>
        <button className="link" onClick={() => setSettingsOpen((v) => !v)} aria-label="Toggle settings">
          {settingsOpen ? '× Close' : '⚙ Settings'}
        </button>
      </header>

      {settingsOpen && settings && (
        <SettingsPanel
          settings={settings}
          onChange={async (patch) => {
            const next = await send<UnwrapSettings>({ kind: 'set_settings', patch })
            setSettingsState(next)
          }}
          onSignIn={async () => {
            setBusy(true)
            setError(null)
            try {
              await signInWithGoogleFromPanel()
              await refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }}
          onSignOut={async () => {
            await signOutFromPanel()
            await refresh()
          }}
          busy={busy}
        />
      )}

      <div className="controls">
        {activeSession ? (
          <button className="danger" disabled={busy} onClick={() => stop(activeSession.id)}>
            ■ Stop recording
          </button>
        ) : (
          <button className="primary" disabled={busy || !activeTab?.id} onClick={start}>
            ● Start recording
          </button>
        )}
        <button disabled={busy} onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="sessions">
        {sessions.length === 0 ? (
          <div className="empty">No sessions yet. Click “Start recording” to capture this tab.</div>
        ) : (
          sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              aiReady={aiReady}
              busy={busy}
              onStop={() => stop(s.id)}
              onCaptureStorage={() => captureStorage(s.id)}
              onExportHar={() => exportSession(s.id, 'har')}
              onExportJson={() => exportSession(s.id, 'json')}
              onExportPlaywright={() => exportSession(s.id, 'playwright')}
              onUpload={() => uploadAndOpen(s.id)}
              onDelete={() => remove(s.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface SettingsProps {
  settings: UnwrapSettings
  onChange: (patch: Partial<UnwrapSettings>) => Promise<void>
  onSignIn: () => Promise<void>
  onSignOut: () => Promise<void>
  busy: boolean
}

function SettingsPanel({ settings, onChange, onSignIn, onSignOut, busy }: SettingsProps) {
  const [draftUrl, setDraftUrl] = useState(settings.serverUrl)
  useEffect(() => setDraftUrl(settings.serverUrl), [settings.serverUrl])

  const signedIn = authIsValid(settings.auth)

  return (
    <div className="settings">
      <label>
        <span className="label">Server URL</span>
        <input
          type="url"
          value={draftUrl}
          placeholder="https://unwrap-server.your-domain.workers.dev"
          onChange={(e) => setDraftUrl(e.target.value)}
          onBlur={() => {
            if (draftUrl !== settings.serverUrl) void onChange({ serverUrl: draftUrl.trim() })
          }}
        />
      </label>

      <div className="auth-row">
        {signedIn ? (
          <>
            <div className="muted">
              Signed in as <strong>{settings.auth!.email}</strong>
            </div>
            <button onClick={onSignOut} disabled={busy}>
              Sign out
            </button>
          </>
        ) : (
          <button
            className="primary"
            onClick={onSignIn}
            disabled={busy || !settings.serverUrl}
            title={settings.serverUrl ? 'Authenticate via Google through the server' : 'Set the server URL first'}
          >
            Sign in with Google
          </button>
        )}
      </div>

      <p className="hint">
        Sign-in opens a browser tab on the server. The server handles Google OAuth and returns a short-lived JWT
        that Unwrap stores in chrome.storage.local. Tokens never touch the browser address bar of any third-party page.
      </p>
    </div>
  )
}

interface CardProps {
  session: SessionMeta
  aiReady: boolean
  busy: boolean
  onStop: () => void
  onCaptureStorage: () => void
  onExportHar: () => void
  onExportJson: () => void
  onExportPlaywright: () => void
  onUpload: () => void
  onDelete: () => void
}

function SessionCard({
  session,
  aiReady,
  busy,
  onStop,
  onCaptureStorage,
  onExportHar,
  onExportJson,
  onExportPlaywright,
  onUpload,
  onDelete,
}: CardProps) {
  const started = new Date(session.startedAt)
  const duration = (session.endedAt ?? Date.now()) - session.startedAt
  return (
    <div className="session">
      <header>
        <h2 title={session.startUrl}>{labelFor(session.startUrl)}</h2>
        <span className={`status ${session.status}`}>{session.status}</span>
      </header>
      <div className="meta">
        <div><span>{session.counts.navigations}</span>nav</div>
        <div><span>{session.counts.actions}</span>act</div>
        <div><span>{session.counts.requests}</span>req</div>
        <div><span>{session.counts.responses}</span>res</div>
        <div><span>{session.counts.screenshots}</span>shot</div>
        <div><span>{session.counts.storageStates}</span>store</div>
      </div>
      <div className="meta">
        <div><span>{session.counts.consoleMessages}</span>log</div>
        <div>
          <span className={session.counts.exceptions > 0 ? 'count-err' : undefined}>
            {session.counts.exceptions}
          </span>
          err
        </div>
        <div><span>{session.counts.wsFrames}</span>ws</div>
        <div><span>{session.counts.domSnapshots}</span>dom</div>
        <div><span>{session.counts.axTrees}</span>ax</div>
        <div></div>
      </div>
      <div className="meta">
        <div style={{ gridColumn: 'span 2' }}>
          <span>{started.toLocaleString()}</span>started
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <span>{formatDuration(duration)}</span>{session.status === 'recording' ? 'elapsed' : 'duration'}
        </div>
      </div>
      <div className="actions">
        {session.status === 'recording' && (
          <>
            <button className="danger" onClick={onStop}>Stop</button>
            <button onClick={onCaptureStorage}>Capture storage</button>
          </>
        )}
        <button
          className="primary"
          onClick={onUpload}
          disabled={busy || !aiReady}
          title={aiReady ? 'Upload this session to the server and open it in a new tab' : 'Sign in with Google in Settings first'}
        >
          ⤴ Upload & open
        </button>
        <button onClick={onExportPlaywright}>Export Playwright</button>
        <button onClick={onExportHar}>Export HAR</button>
        <button onClick={onExportJson}>Export JSON</button>
        <button className="danger" onClick={onDelete}>Delete</button>
      </div>
      {session.error && <div className="error" style={{ padding: '4px 0' }}>{session.error}</div>}
    </div>
  )
}

function labelFor(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url || '(no url)'
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
