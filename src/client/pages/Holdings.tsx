import { useQuery } from '@tanstack/react-query'
import { ListLoader } from '@/components/ui/spinner'
import { useNavigate } from 'react-router-dom'
import { useState, useMemo } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { holdings as holdingsApi, accounts as accountsApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Glyph } from '@/components/Glyph'
import { KindBadge } from '@/components/ui/badge'
import { ChangePill } from '@/components/ChangePill'
import { fmtQty, fmtOptionLabel, daysToExpiry, lockedCollateral, cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import type { AssetKind, Holding } from '@shared/types'

const FILTERS: { label: string; value: AssetKind | 'all' }[] = [
  { label: 'All',           value: 'all' },
  { label: 'Stocks',        value: 'stock' },
  { label: 'ETFs',          value: 'etf' },
  { label: 'Mutual Funds',  value: 'mutual_fund' },
  { label: 'Options',       value: 'option' },
  { label: 'Crypto',        value: 'crypto' },
  { label: 'Cash',          value: 'cash' },
]

type SortKey = 'symbol' | 'account' | 'qty' | 'price' | 'today' | 'value' | 'pnl' | 'alloc'
type Dir = 'asc' | 'desc'

// Mobile right-side metric — tapping a row value cycles to the next; tapping the
// header sorts by the current one.
// `render` takes a fmt function so it can use the user's chosen display currency.
type FmtFn = (v: number) => string
type MobileMetric = {
  key: string
  label: string
  sortKey: SortKey
  render: (h: EnrichedHolding, fmt: FmtFn) => React.ReactNode
}
const MOBILE_METRICS: MobileMetric[] = [
  {
    key: 'pnl', label: 'P&L', sortKey: 'pnl',
    render: (h, fmt) => (
      <div className="flex flex-col items-end gap-0.5">
        <span className={cn('tabular text-small private-val', h.pnl >= 0 ? 'text-up' : 'text-down')}>
          {h.pnl >= 0 ? '+' : ''}{fmt(h.pnl)}
        </span>
        <ChangePill pct={h.pnlPct} size="sm" />
      </div>
    ),
  },
  {
    key: 'today', label: 'Today', sortKey: 'today',
    render: (h, fmt) => h.changePct != null ? (
      <div className="text-right">
        <div className={cn('tabular text-small font-semibold private-val', h.changePct >= 0 ? 'text-up' : 'text-down')}>
          {h.changePct >= 0 ? '+' : ''}{fmt(h.todayChangeValue)}
        </div>
        <div className={cn('tabular text-[11px]', h.changePct >= 0 ? 'text-up' : 'text-down')}>
          {h.changePct >= 0 ? '+' : ''}{h.changePct.toFixed(2)}%
        </div>
      </div>
    ) : <div className="text-[11px] text-text-3 text-right">—</div>,
  },
  {
    key: 'value', label: 'Value', sortKey: 'value',
    render: (h, fmt) => <div className="tabular text-small font-semibold text-text private-val text-right">{fmt(h.value)}</div>,
  },
  {
    key: 'qty', label: 'Qty', sortKey: 'qty',
    render: (h) => <div className="tabular text-small text-text-2 text-right">{fmtQty(h.qty)}</div>,
  },
  {
    key: 'price', label: 'Price', sortKey: 'price',
    render: (h, fmt) => <div className="tabular text-small text-text text-right">{fmt(h.px)}</div>,
  },
  {
    key: 'alloc', label: 'Alloc', sortKey: 'alloc',
    render: (h) => (
      <div className="flex items-center gap-2 justify-end">
        <div className="w-14 h-1 bg-surface-2 rounded-full overflow-hidden">
          <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(h.alloc, 100)}%` }} />
        </div>
        <span className="tabular text-[11px] text-text-3 w-10 text-right">{h.alloc.toFixed(1)}%</span>
      </div>
    ),
  },
]

type EnrichedHolding = Holding & {
  value: number
  cost: number
  pnl: number
  pnlPct: number
  alloc: number
  todayChangeValue: number
}

export function Holdings() {
  const { selectedAccountId, setSelectedAccountId } = useStore()
  const navigate = useNavigate()
  const { fmt } = useMoney()
  const [filter, setFilter] = useState<AssetKind | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('alloc')
  const [sortDir, setSortDir] = useState<Dir>('desc')
  const [mobileIdx, setMobileIdx] = useState(0)

  const { data: allHoldings = [], isLoading } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  // Cash-collateral locked per account (from open short puts).
  // Computed from the full holdings list so it's stable across filter changes.
  const lockedByAccount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const acc of accs) {
      m[acc.id] = lockedCollateral(allHoldings.filter(h => h.account_id === acc.id))
    }
    return m
  }, [allHoldings, accs])

  const filtered = filter === 'all' ? allHoldings : allHoldings.filter(h => h.kind === filter)
  const totalValue = filtered.reduce((s, h) => s + h.qty * h.px * (h.multiplier ?? 1), 0)
  // Gross exposure (|value| summed) — short positions occupy portfolio space too, even
  // if they net out negative. Use this as the allocation denominator so % is always positive.
  const grossExposure = filtered.reduce((s, h) => s + Math.abs(h.qty * h.px * (h.multiplier ?? 1)), 0)

  // Enrich with computed columns
  const enriched: EnrichedHolding[] = useMemo(() => filtered.map(h => {
    const mult = h.multiplier ?? 1
    const value = h.qty * h.px * mult
    const cost  = h.qty * h.cost * mult
    const pnl   = value - cost
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
    const alloc = grossExposure > 0 ? (Math.abs(value) / grossExposure) * 100 : 0
    const todayChangeValue = h.change != null ? h.change * h.qty * mult : 0
    return { ...h, value, cost, pnl, pnlPct, alloc, todayChangeValue }
  }), [filtered, grossExposure])

  // Sort
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const arr = [...enriched]
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'symbol':  return dir * a.symbol.localeCompare(b.symbol)
        case 'account': return dir * ((accMap[a.account_id]?.institution ?? '').localeCompare(accMap[b.account_id]?.institution ?? ''))
        case 'qty':     return dir * (a.qty - b.qty)
        case 'price':   return dir * (a.px - b.px)
        case 'today':   return dir * ((a.changePct ?? 0) - (b.changePct ?? 0))
        case 'value':   return dir * (a.value - b.value)
        case 'pnl':     return dir * (a.pnl - b.pnl)
        case 'alloc':   return dir * (a.alloc - b.alloc)
        default:        return 0
      }
    })
    return arr
  }, [enriched, sortKey, sortDir, accMap])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' || key === 'account' ? 'asc' : 'desc')
    }
  }

  const mobileMetric = MOBILE_METRICS[mobileIdx]

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-page-title text-text">Holdings</h1>
          <p className="text-small text-text-3 tabular mt-0.5">
            {allHoldings.length} positions · <span className="private-val">{fmt(totalValue)}</span> total value
          </p>
        </div>
      </div>

      {/* Account filter pills — same global filter as the Dashboard so users
          can see and change it without leaving the page. */}
      {accs.length > 1 && (
        <div className="flex gap-1.5 flex-wrap mb-4">
          <AccountPill
            active={selectedAccountId == null}
            onClick={() => setSelectedAccountId(null)}
            label="All Accounts"
          />
          {accs.map(a => (
            <AccountPill
              key={a.id}
              active={selectedAccountId === a.id}
              onClick={() => setSelectedAccountId(a.id)}
              label={a.name}
              color={a.color}
            />
          ))}
        </div>
      )}

      {/* Kind filter tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-all duration-150 ${
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

      {isLoading ? (
        <ListLoader />
      ) : (
        <>
          {/* ── Desktop table ──────────────────────────────────────── */}
          <div className="hidden sm:block bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush overflow-x-auto">
            <table className="w-full text-small min-w-[760px]">
              <thead>
                <tr className="border-b border-border">
                  <SortableTh label="Asset"   sortKey="symbol"  current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Account" sortKey="account" current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Qty"     sortKey="qty"     current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Price"   sortKey="price"   current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Today %" sortKey="today"   current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Value"   sortKey="value"   current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="P&L"     sortKey="pnl"     current={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Alloc"   sortKey="alloc"   current={sortKey} dir={sortDir} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map(h => (
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
                            <span className="font-medium text-text">
                              {h.kind === 'option' ? fmtOptionLabel(h) : h.symbol}
                            </span>
                            <KindBadge kind={h.kind} />
                            {h.kind === 'option' && h.qty < 0 && (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-down bg-down/10 rounded px-1.5 py-0.5">
                                Short
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-text-3">
                            {h.kind === 'option' ? (() => {
                              const dte = daysToExpiry(h.expiry)
                              if (dte == null) return h.name
                              if (dte < 0) return `Expired ${-dte}d ago`
                              if (dte === 0) return 'Expires today'
                              return `${dte}d to expiry`
                            })() : h.kind === 'cash' && (lockedByAccount[h.account_id] ?? 0) > 0 ? (
                              <>
                                <span className="text-warn private-val">{fmt(lockedByAccount[h.account_id])}</span> locked ·{' '}
                                <span className="text-text-2 private-val">{fmt(h.value - lockedByAccount[h.account_id])}</span> available
                              </>
                            ) : h.name}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const acc = accMap[h.account_id]
                        return acc ? (
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: acc.color }} />
                            <span className="text-[11px] text-text-2 whitespace-nowrap">{acc.institution}</span>
                            <span className="text-[10px] text-text-3">·</span>
                            <span className="text-[11px] text-text-3">{acc.type}</span>
                          </div>
                        ) : <span className="text-[11px] text-text-3">—</span>
                      })()}
                    </td>
                    <td className="px-4 py-3 tabular text-text-2">{fmtQty(h.qty)}</td>
                    <td className="px-4 py-3 tabular text-text">{fmt(h.px)}</td>
                    <td className="px-4 py-3">
                      {h.changePct != null ? (
                        <span className={cn('tabular text-[12px]', h.changePct >= 0 ? 'text-up' : 'text-down')}>
                          {h.changePct >= 0 ? '+' : ''}{h.changePct.toFixed(2)}%
                        </span>
                      ) : <span className="text-text-3 text-[11px]">—</span>}
                    </td>
                    <td className="px-4 py-3 tabular font-semibold text-text private-val">{fmt(h.value)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className={`tabular ${h.pnl >= 0 ? 'text-up' : 'text-down'} private-val`}>
                          {h.pnl >= 0 ? '+' : ''}{fmt(h.pnl)}
                        </span>
                        <ChangePill pct={h.pnlPct} size="sm" />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1 bg-surface-2 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-accent rounded-full"
                            style={{ width: `${Math.min(h.alloc, 100)}%` }}
                          />
                        </div>
                        <span className="tabular text-[11px] text-text-3">{h.alloc.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sorted.length === 0 && (
              <div className="text-text-3 text-small py-8 text-center">No positions</div>
            )}
          </div>

          {/* ── Mobile list ───────────────────────────────────────── */}
          <div className="sm:hidden bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush">
            {/* Header — tap left to sort by symbol, tap right to sort by current metric */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <button
                onClick={() => toggleSort('symbol')}
                className="text-micro text-text-3 uppercase tracking-wider font-medium flex items-center gap-1"
              >
                Asset
                <SortArrow active={sortKey === 'symbol'} dir={sortDir} />
              </button>
              <button
                onClick={() => toggleSort(mobileMetric.sortKey)}
                className="text-micro text-text-3 uppercase tracking-wider font-medium flex items-center gap-1"
                title="Tap to sort by this column"
              >
                {mobileMetric.label}
                <SortArrow active={sortKey === mobileMetric.sortKey} dir={sortDir} />
              </button>
            </div>

            <div className="divide-y divide-border">
              {sorted.map(h => (
                <div
                  key={h.id}
                  className="flex items-center gap-3 px-3 py-3 hover:bg-surface-2 active:bg-surface-2 cursor-pointer"
                  onClick={() => navigate(`/holdings/${encodeURIComponent(h.id)}`)}
                >
                  <Glyph symbol={h.symbol} kind={h.kind} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-text truncate">
                      {h.kind === 'option' ? fmtOptionLabel(h) : h.symbol}
                      {h.kind === 'option' && h.qty < 0 && (
                        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-down bg-down/10 rounded px-1 py-0.5">
                          Short
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-text-3 truncate">
                      {h.kind === 'cash' && (lockedByAccount[h.account_id] ?? 0) > 0
                        ? `${fmt(lockedByAccount[h.account_id])} locked`
                        : h.name}
                    </p>
                  </div>
                  <div onClick={(e) => { e.stopPropagation(); setMobileIdx(i => (i + 1) % MOBILE_METRICS.length) }}>
                    {mobileMetric.render(h, fmt)}
                  </div>
                </div>
              ))}
              {sorted.length === 0 && (
                <div className="text-text-3 text-small py-8 text-center">No positions</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function SortableTh({ label, sortKey, current, dir, onSort }: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: Dir
  onSort: (k: SortKey) => void
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'text-left px-4 py-3 text-micro uppercase tracking-wider font-medium cursor-pointer select-none transition-colors',
        active ? 'text-text' : 'text-text-3 hover:text-text-2'
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <SortArrow active={active} dir={dir} />
      </span>
    </th>
  )
}

function SortArrow({ active, dir }: { active: boolean; dir: Dir }) {
  if (!active) return <span className="opacity-30"><ChevronUp size={11} /></span>
  return dir === 'asc' ? <ChevronUp size={11} className="text-accent" /> : <ChevronDown size={11} className="text-accent" />
}

function AccountPill({ active, onClick, label, color }: {
  active: boolean
  onClick: () => void
  label: string
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-all duration-150',
        active
          ? 'bg-accent-soft text-accent'
          : 'bg-surface border border-border text-text-2 hover:text-text hover:border-border-strong'
      )}
    >
      {color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />}
      {label}
    </button>
  )
}
