import { useQuery } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, TrendingUp, TrendingDown } from 'lucide-react'
import { Glyph } from '@/components/Glyph'
import { holdings as holdingsApi, nav as navApi, accounts as accountsApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { fmtDate, cn, todayISO, daysAgoISO, lockedCollateral } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'
import type { Holding, NavSnapshot, Account } from '@shared/types'

// ── Types & constants ─────────────────────────────────────────

type Range = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

const RANGE_DAYS: Record<Range, number> = {
  '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, 'ALL': 3650,
}

const HOLDING_COLORS = [
  '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#EF4444',
  '#06B6D4', '#F97316', '#84CC16', '#EC4899', '#6366F1',
  '#A78BFA', '#34D399', '#60A5FA', '#FCD34D',
]

const KIND_COLOR: Record<string, string> = {
  stock: '#10B981', etf: '#06B6D4', option: '#F59E0B', crypto: '#F97316', cash: '#A1A1AA',
}

// ── Helpers ───────────────────────────────────────────────────

function daysAgoDate(days: number) {
  return daysAgoISO(days)
}

function findSnapBefore(snaps: NavSnapshot[], targetDate: string): NavSnapshot | undefined {
  return snaps
    .filter(s => s.snap_date <= targetDate)
    .at(-1)
}

// ── Custom tooltip ────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  const { fmt } = useMoney()
  if (!active || !payload?.length || !label) return null
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 shadow-lg text-small pointer-events-none">
      <p className="text-text-3 text-[11px] mb-0.5">{fmtDate(label)}</p>
      <p className="tabular font-semibold text-text private-val">{fmt(payload[0].value)}</p>
    </div>
  )
}

// ── Nav chart ─────────────────────────────────────────────────

