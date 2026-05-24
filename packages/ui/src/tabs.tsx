import * as React from 'react'
import { cn } from './cn'

// SSR-friendly tabs. We render as a plain `<nav>` of `<a>` links that
// flip a URL param — works without client JS, survives page refresh,
// is shareable. The page reads the param server-side and renders the
// active panel. Each tab can be marked `disabled` (renders as a span).

export interface TabDef {
  key: string
  label: React.ReactNode
  hint?: string
  disabled?: boolean
}

export interface TabsProps {
  tabs: TabDef[]
  activeKey: string
  // Function that builds the href for a given tab key. The caller
  // decides whether tabs ride on `?tab=` or a path segment.
  hrefFor: (key: string) => string
  className?: string
}

export function Tabs({ tabs, activeKey, hrefFor, className }: TabsProps) {
  return (
    <nav className={cn('flex flex-wrap gap-1 border-b -mb-px', className)} role="tablist">
      {tabs.map((t) => {
        const active = t.key === activeKey
        const baseClass = cn(
          'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
          active
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
          t.disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
        )
        if (t.disabled) {
          return (
            <span key={t.key} className={baseClass} role="tab" aria-disabled="true">
              {t.label}
            </span>
          )
        }
        return (
          <a
            key={t.key}
            href={hrefFor(t.key)}
            role="tab"
            aria-selected={active}
            className={baseClass}
            title={t.hint}
          >
            {t.label}
          </a>
        )
      })}
    </nav>
  )
}

// Convenience wrapper for the common case of `?tab=...`. Renders the
// tabs and a thin top border so the panel below visually attaches.
export function TabsBar({ tabs, activeKey, basePath, className }: {
  tabs: TabDef[]
  activeKey: string
  basePath: string
  className?: string
}) {
  return (
    <Tabs
      tabs={tabs}
      activeKey={activeKey}
      hrefFor={(key) => `${basePath}?tab=${encodeURIComponent(key)}`}
      className={className}
    />
  )
}
