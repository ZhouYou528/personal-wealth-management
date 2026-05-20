import { cn } from '@/lib/utils'
import type { AssetKind } from '@shared/types'
import { KIND_COLOR, KIND_LABEL } from '@/lib/utils'

interface BadgeProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function Badge({ children, className, style }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', className)}
      style={style}
    >
      {children}
    </span>
  )
}

export function KindBadge({ kind }: { kind: AssetKind }) {
  const color = KIND_COLOR[kind] ?? '#A1A1AA'
  return (
    <Badge
      style={{ backgroundColor: `${color}20`, color }}
    >
      {KIND_LABEL[kind]}
    </Badge>
  )
}

export function AccountTypeBadge({ type, color }: { type: string; color: string }) {
  const initials = type.slice(0, 2).toUpperCase()
  return (
    <span
      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white text-[11px] font-bold flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </span>
  )
}
