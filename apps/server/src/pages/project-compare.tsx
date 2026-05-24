import * as React from 'react'
import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { MethodPill } from './project'
import { cn } from '@unwrap/ui'
import type { ProjectDiff, ChangedEndpoint, ChangedGraphqlOp, SchemaChangeLine } from '../project-compare'
import type { GraphqlOperation } from '../graphql-extract'
import type { EndpointEntry, RouteEntry, AssetEntry } from '../project-aggregate'

export function ProjectComparePage({ email, diff }: { email: string; diff: ProjectDiff }) {
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(diff.left.host)}`} className="text-primary text-sm">← back to {diff.left.host}</a></p>
      <h2 className="m-0 text-xl font-bold">{diff.left.host} <span className="text-muted-foreground font-normal">→</span> {diff.right.host}</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Left side is the baseline (<strong>{diff.left.host}</strong>, {diff.left.sessionCount} session{diff.left.sessionCount === 1 ? '' : 's'}); right is the comparison
        (<strong>{diff.right.host}</strong>, {diff.right.sessionCount} session{diff.right.sessionCount === 1 ? '' : 's'}).
      </p>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
          <Kpi label="Endpoints +" value={diff.endpoints.addedInRight.length} color="text-success" />
          <Kpi label="Endpoints −" value={diff.endpoints.removedInRight.length} color="text-danger" />
          <Kpi label="Endpoints ~" value={diff.endpoints.changed.length} color="text-warning" />
          <Kpi label="Routes +" value={diff.routes.addedInRight.length} color="text-success" />
          <Kpi label="Routes −" value={diff.routes.removedInRight.length} color="text-danger" />
          <Kpi label="GraphQL ~" value={diff.graphqlOps.changed.length} color="text-purple-500" />
          <Kpi label="Same endpoints" value={diff.endpoints.bothUnchanged} color="text-muted-foreground" />
        </CardContent>
      </Card>

      <Section title="Endpoints added in right">
        {diff.endpoints.addedInRight.length === 0
          ? <Empty msg="No new endpoints in the right project." />
          : diff.endpoints.addedInRight.map((e) => <EndpointSummary key={e.key} e={e} sign="+" />)}
      </Section>

      <Section title="Endpoints removed in right">
        {diff.endpoints.removedInRight.length === 0
          ? <Empty msg="No removed endpoints." />
          : diff.endpoints.removedInRight.map((e) => <EndpointSummary key={e.key} e={e} sign="−" />)}
      </Section>

      <Section title="Endpoints with changes">
        {diff.endpoints.changed.length === 0
          ? <Empty msg="Every shared endpoint has matching status histograms and response schemas." />
          : diff.endpoints.changed.map((c, i) => <ChangedEndpointRow key={i} c={c} />)}
      </Section>

      <Section title="GraphQL ops added/removed/changed">
        {diff.graphqlOps.addedInRight.length + diff.graphqlOps.removedInRight.length + diff.graphqlOps.changed.length === 0
          ? <Empty msg="No GraphQL changes." />
          : (
            <>
              {diff.graphqlOps.addedInRight.map((o) => <GqlSummary key={o.name} o={o} sign="+" />)}
              {diff.graphqlOps.removedInRight.map((o) => <GqlSummary key={o.name} o={o} sign="−" />)}
              {diff.graphqlOps.changed.map((c) => <ChangedGqlRow key={c.name} c={c} />)}
            </>
          )}
      </Section>

      <Section title="Routes added in right">
        {diff.routes.addedInRight.length === 0
          ? <Empty msg="No new routes." />
          : <ul className="list-none p-0 m-0 space-y-1">{diff.routes.addedInRight.map((r) => <RouteRow key={r.normalizedPath} r={r} sign="+" />)}</ul>}
      </Section>

      <Section title="Routes removed in right">
        {diff.routes.removedInRight.length === 0
          ? <Empty msg="No removed routes." />
          : <ul className="list-none p-0 m-0 space-y-1">{diff.routes.removedInRight.map((r) => <RouteRow key={r.normalizedPath} r={r} sign="−" />)}</ul>}
      </Section>

      <Section title="Static assets diff">
        {diff.staticAssets.addedInRight.length + diff.staticAssets.removedInRight.length === 0
          ? <Empty msg="Same asset pathnames on both sides." />
          : (
            <>
              {diff.staticAssets.addedInRight.length > 0 && (
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer">{diff.staticAssets.addedInRight.length} asset{diff.staticAssets.addedInRight.length === 1 ? '' : 's'} added in right</summary>
                  <ul className="list-none p-0 m-2 space-y-1">{diff.staticAssets.addedInRight.map((a) => <AssetRow key={a.url} a={a} sign="+" />)}</ul>
                </details>
              )}
              {diff.staticAssets.removedInRight.length > 0 && (
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer">{diff.staticAssets.removedInRight.length} asset{diff.staticAssets.removedInRight.length === 1 ? '' : 's'} removed in right</summary>
                  <ul className="list-none p-0 m-2 space-y-1">{diff.staticAssets.removedInRight.map((a) => <AssetRow key={a.url} a={a} sign="−" />)}</ul>
                </details>
              )}
            </>
          )}
      </Section>
    </Layout>
  )
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className={cn('text-lg font-semibold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold m-0 mb-3">{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-xs text-muted-foreground py-2">{msg}</div>
}

function rowClass(kind: 'added' | 'removed' | 'changed') {
  return cn('flex items-baseline gap-2 flex-wrap px-3 py-2 rounded-md border mb-1',
    kind === 'added' && 'border-success/25 bg-success/5',
    kind === 'removed' && 'border-danger/25 bg-danger/5',
    kind === 'changed' && 'border-warning/25 bg-warning/5',
  )
}
function signClass(kind: 'added' | 'removed' | 'changed') {
  return cn('font-mono font-bold min-w-[14px]',
    kind === 'added' && 'text-success',
    kind === 'removed' && 'text-danger',
    kind === 'changed' && 'text-warning',
  )
}

function EndpointSummary({ e, sign }: { e: EndpointEntry; sign: '+' | '−' }) {
  const kind = sign === '+' ? 'added' : 'removed'
  return (
    <div className={rowClass(kind)}>
      <span className={signClass(kind)}>{sign}</span>
      <MethodPill method={e.method} />
      <code>{e.normalizedPath}</code>
      <span className="text-xs text-muted-foreground ml-auto">{e.callCount} call{e.callCount === 1 ? '' : 's'} · statuses {Object.keys(e.statuses).sort().join(',')}</span>
    </div>
  )
}

function ChangedEndpointRow({ c }: { c: ChangedEndpoint }) {
  return (
    <div className={rowClass('changed')}>
      <span className={signClass('changed')}>~</span>
      <MethodPill method={c.method} />
      <code>{c.normalizedPath}</code>
      <div className="basis-full mt-2 text-xs pl-5 space-y-1">
        {c.statusesAddedInRight.length > 0 && <div><DiffPill kind="add">+ status</DiffPill> {c.statusesAddedInRight.join(', ')}</div>}
        {c.statusesRemovedInRight.length > 0 && <div><DiffPill kind="remove">− status</DiffPill> {c.statusesRemovedInRight.join(', ')}</div>}
        {c.schemaChanges.length > 0 && (
          <details>
            <summary className="text-xs text-muted-foreground cursor-pointer">{c.schemaChanges.length} schema change{c.schemaChanges.length === 1 ? '' : 's'}</summary>
            <ul className="list-none p-0 mt-1.5 font-mono space-y-0.5">{c.schemaChanges.map((sc, i) => <SchemaChangeRow key={i} line={sc} />)}</ul>
          </details>
        )}
      </div>
    </div>
  )
}

function DiffPill({ kind, children }: { kind: 'add' | 'remove' | 'change'; children: React.ReactNode }) {
  return (
    <span className={cn('inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold mr-1',
      kind === 'add' && 'bg-success/20 text-success',
      kind === 'remove' && 'bg-danger/20 text-danger',
      kind === 'change' && 'bg-warning/20 text-warning',
    )}>{children}</span>
  )
}

function SchemaChangeRow({ line }: { line: SchemaChangeLine }) {
  const cls = line.kind === '+' ? 'text-success' : line.kind === '-' ? 'text-danger' : 'text-warning'
  return <li className="text-xs"><span className={cn('font-bold mr-1', cls)}>{line.kind}</span> <code className={cls}>{line.path}</code> <span className="text-muted-foreground ml-1">{line.detail}</span></li>
}

function GqlSummary({ o, sign }: { o: GraphqlOperation; sign: '+' | '−' }) {
  const kind = sign === '+' ? 'added' : 'removed'
  return (
    <div className={rowClass(kind)}>
      <span className={signClass(kind)}>{sign}</span>
      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500 text-white font-mono">GQL</span>
      <code>{o.operationType} {o.name}</code>
      <span className="text-xs text-muted-foreground ml-auto">{o.callCount} call{o.callCount === 1 ? '' : 's'}{o.typenames.length > 0 ? ` · returns ${o.typenames.join(', ')}` : ''}</span>
    </div>
  )
}

function ChangedGqlRow({ c }: { c: ChangedGraphqlOp }) {
  return (
    <div className={rowClass('changed')}>
      <span className={signClass('changed')}>~</span>
      <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500 text-white font-mono">GQL</span>
      <code>{c.left.operationType} {c.name}</code>
      <div className="basis-full mt-2 text-xs pl-5 space-y-1">
        {c.variablesAddedInRight.length > 0 && <div><DiffPill kind="add">+ var</DiffPill> {c.variablesAddedInRight.map((v) => `$${v.name}: ${v.type}`).join(', ')}</div>}
        {c.variablesRemovedInRight.length > 0 && <div><DiffPill kind="remove">− var</DiffPill> {c.variablesRemovedInRight.map((v) => `$${v.name}: ${v.type}`).join(', ')}</div>}
        {c.variablesTypeChanged.length > 0 && <div><DiffPill kind="change">~ var</DiffPill> {c.variablesTypeChanged.map((v) => `$${v.name}: ${v.leftType} → ${v.rightType}`).join(', ')}</div>}
        {c.typenamesAddedInRight.length > 0 && <div><DiffPill kind="add">+ type</DiffPill> {c.typenamesAddedInRight.join(', ')}</div>}
        {c.typenamesRemovedInRight.length > 0 && <div><DiffPill kind="remove">− type</DiffPill> {c.typenamesRemovedInRight.join(', ')}</div>}
      </div>
    </div>
  )
}

function RouteRow({ r, sign }: { r: RouteEntry; sign: '+' | '−' }) {
  const kind = sign === '+' ? 'added' : 'removed'
  return <li className={cn('px-3 py-1.5 rounded-md', kind === 'added' && 'bg-success/5', kind === 'removed' && 'bg-danger/5')}>
    <span className={signClass(kind)}>{sign}</span> <code>{r.normalizedPath}</code> <span className="text-xs text-muted-foreground ml-1.5">{r.visitCount} visit{r.visitCount === 1 ? '' : 's'}</span>
  </li>
}

function AssetRow({ a, sign }: { a: AssetEntry; sign: '+' | '−' }) {
  const kind = sign === '+' ? 'added' : 'removed'
  return <li className={cn('px-3 py-1.5 rounded-md', kind === 'added' && 'bg-success/5', kind === 'removed' && 'bg-danger/5')}>
    <span className={signClass(kind)}>{sign}</span> <code>{a.url}</code> <span className="text-xs text-muted-foreground ml-1.5">{a.mimeType}</span>
  </li>
}
