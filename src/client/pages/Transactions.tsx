import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { transactions as txApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Glyph } from '@/components/Glyph'
import { Button } from '@/components/ui/button'
import { fmtMoney, fmtQty, fmtDate } from '@/lib/utils'
import type { Transaction } from '@shared/types'

const TX_GROUPS: Record<string, { label: string; color: string }> = {
  buy:          { label: 'Buy',          color: '#10B981' },
  sell:         { label: 'Sell',         color: '#EF4444' },
  buy_crypto:   { label: 'Buy',          color: '#10B981' },
  sell_crypto:  { label: 'Sell',         color: '#EF4444' },
  buy_option:   { label: 'Buy Option',   color: '#F59E0B' },
  sell_option:  { label: 'Sell Option',  color: '#EF4444' },
  deposit:      { label: 'Deposit',      color: '#10B981' },
  withdraw:     { label: 'Withdraw',     color: '#EF4444' },
  transfer:     { label: 'Transfer',     color: '#6B7280' },
  dividend:     { label: 'Dividend',     color: '#06B6D4' },
  interest:     { label: 'Interest',     color: '#06B6D4' },
  recurring:    { label: 'Recurring',    color: '#7C3AED' },
}

function groupByDay(txs: Transaction[]): [string, Transaction[]][] {
  const map = new Map<string, Transaction[]>()
  for (const tx of txs) {
    const key = tx.date.slice(0, 10)
    const arr = map.get(key) ?? []
    arr.push(tx)
    map.set(key, arr)
  }
  return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a))
}

function dayLabel(iso: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (iso === today) return 'Today'
  if (iso === yesterday) return 'Yesterday'
  return fmtDate(iso)
}

export function Transactions() {
  const { selectedAccountId } = useStore()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')

  const { data: allTxs = [], isLoading } = useQuery({
    queryKey: ['transactions', selectedAccountId],
    queryFn: () => txApi.list({ accountId: selectedAccountId ?? undefined, limit: 500 }),
  })

  const deleteMutation = useMutation({
    mutationFn: txApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  })

  const filtered = allTxs.filter(tx => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      tx.symbol?.toLowerCase().includes(q) ||
      tx.note?.toLowerCase().includes(q) ||
      TX_GROUPS[tx.type]?.label.toLowerCase().includes(q)
    )
  })

  const groups = groupByDay(filtered)

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-page-title text-text">Transactions</h1>
          <p className="text-small text-text-3 mt-0.5">{allTxs.length} total</p>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by ticker or note…"
          className="w-full max-w-sm px-3 py-2 rounded-sm border border-border bg-surface text-text text-small placeholder:text-text-3 focus:outline-none focus:border-accent"
        />
      </div>

      {isLoading ? (
        <div className="text-text-3 text-small py-8 text-center">Loading…</div>
      ) : (
        <div className="space-y-6">
          {groups.map(([day, txs]) => (
            <div key={day}>
              <p className="text-micro text-text-3 uppercase tracking-wider mb-2">{dayLabel(day)}</p>
              <div className="bg-surface rounded-md border border-border divide-y divide-border">
                {txs.map(tx => {
                  const meta = TX_GROUPS[tx.type]
                  return (
                    <div key={tx.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 group">
                      {tx.symbol ? (
                        <Glyph symbol={tx.symbol} kind={tx.kind ?? 'stock'} size="sm" />
                      ) : (
                        <span className="w-7 h-7 rounded-sm flex items-center justify-center text-[11px] font-bold"
                          style={{ background: `${meta?.color}20`, color: meta?.color }}>
                          {meta?.label.slice(0, 2)}
                        </span>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-small font-medium" style={{ color: meta?.color }}>
                            {meta?.label}
                          </span>
                          {tx.symbol && <span className="text-small text-text font-medium">{tx.symbol}</span>}
                          {tx.qty && (
                            <span className="text-[11px] text-text-3">
                              {fmtQty(tx.qty)} @ {fmtMoney(tx.price ?? 0)}
                            </span>
                          )}
                        </div>
                        {tx.note && <p className="text-[11px] text-text-3 truncate">{tx.note}</p>}
                      </div>

                      <span className="tabular text-small font-medium text-text private-val flex-shrink-0">
                        {fmtMoney(Math.abs(tx.total))}
                      </span>

                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon"
                          onClick={() => {/* TODO: open edit modal */}}>
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="hover:text-down"
                          onClick={() => deleteMutation.mutate(tx.id)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="text-small text-text-3 py-8 text-center">No transactions found</p>
          )}
        </div>
      )}
    </div>
  )
}
