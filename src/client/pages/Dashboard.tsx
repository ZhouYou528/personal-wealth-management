import { useQuery } from '@tanstack/react-query'
import { holdings as holdingsApi, nav as navApi, transactions as txApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangePill } from '@/components/ChangePill'
import { Glyph } from '@/components/Glyph'
import { fmtMoney, fmtDate } from '@/lib/utils'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { Holding, NavSnapshot, Transaction } from '@shared/types'

function NetWorthHero({ holdings }: { holdings: Holding[] }) {
  const netWorth = holdings.reduce((sum, h) => {
    const mult = h.multiplier ?? 1
    return sum + h.qty * h.px * mult
  }, 0)

  const costBasis = holdings.reduce((sum, h) => {
    const mult = h.multiplier ?? 1
    return sum + h.qty * h.cost * mult
  }, 0)

  const totalPnl = netWorth - costBasis
  const totalPnlPct = costBasis > 0 ? (totalPnl / costBasis) * 100 : 0

  return (
    <div className="mb-4">
      <p className="text-micro text-text-3 uppercase tracking-widest mb-1">Total Net Worth</p>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="tabular font-semibold text-[48px] leading-none tracking-tight text-text private-val">
          {fmtMoney(netWorth)}
        </span>
        <ChangePill pct={totalPnlPct} abs={totalPnl} />
      </div>
    </div>
  )
}

function NavChart({ data }: { data: NavSnapshot[] }) {
  if (data.length < 2) {
    return (
      <div className="h-[260px] flex items-center justify-center text-text-3 text-small">
        No history yet — check back after the first nightly snapshot.
      </div>
    )
  }

  const chartData = data.map((d) => ({
    date: d.date,
    value: d.value,
  }))

  return (
    <div className="h-[260px] private-val">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="navGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10B981" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--text-3, #A8A29E)' }}
            tickFormatter={(v: string) => v.slice(5)}
            interval="preserveStartEnd"
          />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--surface))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 10,
              fontSize: 12,
            }}
            formatter={(v: number) => [fmtMoney(v), 'Net worth']}
            labelFormatter={(label: string) => fmtDate(label)}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#10B981"
            strokeWidth={2}
            fill="url(#navGradient)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function AllocationDonut({ holdings }: { holdings: Holding[] }) {
  const kindTotals: Record<string, number> = {}
  for (const h of holdings) {
    const val = h.qty * h.px * (h.multiplier ?? 1)
    kindTotals[h.kind] = (kindTotals[h.kind] ?? 0) + val
  }
  const total = Object.values(kindTotals).reduce((a, b) => a + b, 0)
  const KIND_COLOR: Record<string, string> = {
    stock: '#10B981', etf: '#06B6D4', option: '#F59E0B', crypto: '#F97316', cash: '#A1A1AA',
  }

  return (
    <div className="space-y-2">
      {Object.entries(kindTotals)
        .sort(([, a], [, b]) => b - a)
        .map(([kind, val]) => {
          const pct = total > 0 ? (val / total) * 100 : 0
          return (
            <div key={kind} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: KIND_COLOR[kind] }} />
              <span className="text-small text-text-2 capitalize flex-1">{kind}</span>
              <span className="tabular text-small text-text-3">{pct.toFixed(1)}%</span>
              <span className="tabular text-small text-text font-medium private-val w-24 text-right">
                {fmtMoney(val)}
              </span>
            </div>
          )
        })}
    </div>
  )
}

function RecentActivity({ transactions }: { transactions: Transaction[] }) {
  const TX_LABELS: Record<string, string> = {
    buy: 'Bought', sell: 'Sold', buy_crypto: 'Bought', sell_crypto: 'Sold',
    deposit: 'Deposited', withdraw: 'Withdrew', transfer: 'Transferred',
    dividend: 'Dividend', interest: 'Interest', buy_option: 'Bought Option',
    sell_option: 'Sold Option', recurring: 'Recurring',
  }

  return (
    <div className="space-y-1">
      {transactions.slice(0, 5).map((tx) => (
        <div key={tx.id} className="flex items-center gap-2 py-1.5">
          {tx.symbol && (
            <Glyph symbol={tx.symbol} kind={tx.kind ?? 'stock'} size="sm" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-small text-text truncate">
              {TX_LABELS[tx.type] ?? tx.type}{tx.symbol ? ` ${tx.symbol}` : ''}
            </p>
            <p className="text-[11px] text-text-3">{fmtDate(tx.date)}</p>
          </div>
          <span className={`tabular text-small font-medium private-val ${tx.total >= 0 ? 'text-text' : 'text-down'}`}>
            {tx.total < 0 ? '-' : ''}{fmtMoney(Math.abs(tx.total))}
          </span>
        </div>
      ))}
      {transactions.length === 0 && (
        <p className="text-small text-text-3 py-4 text-center">No transactions yet</p>
      )}
    </div>
  )
}

export function Dashboard() {
  const { selectedAccountId } = useStore()

  const { data: holdingsData = [] } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const { data: navData = [] } = useQuery({
    queryKey: ['nav', selectedAccountId],
    queryFn: () => navApi.history(365, selectedAccountId ?? undefined),
  })

  const { data: recentTxs = [] } = useQuery({
    queryKey: ['transactions', selectedAccountId, 'recent'],
    queryFn: () => txApi.list({ accountId: selectedAccountId ?? undefined, limit: 10 }),
  })

  return (
    <div className="p-8 space-y-4 max-w-7xl mx-auto">
      {/* Hero */}
      <Card padding="hero">
        <NetWorthHero holdings={holdingsData} />
        <NavChart data={navData} />
      </Card>

      {/* Row 2: Allocation + Holdings breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Allocation</CardTitle></CardHeader>
          <AllocationDonut holdings={holdingsData} />
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <RecentActivity transactions={recentTxs} />
        </Card>
      </div>
    </div>
  )
}
