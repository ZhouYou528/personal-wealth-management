import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2, SlidersHorizontal, X, Wifi } from 'lucide-react'
import { ListLoader } from '@/components/ui/spinner'
import { transactions as txApi, accounts as accountsApi, nav as navApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Glyph } from '@/components/Glyph'
import { Button } from '@/components/ui/button'
import { fmtQty, fmtDate, fmtOptionLabel, todayISO, daysAgoISO, cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
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
  transfer_in:  { label: 'Transfer In',  color: '#10B981' },
  transfer_out: { label: 'Transfer Out', color: '#A1A1AA' },
  dividend:     { label: 'Dividend',     color: '#06B6D4' },
  interest:     { label: 'Interest',     color: '#06B6D4' },
  recurring:    { label: 'Recurring',    color: '#7C3AED' },
  split:        { label: 'Split',        color: '#7C3AED' },
}

function isOptCash(note?: string | null) { return !!note?.startsWith('[opt-cash:') }
function stripOptPrefix(note: string) { return note.replace(/^\[opt-cash:[^\]]+\]\s*/, '') }

function groupByDay(txs: Transaction[]): [string, Transaction[]][] {
  const map = new Map<string, Transaction[]>()
  for (const tx of txs) {
    const key = tx.tx_date.slice(0, 10)
    const arr = map.get(key) ?? []
    arr.push(tx)
    map.set(key, arr)
  }
  return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a))
}

function dayLabel(iso: string): string {
  if (iso === todayISO()) return 'Today'
  if (iso === daysAgoISO(1)) return 'Yesterday'
  return fmtDate(iso)
}

