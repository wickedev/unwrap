import type { LinearConfig } from './storage/linear-config'

// Linear's GraphQL API. We need exactly one mutation (issueCreate) plus
// a small lookup for `teams { id name key }` so the settings page can
// show team picker entries. Keep the surface tight — no SDK.

const LINEAR_API = 'https://api.linear.app/graphql'

export interface LinearTeam {
  id: string
  name: string
  key: string
}

export async function listLinearTeams(apiKey: string): Promise<LinearTeam[]> {
  const query = `query { teams(first: 50) { nodes { id name key } } }`
  const data = await callLinear<{ teams: { nodes: LinearTeam[] } }>(apiKey, query)
  return data.teams.nodes
}

export interface CreateIssueInput {
  title: string
  description: string
  // Optional labels — we don't currently auto-detect any, but the
  // signature is here so the settings UI can extend later.
  labelIds?: string[]
}

export interface CreatedIssue {
  id: string
  identifier: string // e.g. "ENG-123"
  url: string
  title: string
}

export async function createLinearIssue(cfg: LinearConfig, input: CreateIssueInput): Promise<CreatedIssue> {
  const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
      }
    }
  `
  const variables = {
    input: {
      teamId: cfg.teamId,
      title: input.title,
      description: input.description,
      ...(input.labelIds && input.labelIds.length > 0 ? { labelIds: input.labelIds } : {}),
    },
  }
  const data = await callLinear<{ issueCreate: { success: boolean; issue: CreatedIssue } }>(cfg.apiKey, mutation, variables)
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issueCreate returned success=false')
  }
  return data.issueCreate.issue
}

async function callLinear<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      // Linear accepts both "Bearer <token>" and the raw key for personal
      // API keys — use the raw form so personal-key users don't have to
      // remember the prefix.
      authorization: apiKey.startsWith('Bearer ') || apiKey.startsWith('lin_oauth_') ? apiKey : apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!resp.ok) {
    throw new Error(`Linear API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const body = (await resp.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  if (!body.data) throw new Error('Linear API returned no data')
  return body.data
}
