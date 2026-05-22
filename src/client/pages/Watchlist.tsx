import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { watchlist as watchlistApi, market } from '@/lib/api'
import { Glyph } from '@/components/Glyph'
import { ChangePill } from '@/components/ChangePill'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import type { TickerSearchResult } from '@shared/types'

export function Watchlist() {
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<TickerSearchResult[]>([])
  const [searching, setSearching] = useState(false)

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
      setSearch(''); setResults([])
    },
  })

  const removeMutation = useMutation({
    mutationFn: watchlistApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  })

  async function handleSearch(q: string) {
    setSearch(q)
    if (q.length < 1) { setResults([]); return }
    setSearching(true)
    try {
      const { results: r } = await market.search(q)
      setResults(r.filter(r => !symbols.includes(r.symbol)))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-page-title text-text mb-6">Watchlist</h1>

      {/* Search input */}
      <div className="relative mb-6">
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search tickers to add…"
          className="w-full max-w-sm px-3 py-2 rounded-sm border border-border bg-surface text-text text-small placeholder:text-text-3 focus:outline-none focus:border-accent"
        />
        {results.length > 0 && (
          <div className="absolute top-full left-0 mt-1 w-72 bg-surface border border-border rounded-md shadow-md z-10">
            {results.map(r => (
              <button
                key={r.symbol}
                onClick={() => addMutation.mutate({ symbol: r.symbol, name: r.name, kind: r.kind })}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-surface-2 text-left"
              >
                <Glyph symbol={r.symbol} kind={r.kind} size="sm" />
                <div>
                  <p className="text-small font-medium text-text">{r.symbol}</p>
                  <p className="text-[11px] text-text-3">{r.name}</p>
                </div>
              </button>
            ))}
          </div>
        )}
        {searching && <p className="mt-1 text-[11px] text-text-3">Searching…</p>}
      </div>

      {/* Watchlist table */}
      <div className="bg-surface rounded-md border border-border overflow-hidden">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-border">
              {['Symbol', 'Price', 'Today', 'Change'].map(col => (
                <th key={col} className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">
                  {col}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map(item => {
              const q = quotes[item.symbol]
              return (
                <tr key={item.id} className="hover:bg-surface-2">
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
                    {q ? (
                      <span className={q.change >= 0 ? 'text-up' : 'text-down'}>
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
    </div>
  )
}
