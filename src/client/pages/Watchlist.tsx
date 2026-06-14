import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, ChevronUp, ChevronDown, Plus, AlertCircle } from 'lucide-react'
import { watchlist as watchlistApi, market } from '@/lib/api'
import { Glyph } from '@/components/Glyph'
import { ChangePill } from '@/components/ChangePill'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { isEtfSymbol } from '@shared/etf-list'
import type { TickerSearchResult, AssetKind } from '@shared/types'

const CRYPTO_TICKERS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','DOT','MATIC','LINK','LTC','UNI','ATOM','SUI','SHIB','TRX','TON','NEAR','APT',
])

// Best-effort kind detection for a freeform ticker. Crypto first, then ETF
// whitelist, then default to stock — wrong kind is harmless (only affects
// which color the row's glyph uses on Holdings).
function guessKind(symbol: string): AssetKind {
  const up = symbol.toUpperCase()
  if (CRYPTO_TICKERS.has(up)) return 'crypto'
  if (isEtfSymbol(up)) return 'etf'
  return 'stock'
}

type Quote = { price: number; changePct: number | null; change: number | null }
type SortKey = 'symbol' | 'price' | 'changePct' | 'change'
type Dir = 'asc' | 'desc'

type MobileMetric = {
  label: string
  sortKey: SortKey
  render: (q: Quote | undefined, fmt: (v: number) => string) => React.ReactNode
}

const MOBILE_METRICS: MobileMetric[] = [
  {
    label: 'Today %',
    sortKey: 'changePct',
    render: (q) => q
      ? <ChangePill pct={q.changePct} size="sm" />
      : <span className="text-text-3 text-small">—</span>,
  },
  {
    label: 'Price',
    sortKey: 'price',
    render: (q, fmt) => q
      ? <span className="tabular text-small font-semibold text-text private-val">{fmt(q.price)}</span>
      : <span className="text-text-3 text-small">—</span>,
  },
  {
    label: 'Change $',
    sortKey: 'change',
    render: (q, fmt) => q?.change != null
      ? <span className={cn('tabular text-small private-val', q.change >= 0 ? 'text-up' : 'text-down')}>
          {q.change >= 0 ? '+' : ''}{fmt(q.change)}
        </span>
      : <span className="text-text-3 text-small">—</span>,
  },
]

