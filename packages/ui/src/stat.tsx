import * as React from 'react'
import { cn } from './cn'

// Compact stat chip used by the extension sidepanel session cards.
// Lives in @unwrap/ui so the server pages can reuse the same chrome
// for at-a-glance counts (requests, screenshots, errors).
interface StatProps {
  icon: React.ReactNode
  label: string
  value: number
  emphasis?: 'default' | 'danger'
  className?: string
}

export function Stat({ icon, label, value, emphasis = 'default', className }: StatProps): React.JSX.Element {
  const muted = value === 0
  const danger = emphasis === 'danger' && value > 0
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1',
        muted && 'opacity-50',
        className,
      )}
      title={label}
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center text-muted-foreground [&_svg]:size-3.5',
          danger && 'text-destructive',
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'min-w-3 text-right font-mono text-xs font-semibold tabular-nums leading-none',
          danger && 'text-destructive',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  )
}
