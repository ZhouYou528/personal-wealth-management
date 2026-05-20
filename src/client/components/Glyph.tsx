import { cn } from '@/lib/utils'
import { KIND_COLOR } from '@/lib/utils'
import type { AssetKind } from '@shared/types'

interface GlyphProps {
  symbol: string
  kind: AssetKind
  size?: 'sm' | 'md' | 'lg'
}

/** Colored initials tile for an asset — used everywhere a logo would be. */
export function Glyph({ symbol, kind, size = 'md' }: GlyphProps) {
  const color = KIND_COLOR[kind] ?? '#A1A1AA'
  const label = symbol === 'CASH' ? '$' : symbol.replace('.TO', '').replace('.V', '').slice(0, 2)

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-bold flex-shrink-0 font-mono select-none',
        size === 'sm' && 'w-7 h-7 text-[10px]',
        size === 'md' && 'w-9 h-9 text-[12px]',
        size === 'lg' && 'w-11 h-11 text-[14px]',
      )}
      style={{ backgroundColor: `${color}20`, color }}
    >
      {label}
    </span>
  )
}
