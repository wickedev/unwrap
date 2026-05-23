export interface Env {
  // KV
  OAUTH_STATE?: KVNamespace
  SESSIONS?: KVNamespace
  // Browser Rendering
  BROWSER?: Fetcher
  // Vars
  ALLOWED_EMAILS?: string
  EXTENSION_REDIRECT_URL?: string
  GEMINI_MODEL?: string
  // Secrets
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GEMINI_API_KEY: string
  JWT_SECRET: string
}
