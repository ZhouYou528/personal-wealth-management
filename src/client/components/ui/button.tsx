import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 text-[13.5px]',
  {
    variants: {
      variant: {
        default:   'bg-accent text-white hover:bg-accent-deep',
        outline:   'border border-border-strong bg-surface text-text hover:bg-surface-2',
        ghost:     'hover:bg-surface-2 text-text-2 hover:text-text',
        danger:    'text-down hover:bg-down-soft',
        link:      'text-accent underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm:      'h-7 px-2.5 py-1 text-xs',
        lg:      'h-9 px-4',
        icon:    'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
