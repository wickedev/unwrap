import { sign, verify } from 'hono/jwt'
import type { JWTPayload } from 'hono/utils/jwt/types'

const ALG = 'HS256'
const TTL_SECONDS = 7 * 24 * 60 * 60

export interface SessionClaims extends JWTPayload {
  sub: string
  email: string
  iat: number
  exp: number
}

export async function issueToken(email: string, secret: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + TTL_SECONDS
  const payload: SessionClaims = { sub: email, email, iat: now, exp }
  const token = await sign(payload, secret, ALG)
  return { token, expiresAt: exp * 1000 }
}

export async function verifyToken(token: string, secret: string): Promise<SessionClaims> {
  const claims = (await verify(token, secret, ALG)) as unknown as SessionClaims
  return claims
}
