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
  // GitHub App credentials. Optional — when unset, GitHub integration
  // is limited to the PAT-based CLI flow. When set, comments can be
  // posted via the App's bot identity, webhook events route to us, and
  // installations are listed in /settings/integrations.
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string   // PEM, RSA
  GITHUB_APP_WEBHOOK_SECRET?: string
  GITHUB_APP_SLUG?: string           // for nice URLs in UI; e.g. "unwrap"
}
