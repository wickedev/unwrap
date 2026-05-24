import * as React from 'react'
import { cn } from '../components/lib/cn'

// App-shell layout used by every authenticated and public page. Top bar
// has the brand + (when signed in) a global search box and a user menu;
// page content slots into a centered container below.
export function Layout({
  email,
  children,
  wide,
}: {
  email?: string
  children: React.ReactNode
  // When true, allow the inner container to grow wider — useful for
  // tables / graphs that need horizontal real estate.
  wide?: boolean
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-6 py-3">
        <h1 className="text-base font-semibold m-0">
          <a href="/" className="text-foreground no-underline">Unwrap</a>
        </h1>
        {email
          ? (
            <form method="get" action="/search" className="flex-1 max-w-[480px]">
              <input
                type="search"
                name="q"
                placeholder="Search captures…"
                className="w-full h-8 px-3 text-xs rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </form>
          )
          : null}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {email
            ? (
              <>
                <span className="hidden sm:inline">{email}</span>
                <a href="/settings/integrations" className="text-muted-foreground hover:text-foreground">Integrations</a>
                <a href="/settings/tokens" className="text-muted-foreground hover:text-foreground">API tokens</a>
                <a href="/auth/sign-out" className="text-muted-foreground hover:text-foreground">Sign out</a>
              </>
            )
            : <a href="/auth/google/start?mode=web" className="text-muted-foreground hover:text-foreground">Sign in</a>}
        </div>
      </header>
      <main className={cn('flex-1 mx-auto w-full px-6 py-6', wide ? 'max-w-[1280px]' : 'max-w-[960px]')}>
        {children}
      </main>
    </div>
  )
}
