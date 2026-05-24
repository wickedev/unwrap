import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import type { PageHeatmap } from '../project-heatmap'
import { renderHeatmapSvg } from '../project-heatmap'

export function ProjectHeatmapPage({ email, host, pages }: { email: string; host: string; pages: PageHeatmap[] }) {
  const totalClicks = pages.reduce((n, p) => n + p.clicks.length, 0)
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Click heatmap</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Click positions from every captured session, overlaid on a representative screenshot per page.
        Coordinates are normalized to viewport size so heatmaps work across captures with different viewport widths.
      </p>

      {pages.length === 0
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No click positions captured yet.</p>
            <p className="text-xs mt-2">Click position capture was added recently — existing sessions don't have it. Reload the Unwrap extension and record one new session, then come back.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 flex gap-4 flex-wrap text-xs">
                <div><strong>{pages.length}</strong> page{pages.length === 1 ? '' : 's'} with clicks</div>
                <div><strong>{totalClicks}</strong> total clicks</div>
                <div><strong>{pages.filter((p) => p.screenshot).length}</strong> with screenshot background</div>
              </CardContent>
            </Card>

            {pages.map((p) => (
              <section key={p.normalizedPath} className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-2">
                  <code>{p.normalizedPath}</code>
                  <span className="text-xs text-muted-foreground font-normal ml-2">
                    {p.clicks.length} click{p.clicks.length === 1 ? '' : 's'} · {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'}
                  </span>
                </h2>
                <Card className="p-1.5"><div dangerouslySetInnerHTML={{ __html: renderHeatmapSvg(p, p.screenshot ? `/api/sessions/${p.screenshot.sessionId}/screenshots/${p.screenshot.storedRef}` : undefined) }} /></Card>
              </section>
            ))}
          </>
        )}
    </Layout>
  )
}