export function Transactions() {
  const { selectedAccountId, setSelectedAccountId, openEditTx } = useStore()
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [ticker, setTicker] = useState('')
  const [accountTypeFilter, setAccountTypeFilter] = useState('')
  const [brokerFilter, setBrokerFilter] = useState('')

  const { data: allTxs = [], isLoading } = useQuery({
    queryKey: ['transactions', selectedAccountId, showAll ? 'all' : '30d'],
    queryFn: () => txApi.list({
      accountId: selectedAccountId ?? undefined,
      limit: 2000,
      ...(showAll ? {} : { days: 30 }),
    }),
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  const deleteMutation = useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId: string }) => {
      await txApi.delete(id)
      return accountId
    },
    onSuccess: (accountId) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['transactions-dedup'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
      navApi.backfill(accountId)
        .then(() => qc.invalidateQueries({ queryKey: ['nav'] }))
        .catch(() => {})
    },
  })

  // Available filter options derived from the loaded data + accounts.
  const brokers = useMemo(() => [...new Set(accs.map(a => a.institution))].filter(Boolean).sort(), [accs])
  const accountTypes = useMemo(() => [...new Set(accs.map(a => a.type))].filter(Boolean).sort(), [accs])

  const filtered = allTxs.filter(tx => {
    // Free-text search
    if (search) {
      const q = search.toLowerCase()
      const match = (
        tx.symbol?.toLowerCase().includes(q) ||
        tx.note?.toLowerCase().includes(q) ||
        TX_GROUPS[tx.type]?.label.toLowerCase().includes(q)
      )
      if (!match) return false
    }
    // Date range
    const day = tx.tx_date.slice(0, 10)
    if (dateFrom && day < dateFrom) return false
    if (dateTo && day > dateTo) return false
    // Ticker
    if (ticker && !tx.symbol?.toUpperCase().includes(ticker.toUpperCase())) return false
    // Account-side filters (resolve account from accMap)
    if (accountTypeFilter || brokerFilter) {
      const acc = accMap[tx.account_id]
      if (!acc) return false
      if (accountTypeFilter && acc.type !== accountTypeFilter) return false
      if (brokerFilter && acc.institution !== brokerFilter) return false
    }
    return true
  })

  const activeCount =
    (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (ticker ? 1 : 0) +
    (accountTypeFilter ? 1 : 0) + (brokerFilter ? 1 : 0)

  function clearAll() {
    setDateFrom(''); setDateTo(''); setTicker(''); setAccountTypeFilter(''); setBrokerFilter('')
  }

  const groups = groupByDay(filtered)

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-page-title text-text">Transactions</h1>
          <p className="text-small text-text-3 mt-0.5">
            {showAll ? `${allTxs.length} total` : `Last 30 days · ${allTxs.length} shown`}
          </p>
        </div>
      </div>

      {/* Global account-filter pills — visible across Dashboard/Holdings/Transactions */}
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

      {/* Search + filters toggle */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by ticker or note…"
          className="flex-1 max-w-sm min-w-[180px] px-3 py-2 rounded-sm border border-border bg-surface text-text text-small placeholder:text-text-3 focus:outline-none focus:border-accent"
        />
        <button
          onClick={() => setFiltersOpen(o => !o)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 rounded-sm border text-small transition-colors',
            filtersOpen || activeCount > 0
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-border text-text-2 hover:text-text hover:border-border-strong'
          )}
        >
          <SlidersHorizontal size={14} />
          Filters
          {activeCount > 0 && (
            <span className="bg-accent text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">{activeCount}</span>
          )}
        </button>
        {activeCount > 0 && (
          <button onClick={clearAll} className="text-[12px] text-text-3 hover:text-down underline">
            Clear all
          </button>
        )}
      </div>

      {/* Filters panel */}
      {filtersOpen && (
        <div className="mb-4 p-4 bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <FilterCell label="From">
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="field-input w-full" />
            </FilterCell>
            <FilterCell label="To">
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="field-input w-full" />
            </FilterCell>
            <FilterCell label="Ticker">
              <input
                value={ticker}
                onChange={e => setTicker(e.target.value)}
                placeholder="AAPL, NVDA…"
                className="field-input w-full uppercase"
              />
            </FilterCell>
            <FilterCell label="Broker">
              <select value={brokerFilter} onChange={e => setBrokerFilter(e.target.value)} className="field-input w-full">
                <option value="">Any</option>
                {brokers.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </FilterCell>
            <FilterCell label="Account type">
              <select value={accountTypeFilter} onChange={e => setAccountTypeFilter(e.target.value)} className="field-input w-full">
                <option value="">Any</option>
                {accountTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </FilterCell>
          </div>
        </div>
      )}

      {/* Active-filter chips for quick removal */}
      {activeCount > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {dateFrom && <FilterChip label={`From ${dateFrom}`} onClear={() => setDateFrom('')} />}
          {dateTo && <FilterChip label={`To ${dateTo}`} onClear={() => setDateTo('')} />}
          {ticker && <FilterChip label={`Ticker: ${ticker.toUpperCase()}`} onClear={() => setTicker('')} />}
          {brokerFilter && <FilterChip label={`Broker: ${brokerFilter}`} onClear={() => setBrokerFilter('')} />}
          {accountTypeFilter && <FilterChip label={`Type: ${accountTypeFilter}`} onClear={() => setAccountTypeFilter('')} />}
          <span className="text-[11px] text-text-3 ml-1">→ {filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>
        </div>
      )}

      {isLoading ? (
        <ListLoader />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, txs]) => (
            <div key={day}>
              <p className="text-micro text-text-3 uppercase tracking-wider mb-2">{dayLabel(day)}</p>
              <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush divide-y divide-border overflow-hidden">
                {txs.map(tx => {
                  const optCash = isOptCash(tx.note)
                  const meta = optCash
                    ? { label: tx.type === 'deposit' ? 'Premium Received' : 'Premium Paid',
                        color: tx.type === 'deposit' ? '#10B981' : '#EF4444' }
                    : TX_GROUPS[tx.type]
                  const displayNote = tx.note
                    ? (optCash ? stripOptPrefix(tx.note) : tx.note)
                    : null
                  return (
                    <div key={tx.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 group">
                      {tx.symbol && !optCash ? (
                        <Glyph symbol={tx.symbol} kind={tx.kind ?? 'stock'} size="sm" />
                      ) : (
                        <span className="w-7 h-7 rounded-sm flex items-center justify-center text-[11px] font-bold"
                          style={{ background: `${meta?.color}20`, color: meta?.color }}>
                          {meta?.label.slice(0, 2)}
                        </span>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-small font-medium" style={{ color: meta?.color }}>
                            {meta?.label}
                          </span>
                          {tx.symbol && !optCash && (
                            <span className="font-mono text-[11px] font-bold bg-surface-2 text-text px-1.5 py-0.5 rounded leading-none">
                              {tx.symbol}
                            </span>
                          )}
                          {tx.type === 'split' && tx.qty && tx.price ? (
                            <span className="text-[11px] text-text-3 tabular">
                              {tx.qty}:{tx.price} ratio
                            </span>
                          ) : (tx.type === 'buy_option' || tx.type === 'sell_option') && tx.symbol ? (
                            <span className="text-[11px] text-text-3">
                              {(() => {
                                const cp = tx.option_type === 'put' ? 'P' : 'C'
                                const strike = tx.strike != null ? `${tx.strike}${cp}` : cp
                                if (!tx.expiry) return strike
                                const d = new Date(tx.expiry + 'T00:00:00')
                                return `${strike} ${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`
                              })()}
                            </span>
                          ) : tx.type === 'transfer_out' && tx.qty ? (
                            <span className="text-[11px] text-text-3">
                              {fmtQty(tx.qty)} shares
                            </span>
                          ) : tx.qty && !optCash ? (
                            <span className="text-[11px] text-text-3">
                              {fmtQty(tx.qty)} @ {fmt(tx.price ?? 0)}
                            </span>
                          ) : null}
                        </div>
                        {displayNote && <p className="text-[11px] text-text-3 truncate">{displayNote}</p>}
                      </div>

                      {accMap[tx.account_id] && (
                        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
                          <span className="w-2 h-2 rounded-full" style={{ background: accMap[tx.account_id].color }} />
                          <span className="text-[11px] text-text-3 whitespace-nowrap">
                            {accMap[tx.account_id].institution} · {accMap[tx.account_id].type}
                          </span>
                        </div>
                      )}
                      <span className="tabular text-small font-medium text-text private-val flex-shrink-0">
                        {tx.type === 'split'
                          ? '—'
                          : tx.type === 'transfer_in' || tx.type === 'transfer_out'
                            // Transfer rows don't move cash, but the cost-basis total
                            // (qty × price) is the meaningful number to display.
                            ? (tx.qty && tx.price ? fmt(tx.qty * tx.price) : '—')
                            : fmt(Math.abs(tx.total))}
                      </span>

                      {/* Edit/delete for manual; Live badge for SnapTrade rows */}
                      {tx.id.startsWith('snap_') ? (
                        <span className="flex items-center gap-0.5 text-[10px] text-up font-medium px-1.5 opacity-60">
                          <Wifi size={10} />
                          Live
                        </span>
                      ) : (
                        <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="icon"
                            onClick={() => openEditTx(tx)}>
                            <Pencil size={13} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="hover:text-down"
                            onClick={() => deleteMutation.mutate({ id: tx.id, accountId: tx.account_id })}
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {!showAll && (
            <div className="text-center py-4">
              <button
                onClick={() => setShowAll(true)}
                className="text-small text-accent hover:underline"
              >
                Load full history
              </button>
            </div>
          )}
          {groups.length === 0 && (
            <p className="text-small text-text-3 py-8 text-center">No transactions found</p>
          )}
        </div>
      )}
    </div>
  )
}

function FilterCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-text-3 uppercase tracking-wider block mb-1">{label}</label>
      {children}
    </div>
  )
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent-soft text-accent text-[11px] font-medium">
      {label}
      <button onClick={onClear} className="hover:text-down" aria-label={`Remove ${label}`}>
        <X size={11} />
      </button>
    </span>
  )
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
