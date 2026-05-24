import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectDiff, ChangedEndpoint, ChangedGraphqlOp, SchemaChangeLine } from '../project-compare'
import type { GraphqlOperation } from '../graphql-extract'
import type { EndpointEntry, RouteEntry, AssetEntry } from '../project-aggregate'

export function ProjectComparePage({
  email,
  diff,
}: {
  email: string
  diff: ProjectDiff
}): Renderable {
  return Layout({
    title: `Compare · ${diff.left.host} vs ${diff.right.host}`,
    email,
    body: html`
      <p>
        <a href="/projects/${encodeURIComponent(diff.left.host)}">← back to ${diff.left.host}</a>
      </p>
      <h2 style="margin-top: 4px;">${diff.left.host} <span style="color: var(--muted); font-weight: 400;">→</span> ${diff.right.host}</h2>
      <p class="muted">
        Left side is the baseline (<strong>${diff.left.host}</strong>, ${diff.left.sessionCount} session${diff.left.sessionCount === 1 ? '' : 's'}); right side is the comparison
        (<strong>${diff.right.host}</strong>, ${diff.right.sessionCount} session${diff.right.sessionCount === 1 ? '' : 's'}).
        Items grouped by what changed in the right project relative to the left.
      </p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Endpoints +', diff.endpoints.addedInRight.length, '#1f9d55')}
        ${kpi('Endpoints −', diff.endpoints.removedInRight.length, '#d64545')}
        ${kpi('Endpoints ~', diff.endpoints.changed.length, '#b88300')}
        ${kpi('Routes +', diff.routes.addedInRight.length, '#1f9d55')}
        ${kpi('Routes −', diff.routes.removedInRight.length, '#d64545')}
        ${kpi('GraphQL ~', diff.graphqlOps.changed.length, '#7c4ac2')}
        ${kpi('Same endpoints', diff.endpoints.bothUnchanged, 'var(--muted)')}
      </div>

      ${section('Endpoints added in right',
        diff.endpoints.addedInRight.length === 0
          ? emptyMsg('No new endpoints in the right project.')
          : html`${diff.endpoints.addedInRight.map((e) => renderEndpointSummary(e, '+'))}`)}

      ${section('Endpoints removed in right',
        diff.endpoints.removedInRight.length === 0
          ? emptyMsg('No removed endpoints.')
          : html`${diff.endpoints.removedInRight.map((e) => renderEndpointSummary(e, '−'))}`)}

      ${section('Endpoints with changes',
        diff.endpoints.changed.length === 0
          ? emptyMsg('Every shared endpoint has matching status histograms and response schemas.')
          : html`${diff.endpoints.changed.map((c) => renderChangedEndpoint(c))}`)}

      ${section('GraphQL ops added/removed/changed',
        diff.graphqlOps.addedInRight.length + diff.graphqlOps.removedInRight.length + diff.graphqlOps.changed.length === 0
          ? emptyMsg('No GraphQL changes.')
          : html`
            ${diff.graphqlOps.addedInRight.map((o) => renderGqlSummary(o, '+'))}
            ${diff.graphqlOps.removedInRight.map((o) => renderGqlSummary(o, '−'))}
            ${diff.graphqlOps.changed.map((c) => renderChangedGql(c))}
          `)}

      ${section('Routes added in right',
        diff.routes.addedInRight.length === 0
          ? emptyMsg('No new routes.')
          : html`<ul class="diff-list">${diff.routes.addedInRight.map((r) => renderRouteRow(r, '+'))}</ul>`)}

      ${section('Routes removed in right',
        diff.routes.removedInRight.length === 0
          ? emptyMsg('No removed routes.')
          : html`<ul class="diff-list">${diff.routes.removedInRight.map((r) => renderRouteRow(r, '−'))}</ul>`)}

      ${section('Static assets diff',
        diff.staticAssets.addedInRight.length + diff.staticAssets.removedInRight.length === 0
          ? emptyMsg('Same asset pathnames on both sides.')
          : html`
            ${diff.staticAssets.addedInRight.length > 0
              ? html`<details><summary class="muted">${diff.staticAssets.addedInRight.length} asset${diff.staticAssets.addedInRight.length === 1 ? '' : 's'} added in right</summary>
                  <ul class="diff-list">${diff.staticAssets.addedInRight.map((a) => renderAssetRow(a, '+'))}</ul>
                </details>`
              : ''}
            ${diff.staticAssets.removedInRight.length > 0
              ? html`<details><summary class="muted">${diff.staticAssets.removedInRight.length} asset${diff.staticAssets.removedInRight.length === 1 ? '' : 's'} removed in right</summary>
                  <ul class="diff-list">${diff.staticAssets.removedInRight.map((a) => renderAssetRow(a, '−'))}</ul>
                </details>`
              : ''}
          `)}

      <style>${raw(DIFF_CSS)}</style>
    `,
  })
}

