import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn, fmtPct, fmtMoney } from '@/lib/utils'

interface ChangePillProps {
  pct: number
  abs?: number
  currency?: string
  size?: 'sm' | 'md'
}

export function ChangePill({ pct, abs, currency = 'USD', size = 'md' }: ChangePillProps) {
  const positive = pct >= 0
  const Icon = positive ? TrendingUp : TrendingDown

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
      {abs != null && <span className="opacity-70">{fmtMoney(abs, currency)}</span>}
    </span>
  )
}
