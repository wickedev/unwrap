# @unwrap/cli

Headless capture for [Unwrap](../server) — drives a Playwright Chromium
through a list of URLs, captures network + console + a final screenshot,
and uploads the result as a regular session.

The point: get Unwrap into CI. Capture before / after a deploy, and the
server's auto-diff against the previous capture of the same host
produces a "what changed in the API surface" report you can post to a
PR.

## Install

```sh
pnpm add -D @unwrap/cli
# also installs Playwright; if first run, fetch a browser:
pnpm exec playwright install chromium
```

## Mint a token

Sign into the Unwrap web UI, open **API tokens** in the header, mint a
labelled token. Treat it like a password.

## Capture

```sh
npx @unwrap/cli capture \
  --server=https://your-unwrap-server \
  --token=uw_ci_... \
  --host=staging.example.com \
  https://staging.example.com/login \
  https://staging.example.com/dashboard \
  https://staging.example.com/settings
```

Or with env vars:

```sh
UNWRAP_SERVER=https://your-unwrap-server \
UNWRAP_TOKEN=uw_ci_... \
npx @unwrap/cli capture https://staging.example.com/login https://staging.example.com/dashboard
```

## Options

| Flag | Default | Notes |
|---|---|---|
| `--server=URL` | `$UNWRAP_SERVER` | Unwrap server origin |
| `--token=TOKEN` | `$UNWRAP_TOKEN` | API token from `/settings/tokens` |
| `--host=HOST` | host of first URL | Override the host the upload counts toward |
| `--dwell=MS` | `1500` | Wait per URL for late XHRs to settle |
| `--viewport=WxH` | `1280x800` | Browser viewport |
| `--timeout=MS` | `30000` | Per-URL page load timeout |

## In GitHub Actions

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx --yes playwright@1.49 install --with-deps chromium
- run: npx --yes @unwrap/cli capture
    --server=${{ secrets.UNWRAP_SERVER }}
    --token=${{ secrets.UNWRAP_TOKEN }}
    --host=staging.example.com
    https://staging.example.com/login
    https://staging.example.com/dashboard
```

Then on the project page (or via `GET /projects/<host>/diff/<other>`),
the new upload auto-diffs against the previous capture of the same
host — endpoints added/removed/changed, response schema breaking
changes, GraphQL variable type changes, etc.

## What gets captured

| Field | Coverage |
|---|---|
| Navigations | ✓ committed-style only |
| Network requests + responses | ✓ via CDP, redacted auth headers |
| Console errors | ✓ |
| Page exceptions | ✓ |
| Screenshots | ✓ one final screenshot |
| GraphQL detection | ✓ same heuristic as the extension |
| Click positions / heatmap data | — no clicks in headless capture |
| DOM snapshots | — too heavy for CI; use extension for interactive sessions |
| AX trees | — same |
| Coverage | — same |
| WebSocket frames | — would need a CDP listener; future work |
| Static assets | — would need response-body bytes per asset; future work |

In other words: CLI capture is lighter than extension capture. It's
enough to detect API surface drift, schema breaking changes, status
regressions, and new console errors. For deep RE work, keep using the
extension.
