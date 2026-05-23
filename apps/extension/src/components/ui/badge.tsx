import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide [&_svg]:size-3',
  {
    variants: {
      variant: {
        default:
          'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
        recording:
          'border-[var(--color-primary)] text-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,transparent)]',
        success:
          'border-[var(--color-success)] text-[var(--color-success)]',
        warning:
          'border-[var(--color-warning)] text-[var(--color-warning)]',
        destructive:
          'border-[var(--color-destructive)] text-[var(--color-destructive)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