function section(title: string, body: Renderable): Renderable {
  return html`<div class="section">
    <h2>${title}</h2>
    ${body}
  </div>`
}

function emptyMsg(msg: string): Renderable {
  return html`<div class="muted" style="padding: 8px 0; font-size: 12px;">${msg}</div>`
}

function kpi(label: string, value: number, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function renderEndpointSummary(e: EndpointEntry, sign: '+' | '−'): Renderable {
  return html`<div class="endpoint-row ${sign === '+' ? 'added' : 'removed'}">
    <span class="sign">${sign}</span>
    <span class="method m-${e.method.toLowerCase()}">${e.method}</span>
    <code>${e.normalizedPath}</code>
    <span class="meta">${e.callCount} call${e.callCount === 1 ? '' : 's'} · statuses ${Object.keys(e.statuses).sort().join(',')}</span>
  </div>`
}

function renderChangedEndpoint(c: ChangedEndpoint): Renderable {
  return html`<div class="endpoint-row changed">
    <span class="sign">~</span>
    <span class="method m-${c.method.toLowerCase()}">${c.method}</span>
    <code>${c.normalizedPath}</code>
    <div class="diff-detail">
      ${c.statusesAddedInRight.length > 0
        ? html`<div><span class="badge added-bg">+ status</span> ${c.statusesAddedInRight.join(', ')}</div>`
        : ''}
      ${c.statusesRemovedInRight.length > 0
        ? html`<div><span class="badge removed-bg">− status</span> ${c.statusesRemovedInRight.join(', ')}</div>`
        : ''}
      ${c.schemaChanges.length > 0
        ? html`<details><summary class="muted">${c.schemaChanges.length} schema change${c.schemaChanges.length === 1 ? '' : 's'}</summary>
            <ul class="schema-changes">${c.schemaChanges.map(renderSchemaChange)}</ul>
          </details>`
        : ''}
    </div>
  </div>`
}

function renderSchemaChange(line: SchemaChangeLine): Renderable {
  const cls = line.kind === '+' ? 'added' : line.kind === '-' ? 'removed' : 'changed'
  return html`<li class="${cls}"><span class="sign">${line.kind}</span> <code>${line.path}</code> <span class="meta">${line.detail}</span></li>`
}

function renderGqlSummary(o: GraphqlOperation, sign: '+' | '−'): Renderable {
  return html`<div class="endpoint-row ${sign === '+' ? 'added' : 'removed'}">
    <span class="sign">${sign}</span>
    <span class="gql-tag">GQL</span>
    <code>${o.operationType} ${o.name}</code>
    <span class="meta">${o.callCount} call${o.callCount === 1 ? '' : 's'}${o.typenames.length > 0 ? ` · returns ${o.typenames.join(', ')}` : ''}</span>
  </div>`
}

function renderChangedGql(c: ChangedGraphqlOp): Renderable {
  return html`<div class="endpoint-row changed">
    <span class="sign">~</span>
    <span class="gql-tag">GQL</span>
    <code>${c.left.operationType} ${c.name}</code>
    <div class="diff-detail">
      ${c.variablesAddedInRight.length > 0
        ? html`<div><span class="badge added-bg">+ var</span> ${c.variablesAddedInRight.map((v) => `$${v.name}: ${v.type}`).join(', ')}</div>`
        : ''}
      ${c.variablesRemovedInRight.length > 0
        ? html`<div><span class="badge removed-bg">− var</span> ${c.variablesRemovedInRight.map((v) => `$${v.name}: ${v.type}`).join(', ')}</div>`
        : ''}
      ${c.variablesTypeChanged.length > 0
        ? html`<div><span class="badge changed-bg">~ var</span> ${c.variablesTypeChanged.map((v) => `$${v.name}: ${v.leftType} → ${v.rightType}`).join(', ')}</div>`
        : ''}
      ${c.typenamesAddedInRight.length > 0
        ? html`<div><span class="badge added-bg">+ type</span> ${c.typenamesAddedInRight.join(', ')}</div>`
        : ''}
      ${c.typenamesRemovedInRight.length > 0
        ? html`<div><span class="badge removed-bg">− type</span> ${c.typenamesRemovedInRight.join(', ')}</div>`
        : ''}
    </div>
  </div>`
}

function renderRouteRow(r: RouteEntry, sign: '+' | '−'): Renderable {
  return html`<li class="${sign === '+' ? 'added' : 'removed'}"><span class="sign">${sign}</span> <code>${r.normalizedPath}</code> <span class="meta">${r.visitCount} visit${r.visitCount === 1 ? '' : 's'}</span></li>`
}

function renderAssetRow(a: AssetEntry, sign: '+' | '−'): Renderable {
  return html`<li class="${sign === '+' ? 'added' : 'removed'}"><span class="sign">${sign}</span> <code>${a.url}</code> <span class="meta">${a.mimeType}</span></li>`
}

const DIFF_CSS = `
.endpoint-row {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 6px; border: 1px solid transparent;
  margin-bottom: 6px;
}
.endpoint-row .sign { font-family: ui-monospace, monospace; font-weight: 700; min-width: 14px; }
.endpoint-row.added { background: color-mix(in oklab, #1f9d55 6%, transparent); border-color: color-mix(in oklab, #1f9d55 25%, transparent); }
.endpoint-row.added .sign { color: #1f9d55; }
.endpoint-row.removed { background: color-mix(in oklab, #d64545 6%, transparent); border-color: color-mix(in oklab, #d64545 25%, transparent); }
.endpoint-row.removed .sign { color: #d64545; }
.endpoint-row.changed { background: color-mix(in oklab, #b88300 6%, transparent); border-color: color-mix(in oklab, #b88300 25%, transparent); }
.endpoint-row.changed .sign { color: #b88300; }
.endpoint-row code { font-size: 12px; word-break: break-all; }
.endpoint-row .meta { color: var(--muted); font-size: 11px; margin-left: auto; }
.diff-detail { flex-basis: 100%; margin-top: 6px; font-size: 11px; padding-left: 22px; }
.diff-detail div { padding: 2px 0; }
.diff-detail .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-right: 4px; font-weight: 600; }
.diff-detail .added-bg { background: color-mix(in oklab, #1f9d55 20%, transparent); color: #1f9d55; }
.diff-detail .removed-bg { background: color-mix(in oklab, #d64545 20%, transparent); color: #d64545; }
.diff-detail .changed-bg { background: color-mix(in oklab, #b88300 20%, transparent); color: #b88300; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; font-family: ui-monospace, monospace; color: white; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
.gql-tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; background: #7c4ac2; color: white; font-family: ui-monospace, monospace; }
.schema-changes { list-style: none; padding-left: 0; margin: 6px 0 0; font-family: ui-monospace, monospace; }
.schema-changes li { padding: 2px 0; }
.schema-changes .added .sign, .schema-changes .added code { color: #1f9d55; }
.schema-changes .removed .sign, .schema-changes .removed code { color: #d64545; }
.schema-changes .changed .sign, .schema-changes .changed code { color: #b88300; }
.diff-list { list-style: none; padding-left: 0; }
.diff-list li { padding: 4px 10px; border-radius: 4px; margin-bottom: 3px; }
.diff-list li.added { background: color-mix(in oklab, #1f9d55 4%, transparent); }
.diff-list li.removed { background: color-mix(in oklab, #d64545 4%, transparent); }
.diff-list .sign { font-weight: 700; font-family: ui-monospace, monospace; margin-right: 6px; }
.diff-list .added .sign { color: #1f9d55; }
.diff-list .removed .sign { color: #d64545; }
.diff-list .meta { color: var(--muted); font-size: 11px; margin-left: 6px; }
`
