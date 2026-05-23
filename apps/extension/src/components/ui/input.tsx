import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-1 text-xs text-[var(--color-foreground)] outline-none transition-colors placeholder:text-[var(--color-muted-foreground)] focus:border-[var(--color-ring)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--color-ring)_20%,transparent)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
