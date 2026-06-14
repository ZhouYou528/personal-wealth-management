import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn, fmtPct } from '@/lib/utils'
import { useMoney } from '@/lib/money'

interface ChangePillProps {
  pct: number | null | undefined
  abs?: number | null
  size?: 'sm' | 'md'
}

export function ChangePill({ pct, abs, size = 'md' }: ChangePillProps) {
  const { fmt } = useMoney()
  const hasValue = pct != null && Number.isFinite(pct)
  const positive = hasValue && (pct as number) >= 0
  const Icon = positive ? TrendingUp : TrendingDown
  if (!hasValue) {
    return <span className={cn('text-text-3', size === 'sm' ? 'text-[11.5px]' : 'text-[13px]')}>—</span>
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 tabular font-medium',
        size === 'md' ? 'text-[13px]' : 'text-[11.5px]',
        positive ? 'bg-up-soft text-up' : 'bg-down-soft text-down'
      )}
    >
      <Icon size={size === 'md' ? 13 : 11} strokeWidth={2.5} />
      {fmtPct(pct)}
      {abs != null && <span className="opacity-70 private-val">{fmt(abs)}</span>}
    </span>
  )
}
