import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { holdings as holdingsApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Glyph } from '@/components/Glyph'
import { KindBadge } from '@/components/ui/badge'
import { ChangePill } from '@/components/ChangePill'
import { fmtMoney, fmtQty } from '@/lib/utils'
import type { AssetKind } from '@shared/types'
import { useState } from 'react'

const FILTERS: { label: string; value: AssetKind | 'all' }[] = [
  { label: 'All',     value: 'all' },
  { label: 'Stocks',  value: 'stock' },
  { label: 'ETFs',    value: 'etf' },
  { label: 'Options', value: 'option' },
  { label: 'Crypto',  value: 'crypto' },
  { label: 'Cash',    value: 'cash' },
]

export function Holdings() {
  const { selectedAccountId } = useStore()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<AssetKind | 'all'>('all')

  const { data: allHoldings = [], isLoading } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const filtered = filter === 'all' ? allHoldings : allHoldings.filter(h => h.kind === filter)

  const totalValue = filtered.reduce((s, h) => s + h.qty * h.px * (h.multiplier ?? 1), 0)

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-page-title text-text">Holdings</h1>
          <p className="text-small text-text-3 tabular mt-0.5">
            {allHoldings.length} positions · {fmtMoney(totalValue)} total value
          </p>
        </div>
      </div>

      {/* Kind filter tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-sm text-[12.5px] font-medium transition-colors ${
              filter === f.value
                ? 'bg-accent-soft text-accent'
                : 'text-text-2 hover:bg-surface-2 hover:text-text'
            }`}
          >
            {f.label}
            <span className="ml-1.5 text-text-3 text-[11px]">
              {f.value === 'all'
                ? allHoldings.length
                : allHoldings.filter(h => h.kind === f.value).length}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-text-3 text-small py-8 text-center">Loading…</div>
      ) : (
        <div className="bg-surface rounded-md border border-border overflow-hidden">
          <table className="w-full text-small">
            <thead>
              <tr className="border-b border-border">
                {['Asset', 'Qty', 'Price', 'Today %', 'Value', 'P&L', 'Alloc'].map(col => (
                  <th key={col} className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider font-medium">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered
                .sort((a, b) => (b.qty * b.px) - (a.qty * a.px))
                .map(h => {
                  const value = h.qty * h.px * (h.multiplier ?? 1)
                  const costTotal = h.qty * h.cost * (h.multiplier ?? 1)
                  const pnl = value - costTotal
                  const pnlPct = costTotal > 0 ? (pnl / costTotal) * 100 : 0
                  const alloc = totalValue > 0 ? (value / totalValue) * 100 : 0

                  return (
                    <tr
                      key={h.id}
                      className="hover:bg-surface-2 cursor-pointer transition-colors"
                      onClick={() => navigate(`/holdings/${encodeURIComponent(h.id)}`)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Glyph symbol={h.symbol} kind={h.kind} size="sm" />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-text">{h.symbol}</span>
                              <KindBadge kind={h.kind} />
                            </div>
                            <p className="text-[11px] text-text-3">{h.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular text-text-2">{fmtQty(h.qty)}</td>
                      <td className="px-4 py-3 tabular text-text">{fmtMoney(h.px)}</td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3 tabular font-semibold text-text private-val">{fmtMoney(value)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className={`tabular ${pnl >= 0 ? 'text-up' : 'text-down'} private-val`}>
                            {pnl >= 0 ? '+' : ''}{fmtMoney(pnl)}
                          </span>
                          <ChangePill pct={pnlPct} size="sm" />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1 bg-surface-2 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent rounded-full"
                              style={{ width: `${Math.min(alloc, 100)}%` }}
                            />
                          </div>
                          <span className="tabular text-[11px] text-text-3">{alloc.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-text-3 text-small py-8 text-center">No positions</div>
          )}
        </div>
      )}
    </div>
  )
}
