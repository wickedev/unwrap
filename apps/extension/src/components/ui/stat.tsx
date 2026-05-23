import * as React from 'react'
import { cn } from '@/lib/utils'

interface StatProps {
  icon: React.ReactNode
  label: string
  value: number
  emphasis?: 'default' | 'danger'
  className?: string
}

export function Stat({ icon, label, value, emphasis = 'default', className }: StatProps): React.JSX.Element {
  const muted = value === 0
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-2 py-1',
        muted && 'opacity-50',
        className,
      )}
      title={label}
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center text-[var(--color-muted-foreground)] [&_svg]:size-3.5',
          emphasis === 'danger' && value > 0 && 'text-[var(--color-destructive)]',
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'min-w-3 text-right font-mono text-xs font-semibold tabular-nums leading-none',
          emphasis === 'danger' && value > 0 && 'text-[var(--color-destructive)]',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted-foreground)]">
        {label}
      </span>
    </div>
  )
}
