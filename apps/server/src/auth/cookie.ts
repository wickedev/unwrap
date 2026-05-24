import type { Context } from 'hono'
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie'
import { verifyToken } from './jwt'
import { resolveApiToken } from '../storage/api-tokens'

export const COOKIE_NAME = 'unwrap_session'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60

// We don't constrain the env generic — these helpers are called from
// handlers that carry both Bindings and Variables, and Hono's Context
// type is strictly variant. `any` here matches every binding shape; the
// only thing we touch is `env.JWT_SECRET`, which we re-read as Env.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<any>

export async function setSessionCookie(c: AnyContext, token: string): Promise<void> {
  await setSignedCookie(c, COOKIE_NAME, token, c.env.JWT_SECRET, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearSessionCookie(c: AnyContext): Promise<void> {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

// Returns the authenticated email from either the cookie (web) or the
// Authorization: Bearer header (extension). null if neither is present/valid.
export async function readEmail(c: AnyContext): Promise<string | null> {
  const cookieToken = await getSignedCookie(c, c.env.JWT_SECRET, COOKIE_NAME)
  if (cookieToken) {
    try {
      const claims = await verifyToken(cookieToken, c.env.JWT_SECRET)
      return claims.email
    } catch {
      // fall through
    }
  }
  const auth = c.req.header('authorization') ?? ''
  const m = auth.match(/^Bearer (.+)$/)
  if (m) {
    const presented = m[1]!
    try {
      const claims = await verifyToken(presented, c.env.JWT_SECRET)
      return claims.email
    } catch {
      // Not a JWT — could still be a long-lived API token (CLI / CI).
    }
    const apiTokenRec = await resolveApiToken(c.env, presented)
    if (apiTokenRec) return apiTokenRec.email
  }
  return null
}
