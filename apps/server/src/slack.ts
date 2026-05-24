import type { SlackConfig } from './storage/slack-config'

// Slack incoming webhooks accept a simple JSON payload. We send Block
// Kit-formatted messages so they render with proper styling. No bot
// auth or workspace-level OAuth needed — the user creates the webhook
// in their Slack workspace and pastes the URL.

interface SlackBlock {
  type: string
  text?: { type: string; text: string; emoji?: boolean }
  // Context blocks use string|object elements — but we only emit one
  // shape so widen here for convenience.
  elements?: { type: string; text: string }[]
  fields?: { type: string; text: string }[]
}

export async function postSlackMessage(cfg: SlackConfig, opts: {
  title: string
  text: string
  fields?: { name: string; value: string }[]
  link?: { text: string; url: string }
}): Promise<void> {
  const blocks: SlackBlock[] = []
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: opts.title, emoji: true },
  })
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: opts.text },
  })
  if (opts.fields && opts.fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: opts.fields.map((f) => ({ type: 'mrkdwn', text: `*${f.name}:* ${f.value}` })),
    })
  }
  if (opts.link) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${opts.link.url}|${opts.link.text}>` }],
    })
  }

  const resp = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blocks, text: opts.title /* fallback for clients that don't render blocks */ }),
  })
  if (!resp.ok) {
    throw new Error(`Slack webhook ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
}
