import * as React from 'react'
import { cn } from './cn'

// Small uppercase label used above form inputs and stat groupings.
// Plain <label> — no Radix dependency so the package stays light;
// callers wire htmlFor + id themselves like with any native label.
export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-[10px] font-medium uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  ),
)
Label.displayName = 'Label'