function NavChart({
  navData, currentValue, range, color,
}: {
  navData: NavSnapshot[]
  currentValue: number
  range: Range
  color: string
}) {
  const today = todayISO()

  const chartData = useMemo(() => {
    const since = daysAgoDate(RANGE_DAYS[range])
    const pts = navData
      .filter(s => s.snap_date >= since)
      .map(s => ({ date: s.snap_date, value: s.value }))

    // Upsert today's live value
    if (pts.length > 0 && pts[pts.length - 1].date === today) {
      pts[pts.length - 1].value = currentValue
    } else {
      pts.push({ date: today, value: currentValue })
    }
    return pts
  }, [navData, currentValue, range, today])

  if (chartData.length < 2) {
    return (
      <div className="h-[180px] flex items-center justify-center text-text-3 text-small">
        Import transactions to see your portfolio history
      </div>
    )
  }

  const tickFmt = (v: string) => {
    if (range === '1D') return v.slice(5).replace('-', '/')
    if (range === '1W' || range === '1M') return v.slice(5).replace('-', '/')
    if (range === '3M' || range === '1Y') return v.slice(0, 7)
    return v.slice(0, 4)
  }

  const gradId = `navGrad-${color.replace('#', '')}`

  return (
    <div className="h-[180px] -mx-6">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.18} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--color-text-3, #A8A29E)' }}
            tickFormatter={tickFmt}
            interval="preserveStartEnd"
            padding={{ left: 16, right: 16 }}
          />
          <YAxis hide domain={['auto', 'auto']} />
          <Tooltip content={<ChartTooltip />} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Period stat cell ──────────────────────────────────────────

function PeriodStat({ label, change, pct, pending }: {
  label: string; change: number; pct: number; pending?: boolean
}) {
  const { fmt } = useMoney()
  if (pending) {
    return (
      <div>
        <p className="text-micro text-text-3 uppercase tracking-wider mb-1">{label}</p>
        <p className="tabular text-[15px] font-semibold text-text-3">—</p>
        <p className="text-[11px] text-text-3" title="Pending — accumulates as the daily snapshot runs">
          pending
        </p>
      </div>
    )
  }
  const up = change >= 0
  return (
    <div>
      <p className="text-micro text-text-3 uppercase tracking-wider mb-1">{label}</p>
      <p className={cn('tabular text-[15px] font-semibold private-val', up ? 'text-up' : 'text-down')}>
        {up ? '+' : ''}{fmt(change)}
      </p>
      <p className={cn('tabular text-[11px]', up ? 'text-up' : 'text-down')}>
        {up ? '+' : ''}{pct.toFixed(2)}%
      </p>
    </div>
  )
}

// ── Allocation donut ──────────────────────────────────────────

type DonutMode = 'holding' | 'class'

function AllocationDonut({ holdings }: { holdings: Holding[] }) {
  const [mode, setMode] = useState<DonutMode>('holding')
  const { fmt, fmtCompact } = useMoney()

  // Use absolute exposure so short positions occupy donut space rather than producing
  // negative slices (Recharts can't render those).
  const absValue = (h: Holding) => Math.abs(h.qty * h.px * (h.multiplier ?? 1))
  const total = holdings.reduce((s, h) => s + absValue(h), 0)

  const slices = useMemo(() => {
    if (mode === 'class') {
      const byKind: Record<string, number> = {}
      for (const h of holdings) {
        byKind[h.kind] = (byKind[h.kind] ?? 0) + absValue(h)
      }
      return Object.entries(byKind)
        .sort(([, a], [, b]) => b - a)
        .map(([kind, val], i) => ({
          key: kind,
          label: kind.charAt(0).toUpperCase() + kind.slice(1),
          val,
          color: KIND_COLOR[kind] ?? HOLDING_COLORS[i % HOLDING_COLORS.length],
        }))
    }

    // By individual holding
    const sorted = [...holdings]
      .filter(h => absValue(h) > 0)
      .sort((a, b) => absValue(b) - absValue(a))
    const top = sorted.slice(0, 9)
    const rest = sorted.slice(9)
    const otherVal = rest.reduce((s, h) => s + absValue(h), 0)
    return [
      ...top.map((h, i) => ({
        key: h.id,
        label: h.symbol === 'CASH' ? 'Cash' : (h.qty < 0 ? `${h.symbol} (short)` : h.symbol),
        val: absValue(h),
        color: HOLDING_COLORS[i % HOLDING_COLORS.length],
      })),
      ...(otherVal > 0 ? [{ key: 'other', label: 'Other', val: otherVal, color: '#6B7280' }] : []),
    ]
  }, [holdings, mode])

  if (slices.length === 0) {
    return <p className="text-small text-text-3 py-6 text-center">No holdings yet</p>
  }

  return (
    <div>
      {/* Mode toggle */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-small font-semibold text-text">Allocation</p>
        <div className="flex text-[11px] gap-0.5 bg-surface-2 rounded p-0.5">
          {(['holding', 'class'] as DonutMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'px-2 py-0.5 rounded transition-colors font-medium',
                mode === m ? 'bg-surface text-text shadow-sm' : 'text-text-3 hover:text-text',
              )}
            >
              {m === 'holding' ? 'By holding' : 'By asset class'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-5">
        {/* Donut */}
        <div className="relative flex-shrink-0" style={{ width: 148, height: 148 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                cx="50%"
                cy="50%"
                innerRadius={46}
                outerRadius={68}
                dataKey="val"
                strokeWidth={2}
                stroke="hsl(var(--surface))"
              >
                {slices.map(s => <Cell key={s.key} fill={s.color} />)}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--surface))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, _name: string, entry: { payload?: { label?: string } }) => [
                  fmt(v), entry.payload?.label ?? '',
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <p className="text-[9px] text-text-3 uppercase tracking-widest">TOTAL</p>
            <p className="text-[13px] font-bold text-text private-val tabular">{fmtCompact(total)}</p>
          </div>
        </div>

        {/* Legend */}
        <div className="flex-1 min-w-0 space-y-1.5 pt-0.5">
          {slices.map(({ key, label, val, color }) => {
            const pct = total > 0 ? (val / total) * 100 : 0
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-[12px] text-text-2 flex-1 truncate">{label}</span>
                <span className="tabular text-[11px] text-text-3 w-9 text-right">{pct.toFixed(1)}%</span>
                <span className="tabular text-[12px] font-medium text-text private-val w-16 text-right">
                  {fmtCompact(val)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Accounts summary ──────────────────────────────────────────

function AccountsSummary({ accounts, holdings }: { accounts: Account[]; holdings: Holding[] }) {
  const navigate = useNavigate()
  const { fmt } = useMoney()

  const rows = useMemo(() => accounts.map(acc => {
    const ah = holdings.filter(h => h.account_id === acc.id)
    const value = ah.reduce((s, h) => s + h.qty * h.px * (h.multiplier ?? 1), 0)
    const cost  = ah.reduce((s, h) => s + h.qty * h.cost * (h.multiplier ?? 1), 0)
    const pnl = value - cost
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
    return { ...acc, value, pnl, pnlPct }
  }).filter(a => a.value > 0.01), [accounts, holdings])

  if (rows.length === 0) {
    return <p className="text-small text-text-3 py-6 text-center">No accounts with holdings</p>
  }

  return (
    <div className="space-y-0.5">
      {rows.map(acc => (
        <div
          key={acc.id}
          className="flex items-center gap-3 py-2.5 px-2 rounded-sm hover:bg-surface-2 cursor-pointer transition-colors"
          onClick={() => navigate('/accounts')}
        >
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 uppercase"
            style={{ background: acc.color }}
          >
            {acc.institution.slice(0, 2)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-small font-medium text-text leading-tight">{acc.name}</p>
            <p className="text-[11px] text-text-3 truncate">
              {acc.institution}
              {acc.number ? ` · ${acc.number}` : ''}
            </p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="tabular text-small font-semibold text-text private-val">{fmt(acc.value)}</p>
            <p className={cn('tabular text-[11px]', acc.pnl >= 0 ? 'text-up' : 'text-down')}>
              <span className="private-val">{acc.pnl >= 0 ? '+' : ''}{fmt(acc.pnl)}</span>
              <span className="opacity-70"> ({acc.pnlPct >= 0 ? '+' : ''}{acc.pnlPct.toFixed(2)}%)</span>
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────

export function Dashboard() {
  const { selectedAccountId, setSelectedAccountId } = useStore()
  const navigate = useNavigate()
  const { fmt } = useMoney()
  const [range, setRange] = useState<Range>('1M')

  const { data: holdingsData = [] } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const { data: navData = [] } = useQuery({
    queryKey: ['nav', selectedAccountId, 'full'],
    queryFn: () => navApi.history(1825, selectedAccountId ?? undefined),
  })

  const { data: accountsList = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  })

  const currentValue = holdingsData.reduce((s, h) => s + h.qty * h.px * (h.multiplier ?? 1), 0)
  const costBasis    = holdingsData.reduce((s, h) => s + h.qty * h.cost * (h.multiplier ?? 1), 0)
  const locked       = lockedCollateral(holdingsData)

  // Sorted snapshots (ascending) for lookups
  const sortedSnaps = useMemo(
    () => [...navData].sort((a, b) => a.snap_date.localeCompare(b.snap_date)),
    [navData],
  )

  function periodChange(days: number): { change: number; pct: number; pending: boolean } {
    const target = daysAgoDate(days)
    // Only use market-value snapshots — comparing live market value against cost-basis
    // snapshots produces a number that conflates appreciation with period change.
    const marketSnaps = sortedSnaps.filter(s => s.source === 'market')
    const snap = findSnapBefore(marketSnaps, target)
    if (!snap || snap.value === 0) return { change: 0, pct: 0, pending: true }
    const change = currentValue - snap.value
    return { change, pct: (change / snap.value) * 100, pending: false }
  }

  // "Today" comes straight from live per-holding daily change (Finnhub `dp` field).
  // Much more accurate than diffing against a cost-basis nav_snapshot from the backfill.
  const todayDollar = holdingsData.reduce(
    (s, h) => s + (h.change ?? 0) * h.qty * (h.multiplier ?? 1), 0,
  )
  const todayBaseline = currentValue - todayDollar
  const todayChange = {
    change: todayDollar,
    pct: todayBaseline > 0 ? (todayDollar / todayBaseline) * 100 : 0,
    pending: false,
  }

  const weekChange    = periodChange(7)
  const monthChange   = periodChange(30)
  const yearChange    = periodChange(365)
  const allTimeChange = {
    change: currentValue - costBasis,
    pct: costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0,
    pending: false,
  }

  const selectedPeriodChange = range === 'ALL' ? allTimeChange : periodChange(RANGE_DAYS[range])
  const chartColor = selectedPeriodChange.change >= 0 ? '#10B981' : '#EF4444'

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">

      {/* ── Account filter pills ──────────────────────────── */}
      {accountsList.length > 1 && (
        <div className="flex gap-1.5 flex-wrap">
          <AccountFilterPill
            active={selectedAccountId == null}
            onClick={() => setSelectedAccountId(null)}
            label="All Accounts"
          />
          {accountsList.map(a => (
            <AccountFilterPill
              key={a.id}
              active={selectedAccountId === a.id}
              onClick={() => setSelectedAccountId(a.id)}
              label={a.name}
              color={a.color}
            />
          ))}
        </div>
      )}

      {/* ── Hero card ──────────────────────────────────────── */}
      <div className="bg-surface rounded-lg border border-border px-4 sm:px-6 pt-4 sm:pt-5 pb-4 sm:pb-5">

        {/* Top: title + range selector — stack on mobile */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
          <div>
            <p className="text-micro text-text-3 uppercase tracking-widest mb-1">Total Net Worth</p>
            <p className="tabular font-semibold text-[32px] sm:text-[40px] leading-none tracking-tight text-text private-val">
              {fmt(currentValue)}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
              <div className="flex items-center gap-1.5">
                <span className={cn('tabular text-small font-medium private-val', todayChange.change >= 0 ? 'text-up' : 'text-down')}>
                  {todayChange.change >= 0 ? '+' : ''}{fmt(todayChange.change)}
                </span>
                <span className={cn('text-[11px]', todayChange.change >= 0 ? 'text-up' : 'text-down')}>
                  {todayChange.change >= 0 ? '+' : ''}{todayChange.pct.toFixed(2)}%
                </span>
                <span className="text-[11px] text-text-3">Today</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={cn('tabular text-small font-medium private-val', allTimeChange.change >= 0 ? 'text-up' : 'text-down')}>
                  {allTimeChange.change >= 0 ? '+' : ''}{fmt(allTimeChange.change)}
                </span>
                <span className={cn('text-[11px]', allTimeChange.change >= 0 ? 'text-up' : 'text-down')}>
                  ({allTimeChange.change >= 0 ? '+' : ''}{allTimeChange.pct.toFixed(2)}%)
                </span>
                <span className="text-[11px] text-text-3">All time</span>
              </div>
              {locked > 0 && (
                <div className="flex items-center gap-1.5" title="Cash held by your broker as collateral on open short puts">
                  <span className="tabular text-small font-medium text-warn private-val">
                    {fmt(locked)}
                  </span>
                  <span className="text-[11px] text-text-3">locked</span>
                </div>
              )}
            </div>
          </div>

          {/* Range tabs — full width on mobile */}
          <div className="flex items-center gap-0.5 bg-surface-2 rounded-md p-0.5 self-start sm:self-auto overflow-x-auto">
            {(['1D', '1W', '1M', '3M', '1Y', 'ALL'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  'px-2.5 py-1 rounded text-[11.5px] font-medium transition-colors',
                  range === r ? 'bg-surface text-text shadow-sm' : 'text-text-3 hover:text-text',
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Chart */}
        <NavChart
          navData={sortedSnaps}
          currentValue={currentValue}
          range={range}
          color={chartColor}
        />

        {/* Period stats — 2-col on mobile, 4-col from sm up */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mt-5 pt-4 border-t border-border">
          <PeriodStat label="Today" {...todayChange} />
          <PeriodStat label="Week"  {...weekChange} />
          <PeriodStat label="Month" {...monthChange} />
          <PeriodStat label="Year"  {...yearChange} />
        </div>
      </div>

      {/* ── Bottom row ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Allocation */}
        <div className="bg-surface rounded-lg border border-border px-4 sm:px-6 py-4 sm:py-5">
          <AllocationDonut holdings={holdingsData} />
        </div>

        {/* Accounts */}
        <div className="bg-surface rounded-lg border border-border px-4 sm:px-6 py-4 sm:py-5">
          <AccountsHeader />
          <AccountsSummary accounts={accountsList} holdings={holdingsData} />
        </div>
      </div>

      {/* ── Top movers (below allocation & accounts) ───────── */}
      <TopMovers holdings={holdingsData} onPick={(id) => navigate(`/holdings/${encodeURIComponent(id)}`)} />
    </div>
  )
}

function AccountFilterPill({
  active, onClick, label, color,
}: {
  active: boolean
  onClick: () => void
  label: string
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-accent-soft text-accent'
          : 'bg-surface border border-border text-text-2 hover:text-text hover:border-border-strong'
      )}
    >
      {color && (
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
      )}
      {label}
    </button>
  )
}

function AccountsHeader() {
  const navigate = useNavigate()
  return (
    <div className="flex items-center justify-between mb-3">
      <p className="text-small font-semibold text-text">Accounts</p>
      <button
        onClick={() => navigate('/accounts')}
        className="flex items-center gap-0.5 text-[11px] text-accent hover:underline"
      >
        View all <ChevronRight size={12} />
      </button>
    </div>
  )
}

// ── Top movers ────────────────────────────────────────────────

function TopMovers({ holdings, onPick }: { holdings: Holding[]; onPick: (id: string) => void }) {
  // Only positions with a live daily-change quote — skip cash, options without marks, etc.
  const movable = useMemo(() => holdings
    .filter(h => h.changePct != null && h.kind !== 'cash')
    .map(h => {
      const mult = h.multiplier ?? 1
      const todayDollar = (h.change ?? 0) * h.qty * mult
      return { ...h, todayDollar, todayPct: h.changePct as number }
    }),
    [holdings])

  if (movable.length === 0) {
    return (
      <div className="bg-surface rounded-lg border border-border px-4 sm:px-6 py-4 sm:py-5">
        <p className="text-small font-semibold text-text mb-2">Top Movers</p>
        <p className="text-[12px] text-text-3">
          Daily price changes will appear here after the next live quote refresh.
        </p>
      </div>
    )
  }

  const gainers = [...movable].filter(m => m.todayPct > 0).sort((a, b) => b.todayPct - a.todayPct).slice(0, 5)
  const losers  = [...movable].filter(m => m.todayPct < 0).sort((a, b) => a.todayPct - b.todayPct).slice(0, 5)

  return (
    <div className="bg-surface rounded-lg border border-border px-4 sm:px-6 py-4 sm:py-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-small font-semibold text-text">Top Movers</p>
        <p className="text-[11px] text-text-3">Today's price change</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <MoverColumn title="Gainers" icon={<TrendingUp size={13} className="text-up" />} list={gainers} onPick={onPick} />
        <MoverColumn title="Losers"  icon={<TrendingDown size={13} className="text-down" />} list={losers}  onPick={onPick} />
      </div>
    </div>
  )
}

function MoverColumn({ title, icon, list, onPick }: {
  title: string
  icon: React.ReactNode
  list: (Holding & { todayDollar: number; todayPct: number })[]
  onPick: (id: string) => void
}) {
  const { fmt } = useMoney()
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-[11px] text-text-3 uppercase tracking-wider">
        {icon} {title}
      </div>
      {list.length === 0 ? (
        <p className="text-[12px] text-text-3 py-1">None today</p>
      ) : list.map(h => (
        <button
          key={h.id}
          onClick={() => onPick(h.id)}
          className="w-full flex items-center gap-2.5 py-1.5 px-1 rounded-sm hover:bg-surface-2 transition-colors text-left"
        >
          <Glyph symbol={h.symbol} kind={h.kind} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="text-small font-medium text-text truncate">{h.symbol}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className={cn('tabular text-small font-semibold', h.todayPct >= 0 ? 'text-up' : 'text-down')}>
              {h.todayPct >= 0 ? '+' : ''}{h.todayPct.toFixed(2)}%
            </p>
            <p className={cn('tabular text-[11px] private-val', h.todayPct >= 0 ? 'text-up' : 'text-down')}>
              {h.todayDollar >= 0 ? '+' : ''}{fmt(h.todayDollar)}
            </p>
          </div>
        </button>
      ))}
    </div>
  )
}
