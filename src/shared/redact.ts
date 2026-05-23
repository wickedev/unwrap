const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
])

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = `[REDACTED:${v.length}]`
    } else {
      out[k] = v
    }
  }
  return out
}

export function shouldCaptureResponseBody(mimeType: string, sizeBytes: number): boolean {
  if (sizeBytes > 5 * 1024 * 1024) return false
  if (!mimeType) return true
  if (mimeType.startsWith('image/')) return false
  if (mimeType.startsWith('video/')) return false
  if (mimeType.startsWith('audio/')) return false
  if (mimeType.startsWith('font/')) return false
  return true
}
