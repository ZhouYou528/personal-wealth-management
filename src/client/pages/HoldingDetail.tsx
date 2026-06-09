import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { holdings as holdingsApi, transactions as txApi, nav as navApi, fx as fxApi, accounts as accountsApi, quotes as quotesApi } from '@/lib/api'
import { PageLoader } from '@/components/ui/spinner'
import { Glyph } from '@/components/Glyph'
import { KindBadge } from '@/components/ui/badge'
import { ChangePill } from '@/components/ChangePill'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { fmtQty, fmtDate, fmtOptionLabel, daysToExpiry, todayISO, lockedCollateral, KIND_COLOR, KIND_LABEL } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import type { AssetKind } from '@shared/types'
import { useStore } from '@/lib/store'

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-1 min-w-0">
      <p className="text-micro text-text-3 uppercase tracking-wider">{label}</p>
      <p className="tabular font-semibold text-[14px] sm:text-[18px] text-text private-val truncate">{value}</p>
      {sub && <p className="text-[11px] text-text-3 truncate">{sub}</p>}
    </div>
  )
}

function isOptCash(note?: string | null) { return !!note?.startsWith('[opt-cash:') }
function stripOptPrefix(note: string) { return note.replace(/^\[opt-cash:[^\]]+\]\s*/, '') }

