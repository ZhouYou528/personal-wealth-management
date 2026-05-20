import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { holdings as holdingsApi, transactions as txApi } from '@/lib/api'
import { Glyph } from '@/components/Glyph'
import { KindBadge } from '@/components/ui/badge'
import { ChangePill } from '@/components/ChangePill'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { fmtMoney, fmtQty, fmtDate } from '@/lib/utils'
import { useStore } from '@/lib/store'

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-micro text-text-3 uppercase tracking-wider">{label}</p>
      <p className="tabular font-semibold text-[18px] text-text private-val">{value}</p>
      {sub && <p className="text-[11px] text-text-3">{sub}</p>}
    </div>
  )
}

export function HoldingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { selectedAccountId, openAddTx } = useStore()

  const { data: allHoldings = [] } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const holding = allHoldings.find(h => h.id === decodeURIComponent(id ?? ''))

  const { data: txs = [] } = useQuery({
    queryKey: ['transactions', holding?.symbol],
    queryFn: () => txApi.list({ symbol: holding?.symbol }),
    enabled: !!holding?.symbol,
  })

  if (!holding) {
    return (
      <div className="p-8 text-text-3 text-small">
        Holding not found. <button onClick={() => navigate('/holdings')} className="text-accent underline">Back to Holdings</button>
      </div>
    )
  }

  const value = holding.qty * holding.px * (holding.multiplier ?? 1)
  const costTotal = holding.qty * holding.cost * (holding.multiplier ?? 1)
  const pnl = value - costTotal
  const pnlPct = costTotal > 0 ? (pnl / costTotal) * 100 : 0

  const TX_LABELS: Record<string, string> = {
    buy: 'Buy', sell: 'Sell', buy_crypto: 'Buy', sell_crypto: 'Sell',
    dividend: 'Dividend', buy_option: 'Buy Option', sell_option: 'Sell Option',
  }

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-4">
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
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Glyph symbol={holding.symbol} kind={holding.kind} size="lg" />
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <h1 className="text-[22px] font-semibold text-text">{holding.symbol}</h1>
                <KindBadge kind={holding.kind} />
              </div>
              <p className="text-small text-text-3">{holding.name}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openAddTx({ symbol: holding.symbol, type: 'sell' })}>
              Sell
            </Button>
            <Button size="sm" onClick={() => openAddTx({ symbol: holding.symbol, type: 'buy' })}>
              Buy more
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-baseline gap-3">
          <span className="tabular font-semibold text-[36px] leading-none text-text private-val">
            {fmtMoney(holding.px)}
          </span>
          <ChangePill pct={pnlPct} />
        </div>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <Stat label="Market Value" value={fmtMoney(value)} />
        </Card>
        <Card>
          <Stat label="Cost Basis" value={fmtMoney(costTotal)} sub={`Avg ${fmtMoney(holding.cost)}/unit`} />
        </Card>
        <Card>
          <Stat
            label="Total Return"
            value={`${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}`}
            sub={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`}
          />
        </Card>
        <Card>
          <Stat
            label="Quantity"
            value={fmtQty(holding.qty)}
            sub={holding.kind === 'option' ? `${holding.option_type ?? ''} · ${holding.strike} strike` : holding.kind}
          />
        </Card>
      </div>

      {/* Transactions in this symbol */}
      <Card>
        <h2 className="text-section-h2 text-text mb-4">Transactions in {holding.symbol}</h2>
        <div className="space-y-1">
          {txs.map(tx => (
            <div key={tx.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <div>
                <span className="text-small font-medium text-text capitalize">
                  {TX_LABELS[tx.type] ?? tx.type}
                </span>
                {tx.qty && (
                  <span className="text-[11px] text-text-3 ml-1.5">
                    {fmtQty(tx.qty)} @ {fmtMoney(tx.price ?? 0)}
                  </span>
                )}
              </div>
              <div className="text-right">
                <p className="tabular text-small font-medium text-text private-val">
                  {fmtMoney(Math.abs(tx.total))}
                </p>
                <p className="text-[11px] text-text-3">{fmtDate(tx.date)}</p>
              </div>
            </div>
          ))}
          {txs.length === 0 && (
            <p className="text-small text-text-3 py-4 text-center">No transactions</p>
          )}
        </div>
      </Card>
    </div>
  )
}