export function Watchlist() {
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<TickerSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('symbol')
  const [sortDir, setSortDir] = useState<Dir>('asc')
  const [mobileMetricIdx, setMobileMetricIdx] = useState(0)

  const { data: items = [] } = useQuery({
    queryKey: ['watchlist'],
    queryFn: watchlistApi.list,
  })

  const symbols = items.map(i => i.symbol)
  const { data: quotesData } = useQuery({
    queryKey: ['watchlist-quotes', symbols.join(',')],
    queryFn: () => market.quotes(symbols),
    enabled: symbols.length > 0,
    refetchInterval: 60_000,
  })
  const quotes = quotesData?.quotes ?? {}

  const addMutation = useMutation({
    mutationFn: watchlistApi.add,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] })
      setSearch(''); setResults([]); setError(null)
    },
    onError: (e) => setError(String(e)),
  })

  // Validate by fetching a live quote; if the source (Finnhub/CoinGecko)
  // returns a price, the ticker is real. Otherwise show an inline error.
  async function tryAddByTicker(raw: string) {
    const symbol = raw.trim().toUpperCase()
    if (!symbol) return
    if (symbols.includes(symbol)) {
      setError(`${symbol} is already on your watchlist`)
      return
    }
    setError(null)
    setValidating(true)
    try {
      const { quotes: q } = await market.quotes([symbol])
      if (q[symbol] && q[symbol].price > 0) {
        addMutation.mutate({ symbol, name: symbol, kind: guessKind(symbol) })
      } else {
        setError(`Couldn't fetch a price for ${symbol}. Check the ticker and try again.`)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setValidating(false)
    }
  }

  const removeMutation = useMutation({
    mutationFn: watchlistApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  })

  async function handleSearch(q: string) {
    setSearch(q)
    setError(null)
    if (q.length < 1) { setResults([]); return }
    setSearching(true)
    try {
      const { results: r } = await market.search(q)
      setResults(r.filter(r => !symbols.includes(r.symbol)))
    } finally {
      setSearching(false)
    }
  }

  // Show the "Add as typed" fallback when the search query is a plausible
  // ticker (letters/digits/dot/dash, 1–10 chars) and no exact symbol match
  // is already in the dropdown.
  const canAddTyped = useMemo(() => {
    const s = search.trim().toUpperCase()
    if (!s) return false
    if (!/^[A-Z0-9.\-]{1,10}$/.test(s)) return false
    if (results.some(r => r.symbol.toUpperCase() === s)) return false
    if (symbols.includes(s)) return false
    return true
  }, [search, results, symbols])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      const qa = quotes[a.symbol]
      const qb = quotes[b.symbol]
      switch (sortKey) {
        case 'symbol':    return dir * a.symbol.localeCompare(b.symbol)
        case 'price':     return dir * ((qa?.price ?? 0) - (qb?.price ?? 0))
        case 'changePct': return dir * ((qa?.changePct ?? 0) - (qb?.changePct ?? 0))
        case 'change':    return dir * ((qa?.change ?? 0) - (qb?.change ?? 0))
        default:          return 0
      }
    })
  }, [items, quotes, sortKey, sortDir])

  const mobileMetric = MOBILE_METRICS[mobileMetricIdx]

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto">
      <h1 className="text-page-title text-text mb-6">Watchlist</h1>

      {/* Search input */}
      <div className="relative mb-6">
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && canAddTyped) {
              e.preventDefault()
              tryAddByTicker(search)
            }
          }}
          placeholder="Enter any ticker (press Enter to add)…"
          className="w-full max-w-sm px-3 py-2 rounded-lg border border-border bg-surface text-text text-small placeholder:text-text-3 focus:outline-none focus:border-accent"
        />
        {(results.length > 0 || canAddTyped) && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-surface border border-border rounded-xl shadow-lg z-10">
            {results.map(r => (
              <button
                key={r.symbol}
                onClick={() => addMutation.mutate({ symbol: r.symbol, name: r.name, kind: r.kind })}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-2 text-left first:rounded-t-xl"
              >
                <Glyph symbol={r.symbol} kind={r.kind} size="sm" />
                <div>
                  <p className="text-small font-medium text-text">{r.symbol}</p>
                  <p className="text-[11px] text-text-3">{r.name}</p>
                </div>
              </button>
            ))}
            {canAddTyped && (
              <button
                onClick={() => tryAddByTicker(search)}
                disabled={validating}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-2 text-left last:rounded-b-xl disabled:opacity-50',
                  results.length === 0 && 'first:rounded-t-xl',
                  results.length > 0 && 'border-t border-border'
                )}
              >
                <div className="w-6 h-6 rounded-full bg-accent-soft flex items-center justify-center flex-shrink-0">
                  <Plus size={13} className="text-accent" />
                </div>
                <div>
                  <p className="text-small font-medium text-text">
                    {validating ? 'Validating…' : `Add ${search.trim().toUpperCase()}`}
                  </p>
                  <p className="text-[11px] text-text-3">Press Enter or click to verify ticker</p>
                </div>
              </button>
            )}
          </div>
        )}
        {searching && <p className="mt-1 text-[11px] text-text-3">Searching…</p>}
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-down">
            <AlertCircle size={12} />
            {error}
          </p>
        )}
      </div>

      {/* ── Desktop table ─────────────────────────────────────── */}
      <div className="hidden sm:block bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush overflow-hidden">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-border">
              <SortableTh label="Symbol"   sortKey="symbol"    current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableTh label="Price"    sortKey="price"     current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableTh label="Today %"  sortKey="changePct" current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableTh label="Change $" sortKey="change"    current={sortKey} dir={sortDir} onSort={toggleSort} />
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map(item => {
              const q = quotes[item.symbol]
              return (
                <tr key={item.id} className="hover:bg-surface-2 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Glyph symbol={item.symbol} kind={item.kind} size="sm" />
                      <div>
                        <p className="font-medium text-text">{item.symbol}</p>
                        <p className="text-[11px] text-text-3">{item.name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular text-text font-medium private-val">
                    {q ? fmt(q.price) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {q ? <ChangePill pct={q.changePct} size="sm" /> : '—'}
                  </td>
                  <td className="px-4 py-3 tabular text-small">
                    {q?.change != null ? (
                      <span className={cn('private-val', q.change >= 0 ? 'text-up' : 'text-down')}>
                        {q.change >= 0 ? '+' : ''}{fmt(q.change)}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-2 py-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-down"
                      onClick={() => removeMutation.mutate(item.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {items.length === 0 && (
          <div className="text-text-3 text-small py-8 text-center">
            Search for a ticker above to add it to your watchlist.
          </div>
        )}
      </div>

      {/* ── Mobile list ───────────────────────────────────────── */}
      <div className="sm:hidden bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <button
            onClick={() => toggleSort('symbol')}
            className="text-micro text-text-3 uppercase tracking-wider font-medium flex items-center gap-1"
          >
            Symbol
            <SortArrow active={sortKey === 'symbol'} dir={sortDir} />
          </button>
          <button
            onClick={() => toggleSort(mobileMetric.sortKey)}
            className="text-micro text-text-3 uppercase tracking-wider font-medium flex items-center gap-1"
          >
            {mobileMetric.label}
            <SortArrow active={sortKey === mobileMetric.sortKey} dir={sortDir} />
          </button>
        </div>

        <div className="divide-y divide-border">
          {sorted.map(item => {
            const q = quotes[item.symbol]
            return (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                <Glyph symbol={item.symbol} kind={item.kind} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-text">{item.symbol}</p>
                  <p className="text-[11px] text-text-3 truncate">{item.name}</p>
                </div>
                {/* Tap value to cycle metric */}
                <div
                  className="flex-shrink-0"
                  onClick={() => setMobileMetricIdx(i => (i + 1) % MOBILE_METRICS.length)}
                >
                  {mobileMetric.render(q, fmt)}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hover:text-down flex-shrink-0"
                  onClick={() => removeMutation.mutate(item.id)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            )
          })}
          {items.length === 0 && (
            <div className="text-text-3 text-small py-8 text-center px-4">
              Search for a ticker above to add it to your watchlist.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SortableTh({ label, sortKey, current, dir, onSort }: {
  label: string; sortKey: SortKey; current: SortKey; dir: Dir; onSort: (k: SortKey) => void
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