export function HoldingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const { selectedAccountId, openAddTx } = useStore()

  const { data: allHoldings = [], isLoading, isFetching } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })

  const holding = allHoldings.find(h => h.id === decodeURIComponent(id ?? ''))
  const isLive = !!(accs.find(a => a.id === holding?.account_id)?.snaptrade_account_id)

  // If the holding's gone (e.g. fully sold), bounce back to the list once the query has settled
  useEffect(() => {
    if (!isLoading && !isFetching && !holding) {
      navigate('/holdings', { replace: true })
    }
  }, [isLoading, isFetching, holding, navigate])

  const isCash = holding?.kind === 'cash'
  // Include deposit/withdraw (covers both real cash moves and option premium companions)
  const CASH_TX_TYPES = new Set(['deposit', 'withdraw', 'interest', 'dividend', 'transfer'])

  const { data: txs = [] } = useQuery({
    queryKey: isCash
      ? ['transactions', 'cash', holding?.account_id]
      : ['transactions', holding?.symbol],
    queryFn: async () => {
      if (!holding) return []
      if (isCash) {
        const list = await txApi.list({ accountId: holding.account_id, limit: 1000 })
        return list.filter(t => CASH_TX_TYPES.has(t.type))
      }
      return txApi.list({ symbol: holding.symbol })
    },
    enabled: !!holding,
  })

  // Fetch underlying stock price for options (before early returns — hooks must be unconditional)
  const underlyingSymbol = holding?.kind === 'option' ? (holding?.underlying ?? holding?.symbol ?? null) : null
  const { data: underlyingQuote } = useQuery({
    queryKey: ['quote', underlyingSymbol],
    queryFn: () => quotesApi.get(underlyingSymbol!),
    enabled: !!underlyingSymbol,
    staleTime: 60_000,
  })

  // All mutation hooks must be declared before any early return — closure refs to `holding`
  // are safe because mutationFns aren't invoked until UI buttons fire `.mutate()`, and those
  // buttons only render when `holding` is defined.
  const setMarkMut = useMutation({
    mutationFn: (price: number) => holdingsApi.setMark(holding!.id, price),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holdings'] }),
  })

  const clearMarkMut = useMutation({
    mutationFn: () => holdingsApi.clearMark(holding!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holdings'] }),
  })

  const changeKindMut = useMutation({
    mutationFn: (newKind: AssetKind) =>
      txApi.updateBySymbol(holding!.symbol, { kind: newKind, accountId: holding!.account_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
    },
  })

  const expireWorthlessMut = useMutation({
    mutationFn: () => txApi.create({
      tx_date: holding!.expiry ?? todayISO(),
      account_id: holding!.account_id,
      type: 'sell_option',
      symbol: holding!.symbol,
      kind: 'option',
      qty: holding!.qty,
      price: 0,
      total: 0,
      option_type: holding!.option_type,
      strike: holding!.strike,
      expiry: holding!.expiry,
      underlying: holding!.underlying ?? holding!.symbol,
      note: 'Expired worthless',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
      navApi.backfill(holding!.account_id)
        .then(() => qc.invalidateQueries({ queryKey: ['nav'] }))
        .catch(() => {})
    },
  })

  if (isLoading) {
    return <PageLoader />
  }

  if (!holding) {
    // Effect above is navigating away; render nothing to avoid a "not found" flash
    return null
  }

  const value = holding.qty * holding.px * (holding.multiplier ?? 1)
  const costTotal = holding.qty * holding.cost * (holding.multiplier ?? 1)
  const pnl = value - costTotal
  const pnlPct = costTotal > 0 ? (pnl / costTotal) * 100 : 0
  const isOption = holding.kind === 'option'
  const dte = isOption ? daysToExpiry(holding.expiry) : null

  // Option-specific computed values
  const optionTxs = isOption
    ? txs.filter(tx => tx.option_type === holding.option_type && tx.strike === holding.strike && tx.expiry === holding.expiry)
    : []
  const buyTxs = optionTxs
    .filter(t => t.type === 'buy_option' || t.type === 'buy')
    .sort((a, b) => a.tx_date.localeCompare(b.tx_date))
  const buyDates = [...new Set(buyTxs.map(t => t.tx_date))].sort()
  const dateBoughtDisplay = buyDates.length === 0 ? '—'
    : buyDates.length === 1 ? fmtDate(buyDates[0])
    : `${fmtDate(buyDates[0])} · ${fmtDate(buyDates[buyDates.length - 1])}`
  const breakeven = isOption
    ? (holding.option_type === 'put' ? (holding.strike ?? 0) - holding.cost : (holding.strike ?? 0) + holding.cost)
    : 0

  const TX_LABELS: Record<string, string> = {
    buy: 'Buy', sell: 'Sell', buy_crypto: 'Buy', sell_crypto: 'Sell',
    dividend: 'Dividend', buy_option: 'Buy Option', sell_option: 'Sell Option',
    split: 'Split',
    transfer_in: 'Transfer In', transfer_out: 'Transfer Out',
  }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-4">
      {/* Back */}
      <button
        onClick={() => navigate('/holdings')}
        className="flex items-center gap-1 text-text-2 hover:text-text text-small transition-colors"
      >
        <ChevronLeft size={15} />
        Holdings
      </button>

      {/* Header */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-3">
            <Glyph symbol={holding.symbol} kind={holding.kind} size="lg" />
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <h1 className="text-[18px] sm:text-[22px] font-semibold text-text">
                  {isOption ? fmtOptionLabel(holding) : holding.symbol}
                </h1>
                {isOption || isCash || isLive ? (
                  <KindBadge kind={holding.kind} />
                ) : (
                  <KindSelect
                    value={holding.kind}
                    pending={changeKindMut.isPending}
                    onChange={(k) => {
                      if (k === holding.kind) return
                      const n = txs.filter(t => t.symbol === holding.symbol && t.account_id === holding.account_id).length
                      const msg = `Reclassify ${n} ${holding.symbol} transaction${n === 1 ? '' : 's'} from ${holding.kind.toUpperCase()} to ${k.toUpperCase()}? This rewrites every existing row and can't be undone.`
                      if (confirm(msg)) changeKindMut.mutate(k)
                    }}
                  />
                )}
              </div>
              <p className="text-small text-text-3">
                {isOption
                  ? (dte == null ? holding.name
                      : dte < 0 ? `Expired ${-dte}d ago`
                      : dte === 0 ? 'Expires today'
                      : `${dte}d to expiry`)
                  : holding.name}
              </p>
            </div>
          </div>
          {!isLive && (
            <div className="flex gap-2 flex-wrap">
              {isOption ? (
                <>
                  <Button
                    variant="outline" size="sm"
                    disabled={expireWorthlessMut.isPending}
                    onClick={() => {
                      if (confirm(`Mark all ${fmtQty(holding.qty)} contract(s) as expired worthless?`)) {
                        expireWorthlessMut.mutate()
                      }
                    }}
                  >
                    Expire worthless
                  </Button>
                  <Button size="sm" onClick={() => openAddTx({
                    symbol: holding.symbol,
                    type: holding.qty < 0 ? 'buy_option' : 'sell_option',
                    accountId: holding.account_id,
                    optionType: holding.option_type ?? undefined,
                    strike: holding.strike != null ? String(holding.strike) : undefined,
                    expiry: holding.expiry ?? undefined,
                    qty: String(Math.abs(holding.qty)),
                    hideOptionFields: true,
                  })}>
                    Close position
                  </Button>
                </>
              ) : isCash ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => openAddTx({ accountId: holding.account_id, type: 'withdraw' })}>
                    Withdraw
                  </Button>
                  <Button size="sm" onClick={() => openAddTx({ accountId: holding.account_id, type: 'deposit' })}>
                    Deposit
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => openAddTx({ symbol: holding.symbol, accountId: holding.account_id, type: 'sell' })}>
                    Sell
                  </Button>
                  <Button size="sm" onClick={() => openAddTx({ symbol: holding.symbol, accountId: holding.account_id, type: 'buy' })}>
                    Buy more
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-baseline gap-3 flex-wrap">
          <span className="tabular font-semibold text-[28px] sm:text-[36px] leading-none text-text private-val">
            {fmt(holding.px)}
          </span>
          <ChangePill pct={pnlPct} />
          {isOption && (
            <span className="text-[11px] text-text-3">
              {holding.marked ? 'marked' : 'no live quote — using cost basis'}
            </span>
          )}
        </div>

        {!isLive && (isOption || holding.kind === 'mutual_fund') && (
          <MarkEditor
            holdingId={holding.id}
            currentPx={holding.px}
            marked={!!holding.marked}
            isTotalValue={holding.kind === 'mutual_fund' && holding.qty === 1}
            onSave={(p) => setMarkMut.mutate(p)}
            onClear={() => clearMarkMut.mutate()}
            pending={setMarkMut.isPending || clearMarkMut.isPending}
          />
        )}
      </Card>

      {/* Stats */}
      {isOption ? (
        <Card>
          <div className="grid grid-cols-2 gap-x-8 gap-y-5">
            <Stat label="Contracts" value={fmtQty(holding.qty)} />
            <Stat label="Current price" value={fmt(holding.px)} sub="per share" />
            <Stat label="Average cost" value={fmt(holding.cost)} sub="per share" />
            <Stat label="Market value" value={fmt(value)} />
            <Stat label="Date bought" value={dateBoughtDisplay} />
            <Stat label="Expiration date" value={holding.expiry ? fmtDate(holding.expiry) : '—'} />
            <Stat
              label={`${holding.underlying ?? holding.symbol} breakeven`}
              value={fmt(breakeven)}
            />
            <Stat
              label={`Current ${holding.underlying ?? holding.symbol} price`}
              value={underlyingQuote?.price ? fmt(underlyingQuote.price) : '—'}
            />
          </div>
          <div className="mt-5 pt-4 border-t border-border">
            <div className="flex justify-between items-center">
              <span className="text-small text-text-3">Total return</span>
              <span className={`tabular font-semibold text-small private-val ${pnl >= 0 ? 'text-up' : 'text-down'}`}>
                {pnl >= 0 ? '+' : ''}{fmt(pnl)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </Card>
      ) : isCash ? (() => {
        // For cash holdings: replace the standard four-stat row with Total / Locked / Available.
        // `locked` comes from open short puts in the same account.
        const sameAccountHoldings = allHoldings.filter(h => h.account_id === holding.account_id)
        const locked = lockedCollateral(sameAccountHoldings)
        const available = value - locked
        return (
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <Stat label="Total Cash" value={fmt(value)} />
            </Card>
            <Card>
              <Stat
                label="Locked"
                value={fmt(locked)}
                sub={locked > 0 ? 'Collateral on short puts' : 'No open short puts'}
              />
            </Card>
            <Card>
              <Stat
                label="Available"
                value={fmt(available)}
                sub={available < 0 ? 'Overcommitted' : 'Buying power'}
              />
            </Card>
          </div>
        )
      })() : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <Stat label="Market Value" value={fmt(value)} />
          </Card>
          <Card>
            <Stat label="Cost Basis" value={fmt(costTotal)} sub={`Avg ${fmt(holding.cost)}/unit`} />
          </Card>
          <Card>
            <Stat
              label="Total Return"
              value={`${pnl >= 0 ? '+' : ''}${fmt(pnl)}`}
              sub={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`}
            />
          </Card>
          <Card>
            <Stat label="Quantity" value={fmtQty(holding.qty)} sub={holding.kind} />
          </Card>
        </div>
      )}

      {/* Transactions in this symbol (filtered to this contract for options) */}
      <Card>
        <h2 className="text-section-h2 text-text mb-4">
          {isOption ? `Transactions for ${fmtOptionLabel(holding)}`
            : isCash ? 'Cash activity'
            : `Transactions in ${holding.symbol}`}
        </h2>
        <div className="space-y-1">
          {txs
            .filter(tx => !isOption ||
              (tx.option_type === holding.option_type
                && tx.strike === holding.strike
                && tx.expiry === holding.expiry))
            .map(tx => {
              const optCash = isOptCash(tx.note)
              const label = optCash
                ? (tx.type === 'deposit' ? 'Option Premium' : 'Option Premium Paid')
                : (TX_LABELS[tx.type] ?? tx.type)
              const labelColor = optCash
                ? (tx.type === 'deposit' ? '#10B981' : '#EF4444')
                : undefined
              const subNote = optCash && tx.note ? stripOptPrefix(tx.note) : null
              return (
                <div key={tx.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="min-w-0 mr-3">
                    <span className="text-small font-medium capitalize" style={labelColor ? { color: labelColor } : { color: 'var(--color-text)' }}>
                      {label}
                    </span>
                    {subNote && (
                      <p className="text-[11px] text-text-3 truncate">{subNote}</p>
                    )}
                    {!optCash && tx.qty && (
                      <span className="text-[11px] text-text-3 ml-1.5">
                        {fmtQty(tx.qty)} @ {fmt(tx.price ?? 0)}
                      </span>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="tabular text-small font-medium text-text private-val">
                      {fmt(Math.abs(tx.total))}
                    </p>
                    <p className="text-[11px] text-text-3">{fmtDate(tx.tx_date)}</p>
                  </div>
                </div>
              )
            })}
          {txs.length === 0 && (
            <p className="text-small text-text-3 py-4 text-center">No transactions</p>
          )}
        </div>
      </Card>
    </div>
  )
}

function MarkEditor({
  holdingId, currentPx, marked, isTotalValue = false, onSave, onClear, pending,
}: {
  holdingId: string
  currentPx: number
  marked: boolean
  isTotalValue?: boolean   // true for mutual funds where qty=1, so price = total account value
  onSave: (p: number) => void
  onClear: () => void
  pending: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(currentPx))
  const [currency, setCurrency] = useState<'USD' | 'CAD'>('USD')
  const [converting, setConverting] = useState(false)

  useEffect(() => { setDraft(String(currentPx)) }, [holdingId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    let usd = Number(draft)
    if (isNaN(usd) || usd < 0) return
    if (currency === 'CAD') {
      setConverting(true)
      try {
        const fx = await fxApi.rates('USD')
        const rate = fx.rates['CAD']
        if (rate && rate > 0) usd = usd / rate
      } catch {
        // fall back to as-entered
      } finally {
        setConverting(false)
      }
    }
    onSave(usd)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => setEditing(true)} className="text-[12px] text-accent hover:underline">
          {marked ? `Update ${isTotalValue ? 'value' : 'mark'}` : `Set ${isTotalValue ? 'current value' : 'current price'}`}
        </button>
        {marked && (
          <button onClick={onClear} disabled={pending} className="text-[12px] text-text-3 hover:text-down">
            · Clear
          </button>
        )}
        {isTotalValue && (
          <span className="text-[11px] text-text-3">— enter total balance from your statement</span>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <label className="text-[11px] text-text-3">
        {isTotalValue ? 'Total account value' : 'Current price (per share)'}
      </label>
      {isTotalValue && (
        <div className="flex text-[11px] gap-0.5 bg-surface-2 rounded p-0.5">
          {(['USD', 'CAD'] as const).map(c => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={`px-2 py-0.5 rounded font-medium transition-colors ${currency === c ? 'bg-surface text-text shadow-sm' : 'text-text-3 hover:text-text'}`}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="text-text-3 text-small">{currency === 'CAD' ? 'CA$' : '$'}</span>
        <input
          type="number"
          step="any"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="field-input w-32 tabular"
        />
      </div>
      {currency === 'CAD' && (
        <span className="text-[11px] text-text-3">→ converted to USD at live rate</span>
      )}
      <Button size="sm" disabled={pending || converting || !draft || isNaN(Number(draft))} onClick={handleSave}>
        {converting ? 'Converting…' : 'Save'}
      </Button>
      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
      {!isTotalValue && <span className="text-[11px] text-text-3">× 100 shares per contract</span>}
    </div>
  )
}

function KindSelect({
  value, pending, onChange,
}: {
  value: AssetKind
  pending: boolean
  onChange: (k: AssetKind) => void
}) {
  const color = KIND_COLOR[value] ?? '#A1A1AA'
  return (
    <div className="relative inline-flex items-center" title="Change asset type">
      <select
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as AssetKind)}
        className="appearance-none rounded px-1.5 py-0.5 text-[11px] font-medium cursor-pointer pr-5 border-0"
        style={{ backgroundColor: `${color}20`, color }}
      >
        {(['stock','etf','mutual_fund','crypto','cash'] as AssetKind[]).map(k => (
          <option key={k} value={k}>{KIND_LABEL[k]}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1 text-[8px]" style={{ color }}>▾</span>
    </div>
  )
}
