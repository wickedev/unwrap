import { useCallback, useEffect, useState } from 'react'
import type { RuntimeMessage, SessionMeta } from '@/shared/events'

async function send<T>(msg: RuntimeMessage): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string }
  if (!res?.ok) throw new Error(res?.error ?? 'unknown error')
  return res.result as T
}

export function App() {
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const list = await send<SessionMeta[]>({ kind: 'list_sessions' })
      setSessions(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      setActiveTab(tabs[0] ?? null)
    })
    void refresh()
    const handler = (
      _tabId: number,
      _changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tab.active) setActiveTab(tab)
    }
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId)
      setActiveTab(tab)
    })
    chrome.tabs.onUpdated.addListener(handler)
    const interval = setInterval(refresh, 1500)
    return () => {
      chrome.tabs.onUpdated.removeListener(handler)
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

  const exportSession = async (sessionId: string, format: 'har' | 'json') => {
    try {
      await send({ kind: 'export_session', sessionId, format })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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

  return (
    <div className="app">
      <header>
        <div>
          <h1>Unwrap</h1>
          <div className="target">{activeTab?.url ?? 'No active tab'}</div>
        </div>
      </header>

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
              onStop={() => stop(s.id)}
              onCaptureStorage={() => captureStorage(s.id)}
              onExportHar={() => exportSession(s.id, 'har')}
              onExportJson={() => exportSession(s.id, 'json')}
              onDelete={() => remove(s.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface CardProps {
  session: SessionMeta
  onStop: () => void
  onCaptureStorage: () => void
  onExportHar: () => void
  onExportJson: () => void
  onDelete: () => void
}

function SessionCard({ session, onStop, onCaptureStorage, onExportHar, onExportJson, onDelete }: CardProps) {
  const started = new Date(session.startedAt)
  const duration = (session.endedAt ?? Date.now()) - session.startedAt
  return (
    <div className="session">
      <header>
        <h2 title={session.startUrl}>{labelFor(session.startUrl)}</h2>
        <span className={`status ${session.status}`}>{session.status}</span>
      </header>
      <div className="meta">
        <div>
          <span>{session.counts.navigations}</span>nav
        </div>
        <div>
          <span>{session.counts.requests}</span>req
        </div>
        <div>
          <span>{session.counts.responses}</span>res
        </div>
        <div>
          <span>{session.counts.screenshots}</span>shot
        </div>
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
