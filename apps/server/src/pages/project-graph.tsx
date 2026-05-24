import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import type { ProjectGraph } from '../project-graph'
import { renderProjectGraphSvg } from '../project-graph'

export function ProjectGraphPage({ email, host, graph }: { email: string; host: string; graph: ProjectGraph }) {
  const { svg, height } = renderProjectGraphSvg(graph)
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Page → API dependency graph</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Each line connects a page (left) to an API endpoint or GraphQL op (right) that was called while the user was on that page.
        Line thickness scales with total call count across every captured session. Hover any node or edge for details.
      </p>

      <Card className="mb-4">
        <CardContent className="p-4 flex gap-6 flex-wrap text-xs items-center">
          <div><strong>{graph.pageCount}</strong> pages</div>
          <div><strong>{graph.endpointCount}</strong> endpoints</div>
          <div><strong>{graph.edgeCount}</strong> page→endpoint links</div>
          <div className="ml-auto flex gap-3 items-center text-xs flex-wrap">
            <LegendItem color="#2f6feb" label="GET / page" />
            <LegendItem color="#1f9d55" label="POST" />
            <LegendItem color="#b88300" label="PUT/PATCH" />
            <LegendItem color="#d64545" label="DELETE" />
            <LegendItem color="#7c4ac2" label="GraphQL" />
          </div>
        </CardContent>
      </Card>

      {graph.edgeCount === 0
        ? (
          <div className="text-center text-muted-foreground py-12">
            No page→endpoint links to draw yet. Likely cause: the captures were made before the extension started collecting API calls. Reload the extension and record one more session.
          </div>
        )
        : (
          <div className="overflow-x-auto rounded-lg border p-2 bg-card">
            <div style={{ minHeight: `${height}px` }} dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        )}
    </Layout>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
