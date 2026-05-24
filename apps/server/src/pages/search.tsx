import { Layout } from './_layout'
import { Card } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { SearchResult, SearchResultKind } from '../search'

const KIND_LABEL: Record<SearchResultKind, string> = {
  project: 'project', route: 'route', endpoint: 'endpoint', graphql: 'graphql',
  'ws-channel': 'ws', 'ws-message-type': 'ws msg', 'console-error': 'error',
}

const KIND_BG: Record<SearchResultKind, string> = {
  project: 'bg-purple-500',
  route: 'bg-blue-500',
  endpoint: 'bg-green-600',
  graphql: 'bg-purple-500',
  'ws-channel': 'bg-amber-600',
  'ws-message-type': 'bg-amber-600',
  'console-error': 'bg-red-500',
}

export function SearchPage({ email, query, results }: { email: string; query: string; results: SearchResult[] }) {
  const grouped = new Map<SearchResultKind, SearchResult[]>()
  for (const r of results) {
    const list = grouped.get(r.kind) ?? []
    list.push(r)
    grouped.set(r.kind, list)
  }
  const orderedKinds: SearchResultKind[] = ['project', 'endpoint', 'graphql', 'route', 'ws-channel', 'ws-message-type', 'console-error']

  return (
    <Layout email={email} wide>
      <form method="get" action="/search" className="flex gap-2 mb-4">
        <input
          type="search" name="q" defaultValue={query} autoFocus required
          placeholder="search across every capture: host, route, endpoint, GraphQL op, WS message, console error…"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button type="submit">Search</Button>
      </form>

      {query === '' && (
        <div className="text-center text-muted-foreground py-12">Type a query to search across every captured session.</div>
      )}
      {query !== '' && results.length === 0 && (
        <div className="text-center text-muted-foreground py-12">No matches for <code className="rounded bg-muted px-1.5 py-0.5">{query}</code>.</div>
      )}
      {query !== '' && results.length > 0 && (
        <>
          <div className="text-xs text-muted-foreground mb-3">
            {results.length} match{results.length === 1 ? '' : 'es'} across {grouped.size} categor{grouped.size === 1 ? 'y' : 'ies'}.
          </div>
          {orderedKinds.filter((k) => grouped.has(k)).map((k) => (
            <section key={k} className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-2">{KIND_LABEL[k]} ({grouped.get(k)!.length})</h2>
              <Card className="overflow-hidden p-0">
                {grouped.get(k)!.map((r, i) => <ResultRow key={i} r={r} />)}
              </Card>
            </section>
          ))}
        </>
      )}
    </Layout>
  )
}

function ResultRow({ r }: { r: SearchResult }) {
  const before = r.label.slice(0, r.matchStart)
  const match = r.label.slice(r.matchStart, r.matchEnd)
  const after = r.label.slice(r.matchEnd)
  return (
    <a href={r.href} className="grid grid-cols-[70px_1fr_auto] gap-2.5 items-baseline px-3 py-2 border-b last:border-b-0 no-underline text-foreground hover:bg-muted/50">
      <span className={cn('inline-block text-center min-w-[50px] px-2 py-0.5 rounded-full text-[10px] font-bold uppercase text-white', KIND_BG[r.kind])}>{KIND_LABEL[r.kind]}</span>
      <code className="text-xs break-all">
        {before}
        {match.length > 0 && <mark className="rounded bg-amber-400/40 px-0.5 text-foreground">{match}</mark>}
        {after}
      </code>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{r.context}</span>
    </a>
  )
}
