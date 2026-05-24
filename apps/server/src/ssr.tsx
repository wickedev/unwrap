import * as React from 'react'
import { renderToString } from 'react-dom/server'

// Render a React element to a complete HTML document and wrap it in a
// Response with the right content-type. Inserts our Tailwind-compiled
// CSS link + a viewport meta + the page title.
export function ssr(element: React.ReactElement, opts: { title: string; status?: number } = { title: 'Unwrap' }): Response {
  const body = renderToString(element)
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <link rel="stylesheet" href="/global.css" />
  </head>
  <body>${body}</body>
</html>`
  return new Response(html, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
