import { useCallback, useEffect, useState } from 'react'
import {
  Accessibility,
  AlertTriangle,
  CloudUpload,
  Code2,
  FileJson,
  Globe,
  HardDrive,
  Layers,
  LogIn,
  LogOut,
  MousePointerClick,
  Network,
  RefreshCw,
  Save,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type { RuntimeMessage, SessionMeta } from '@/shared/events'
import { authIsValid, type UnwrapSettings } from '@/shared/settings'
import { signInWithGoogleFromPanel, signOutFromPanel } from './auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Stat } from '@/components/ui/stat'
import { cn } from '@/lib/utils'

async function send<T>(msg: RuntimeMessage): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string }
  if (!res?.ok) throw new Error(res?.error ?? 'unknown error')
  return res.result as T
}

export function App(): React.JSX.Element {
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
      try {
        const tab = await chrome.tabs.get(tabId)
        setActiveTab(tab)
      } catch {
        // tab vanished — ignore
      }
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

  const wrap = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const aiReady = !!settings && !!settings.serverUrl && authIsValid(settings.auth)

  return (
    <div className="flex h-full flex-col bg-[var(--color-background)] text-[var(--color-foreground)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-7 place-items-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
            <Zap className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight">Unwrap</div>
            <div
              className="truncate text-[11px] text-[var(--color-muted-foreground)]"
              title={activeTab?.url ?? ''}
            >
              {activeTab?.url ?? 'No active tab'}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
        >
          {settingsOpen ? <X /> : <SettingsIcon />}
        </Button>
      </header>

      <Collapsible open={settingsOpen}>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-[fadeOut_120ms] data-[state=open]:animate-[fadeIn_120ms]">
          {settings && (
            <SettingsPanel
              settings={settings}
              busy={busy}
              onChange={async (patch) => {
                const next = await send<UnwrapSettings>({ kind: 'set_settings', patch })
                setSettingsState(next)
              }}
              onSignIn={() => wrap(() => signInWithGoogleFromPanel())}
              onSignOut={async () => {
                await signOutFromPanel()
                await refresh()
              }}
            />
          )}
          <Separator />
        </CollapsibleContent>
      </Collapsible>

      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        {activeSession ? (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => wrap(() => send({ kind: 'stop_session', sessionId: activeSession.id }))}
            className="flex-1"
          >
            <Square className="fill-current" /> Stop recording
          </Button>
        ) : (
          <Button
            disabled={busy || !activeTab?.id}
            onClick={() => activeTab?.id && wrap(() => send({ kind: 'start_session', tabId: activeTab.id! }))}
            className="flex-1"
          >
            <span className="relative flex size-2 items-center justify-center">
              <span className="absolute inline-flex size-2 animate-ping rounded-full bg-current opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-current" />
            </span>
            Start recording
          </Button>
        )}
        <Button variant="secondary" size="icon" disabled={busy} onClick={refresh} aria-label="Refresh">
          <RefreshCw className={cn(busy && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-[color-mix(in_oklab,var(--color-destructive)_30%,var(--color-border))] bg-[color-mix(in_oklab,var(--color-destructive)_8%,transparent)] px-3 py-2 text-xs text-[var(--color-destructive)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {sessions.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-[var(--color-muted-foreground)]">
            <Layers className="size-8 opacity-50" />
            <div className="text-xs">No sessions yet.</div>
            <div className="text-[11px] opacity-80">Click <strong>Start recording</strong> to capture this tab.</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                aiReady={aiReady}
                busy={busy}
                onStop={() => wrap(() => send({ kind: 'stop_session', sessionId: s.id }))}
                onCaptureStorage={() =>
                  wrap(() => send({ kind: 'capture_storage_state', sessionId: s.id }))
                }
                onExportHar={() => wrap(() => send({ kind: 'export_session', sessionId: s.id, format: 'har' }))}
                onExportJson={() => wrap(() => send({ kind: 'export_session', sessionId: s.id, format: 'json' }))}
                onExportPlaywright={() =>
                  wrap(() => send({ kind: 'export_session', sessionId: s.id, format: 'playwright' }))
                }
                onUpload={() => wrap(() => send({ kind: 'upload_session', sessionId: s.id }))}
                onDelete={async () => {
                  if (!confirm('Delete this session and all its data?')) return
                  await wrap(() => send({ kind: 'delete_session', sessionId: s.id }))
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface SettingsProps {
  settings: UnwrapSettings
  busy: boolean
  onChange: (patch: Partial<UnwrapSettings>) => Promise<void>
  onSignIn: () => void
  onSignOut: () => Promise<void>
}

function SettingsPanel({ settings, busy, onChange, onSignIn, onSignOut }: SettingsProps): React.JSX.Element {
  const [draftUrl, setDraftUrl] = useState(settings.serverUrl)
  useEffect(() => setDraftUrl(settings.serverUrl), [settings.serverUrl])
  const signedIn = authIsValid(settings.auth)
  const dirty = draftUrl.trim() !== settings.serverUrl

  return (
    <div className="flex flex-col gap-3 bg-[var(--color-muted)] px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="server-url">Server URL</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id="server-url"
            type="url"
            value={draftUrl}
            placeholder="https://unwrap-server.example.workers.dev"
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={() => dirty && void onChange({ serverUrl: draftUrl.trim() })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
          />
          {dirty && (
            <Button
              size="icon"
              variant="secondary"
              onClick={() => void onChange({ serverUrl: draftUrl.trim() })}
              aria-label="Save URL"
              title="Save"
            >
              <Save />
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className={cn(
            'size-1.5 rounded-full',
            signedIn ? 'bg-[var(--color-success)]' : 'bg-[var(--color-muted-foreground)]',
          )} />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">
              {signedIn ? settings.auth!.email : 'Signed out'}
            </div>
            <div className="text-[10px] text-[var(--color-muted-foreground)]">
              {signedIn ? 'Authenticated via Google' : 'Sign in to enable AI generation'}
            </div>
          </div>
        </div>
        {signedIn ? (
          <Button variant="secondary" size="sm" onClick={() => void onSignOut()} disabled={busy}>
            <LogOut /> Sign out
          </Button>
        ) : (
          <Button size="sm" onClick={onSignIn} disabled={busy || !settings.serverUrl}>
            <LogIn /> Sign in
          </Button>
        )}
      </div>
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
}: CardProps): React.JSX.Element {
  const started = new Date(session.startedAt)
  const duration = (session.endedAt ?? Date.now()) - session.startedAt
  const recording = session.status === 'recording'

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="min-w-0 flex-1">
          <CardTitle title={session.startUrl}>{labelFor(session.startUrl)}</CardTitle>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-muted-foreground)]">
            <span title={started.toLocaleString()}>{formatTime(started)}</span>
            <span>·</span>
            <span>{formatDuration(duration)}</span>
          </div>
        </div>
        <Badge
          variant={
            session.status === 'recording' ? 'recording'
            : session.status === 'error' ? 'destructive'
            : 'default'
          }
        >
          {recording && (
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-current opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-current" />
            </span>
          )}
          {session.status}
        </Badge>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-3 gap-1.5">
          <Stat icon={<Globe />} label="nav" value={session.counts.navigations} />
          <Stat icon={<MousePointerClick />} label="act" value={session.counts.actions} />
          <Stat icon={<Send />} label="req" value={session.counts.requests} />
          <Stat icon={<Network />} label="res" value={session.counts.responses} />
          <Stat icon={<CameraIcon />} label="shot" value={session.counts.screenshots} />
          <Stat icon={<HardDrive />} label="store" value={session.counts.storageStates} />
          <Stat icon={<Terminal />} label="log" value={session.counts.consoleMessages} />
          <Stat icon={<AlertTriangle />} label="err" value={session.counts.exceptions} emphasis="danger" />
          <Stat icon={<Network />} label="ws" value={session.counts.wsFrames} />
          <Stat icon={<Layers />} label="dom" value={session.counts.domSnapshots} />
          <Stat icon={<Accessibility />} label="ax" value={session.counts.axTrees} />
        </div>

        {session.error && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--color-destructive)_30%,var(--color-border))] bg-[color-mix(in_oklab,var(--color-destructive)_8%,transparent)] px-2 py-1.5 text-[11px] text-[var(--color-destructive)]">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span className="break-words">{session.error}</span>
          </div>
        )}

        <Separator className="my-2.5" />

        <div className="flex flex-wrap gap-1.5">
          {recording && (
            <>
              <Button size="sm" variant="destructive" onClick={onStop} disabled={busy}>
                <Square className="fill-current" /> Stop
              </Button>
              <Button size="sm" variant="secondary" onClick={onCaptureStorage} disabled={busy}>
                <HardDrive /> Capture storage
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={onUpload}
            disabled={busy || !aiReady}
            title={aiReady ? 'Upload to server and open in new tab' : 'Sign in with Google in Settings first'}
          >
            <CloudUpload /> Upload & open
          </Button>
          <Button size="sm" variant="secondary" onClick={onExportPlaywright} disabled={busy}>
            <Code2 /> Playwright
          </Button>
          <Button size="sm" variant="secondary" onClick={onExportHar} disabled={busy}>
            <HardDrive /> HAR
          </Button>
          <Button size="sm" variant="secondary" onClick={onExportJson} disabled={busy}>
            <FileJson /> JSON
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            className="ml-auto text-[var(--color-destructive)] hover:bg-[color-mix(in_oklab,var(--color-destructive)_10%,transparent)] hover:text-[var(--color-destructive)]"
            aria-label="Delete"
          >
            <Trash2 />
          </Button>
        </div>

        {aiReady ? null : (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-muted)] px-2 py-1.5 text-[10px] text-[var(--color-muted-foreground)]">
            <Sparkles className="size-3" />
            Sign in via Settings to enable Upload & AI generation
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CameraIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
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

function formatTime(d: Date): string {
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
