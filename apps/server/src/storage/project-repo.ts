import type { Env } from '../env'

// Bindings between Unwrap projects (an `email` + `host` pair) and
// GitHub repositories. The PR bot needs to know which project to
// monitor when a webhook fires for `owner/repo` — that's what this
// table provides. A single repo can host multiple bound projects (a
// frontend repo for two staging environments), so the per-repo index
// holds an array.

export interface ProjectRepoBinding {
  email: string
  host: string
  repo: string // owner/repo
  createdAt: number
}

const TTL_SECONDS = 365 * 24 * 60 * 60

const byRepoKey = (repo: string) => `project-repo-by-repo:${repo}`
const byProjectKey = (email: string, host: string) => `project-repo-by-project:${email}:${host}`

export async function bindProjectRepo(env: Env, email: string, host: string, repo: string): Promise<void> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  // Update forward (per-project): one project binds to at most one repo
  // — re-binding overwrites the prior repo.
  const prior = await getProjectRepoBinding(env, email, host)
  if (prior && prior.repo !== repo) {
    const otherList = await listProjectRepoBindings(env, prior.repo)
    await env.SESSIONS.put(byRepoKey(prior.repo), JSON.stringify(otherList.filter((b) => !(b.email === email && b.host === host))), { expirationTtl: TTL_SECONDS })
  }
  await env.SESSIONS.put(byProjectKey(email, host), JSON.stringify({ email, host, repo, createdAt: Date.now() }), { expirationTtl: TTL_SECONDS })
  // Update reverse (per-repo).
  const list = await listProjectRepoBindings(env, repo)
  const next = list.filter((b) => !(b.email === email && b.host === host))
  next.unshift({ email, host, repo, createdAt: Date.now() })
  await env.SESSIONS.put(byRepoKey(repo), JSON.stringify(next), { expirationTtl: TTL_SECONDS })
}

export async function unbindProjectRepo(env: Env, email: string, host: string): Promise<void> {
  if (!env.SESSIONS) return
  const prior = await getProjectRepoBinding(env, email, host)
  if (!prior) return
  await env.SESSIONS.delete(byProjectKey(email, host))
  const list = await listProjectRepoBindings(env, prior.repo)
  await env.SESSIONS.put(byRepoKey(prior.repo), JSON.stringify(list.filter((b) => !(b.email === email && b.host === host))), { expirationTtl: TTL_SECONDS })
}

export async function getProjectRepoBinding(env: Env, email: string, host: string): Promise<ProjectRepoBinding | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(byProjectKey(email, host), 'json')) as ProjectRepoBinding | null
}

export async function listProjectRepoBindings(env: Env, repo: string): Promise<ProjectRepoBinding[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(byRepoKey(repo))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as ProjectRepoBinding[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function findInstallationForBindingExists(env: Env, repo: string): Promise<boolean> {
  const list = await listProjectRepoBindings(env, repo)
  return list.length > 0
}
