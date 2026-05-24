import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { SearchResult, SearchResultKind } from '../search'

const KIND_LABEL: Record<SearchResultKind, string> = {
  project: 'project',
  route: 'route',
  endpoint: 'endpoint',
  graphql: 'graphql',
  'ws-channel': 'ws',
  'ws-message-type': 'ws msg',
  'console-error': 'error',
}

const KIND_COLOR: Record<SearchResultKind, string> = {
  project: '#7c4ac2',
  route: '#2f6feb',
  endpoint: '#1f9d55',
  graphql: '#7c4ac2',
  'ws-channel': '#b88300',
  'ws-message-type': '#b88300',
  'console-error': '#d64545',
}

export function SearchPage({
  email,
  query,
  results,
}: {
  email: string
  query: string
  results: SearchResult[]
}): Renderable {
  // Group results by kind so the list is easy to scan.
  const grouped = new Map<SearchResultKind, SearchResult[]>()
  for (const r of results) {
    const list = grouped.get(r.kind) ?? []
    list.push(r)
    grouped.set(r.kind, list)
  }
  const orderedKinds: SearchResultKind[] = ['project', 'endpoint', 'graphql', 'route', 'ws-channel', 'ws-message-type', 'console-error']

  return Layout({
    title: query ? `Search · ${query}` : 'Search',
    email,
    body: html`
      <form method="get" action="/search" style="display: flex; gap: 8px; margin-bottom: 16px;">
        <input
          type="search" name="q" value="${query}"
          autofocus required
          placeholder="search across every capture: host, route, endpoint, GraphQL op, WS message, console error…"
          style="flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit;"
        />
        <button type="submit" class="btn">Search</button>
      </form>

      ${query === ''
        ? html`<div class="empty">Type a query to search across every captured session.</div>`
        : results.length === 0
          ? html`<div class="empty">No matches for <code>${query}</code>.</div>`
          : html`
            <div class="meta" style="margin-bottom: 12px; font-size: 12px;">${results.length} match${results.length === 1 ? '' : 'es'} across ${grouped.size} categor${grouped.size === 1 ? 'y' : 'ies'}.</div>
            ${orderedKinds.filter((k) => grouped.has(k)).map((k) => html`
              <div class="section">
                <h2>${KIND_LABEL[k]} (${grouped.get(k)!.length})</h2>
                <div class="card" style="padding: 0;">
                  ${grouped.get(k)!.map((r) => renderResult(r))}
                </div>
              </div>
            `)}
          `}
      <style>${raw(SEARCH_CSS)}</style>
    `,
  })
}

function renderResult(r: SearchResult): Renderable {
  const label = highlight(r.label, r.matchStart, r.matchEnd)
  return html`<a class="search-result" href="${r.href}">
    <span class="kind-pill" style="background-color: ${KIND_COLOR[r.kind]};">${KIND_LABEL[r.kind]}</span>
    <span class="result-label"><code>${raw(label)}</code></span>
    <span class="meta result-context">${r.context}</span>
  </a>`
}

function highlight(text: string, start: number, end: number): string {
  if (end <= start) return escapeHtml(text)
  return (
    escapeHtml(text.slice(0, start)) +
    '<mark>' +
    escapeHtml(text.slice(start, end)) +
    '</mark>' +
    escapeHtml(text.slice(end))
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const SEARCH_CSS = `
.search-result {
  display: grid; grid-template-columns: 70px 1fr auto; gap: 10px; align-items: baseline;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  text-decoration: none; color: var(--fg);
}
.search-result:last-child { border-bottom: 0; }
.search-result:hover { background: rgba(127,127,127,0.05); }
.search-result .kind-pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 10px; font-weight: 700; text-transform: uppercase; color: white;
  text-align: center; min-width: 50px;
}
.search-result .result-label code {
  font-size: 12px; word-break: break-all;
}
.search-result .result-context {
  font-size: 11px; white-space: nowrap;
}
mark { background: color-mix(in oklab, #b88300 35%, transparent); color: inherit; padding: 0 2px; border-radius: 3px; }
`
