import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

// Anything `html` will accept inside an interpolation. We type our
// pages this way so that nested `html` calls (which can return a
// Promise when their interpolations are async) flow through without
// fighting the type system.
export type Renderable = HtmlEscapedString | Promise<HtmlEscapedString>

const STYLES = `
:root {
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --bg: #ffffff;
  --fg: #111418;
  --muted: #5e6772;
  --border: #e4e7eb;
  --accent: #2f6feb;
  --danger: #d64545;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --fg: #e7eaee; --muted: #8a93a0; --border: #2c3036; --accent: #6ea8ff; --danger: #ff6b6b; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font-size: 14px; line-height: 1.5; }
.wrap { max-width: 960px; margin: 0 auto; padding: 24px; }
header.app-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); padding: 12px 24px; }
header.app-header .header-search { flex: 1; max-width: 480px; }
header.app-header .header-search input { width: 100%; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-size: 13px; }
header.app-header .header-search input:focus { outline: 1px solid var(--accent); }
header.app-header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header.app-header h1 a { color: inherit; text-decoration: none; }
header.app-header .user { color: var(--muted); font-size: 12px; }
header.app-header .user a { color: var(--muted); margin-left: 12px; }
a { color: var(--accent); }
button, .btn {
  background: var(--accent); color: white; border: 0; border-radius: 6px;
  padding: 8px 14px; font: inherit; cursor: pointer; text-decoration: none; display: inline-block;
}
button.secondary, .btn.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
button.danger, .btn.danger { background: var(--danger); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.muted { color: var(--muted); }
.empty { text-align: center; padding: 60px 12px; color: var(--muted); }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.card .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.card h3 { margin: 0 0 4px 0; font-size: 14px; }
.card .meta { color: var(--muted); font-size: 12px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--muted); }
.badge.ok { color: #1f9d55; border-color: #1f9d55; }
.section { margin-top: 24px; }
.section h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
pre {
  background: rgba(127,127,127,0.08); border-radius: 8px; padding: 14px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  white-space: pre-wrap; word-break: break-word;
}
.error { background: rgba(214, 69, 69, 0.08); color: var(--danger); padding: 10px 14px; border-radius: 6px; border: 1px solid rgba(214, 69, 69, 0.3); margin: 12px 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
`

interface LayoutProps {
  title: string
  email?: string
  body: Renderable
  scripts?: Renderable
}

export function Layout({ title, email, body, scripts }: LayoutProps): Renderable {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — Unwrap</title>
    <style>${STYLES}</style>
  </head>
  <body>
    <header class="app-header">
      <h1><a href="/">Unwrap</a></h1>
      ${email
        ? html`<form method="get" action="/search" class="header-search">
            <input type="search" name="q" placeholder="Search captures…" />
          </form>`
        : ''}
      <div class="user">
        ${email
          ? html`${email} <a href="/settings/tokens">API tokens</a> <a href="/auth/sign-out">Sign out</a>`
          : html`<a href="/auth/google/start?mode=web">Sign in</a>`}
      </div>
    </header>
    <div class="wrap">${body}</div>
    ${scripts ?? ''}
  </body>
</html>`
}
