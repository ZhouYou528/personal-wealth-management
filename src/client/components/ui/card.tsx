import { cn } from '@/lib/utils'

interface CardProps {
  children: React.ReactNode
  className?: string
  padding?: 'default' | 'hero' | 'none'
  onClick?: () => void
}

export function Card({ children, className, padding = 'default', onClick }: CardProps) {
  return (
    <div
      className={cn(
        'bg-surface rounded-md shadow-sm border border-border',
        padding === 'default' && 'p-5',
        padding === 'hero'    && 'p-7',
        padding === 'none'    && '',
        onClick && 'cursor-pointer hover:border-border-strong transition-colors',
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between mb-4', className)}>
      {children}
    </div>
  )
}

export function CardTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn('text-card-title text-text', className)}>{children}</h3>
}
