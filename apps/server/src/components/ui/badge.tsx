import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]',
        warning: 'border-transparent bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]',
        danger: 'border-transparent bg-[hsl(var(--danger))]/15 text-[hsl(var(--danger))]',
        muted: 'border-border bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
