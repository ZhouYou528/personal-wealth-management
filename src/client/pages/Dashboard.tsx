import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, TrendingUp, TrendingDown } from 'lucide-react'
import { Glyph } from '@/components/Glyph'
import { holdings as holdingsApi, nav, accounts as accountsApi, admin, sentiment as sentimentApi } from '@/lib/api'
import { STALE } from '@/lib/cache'
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

function fmtSnapLabel(snap_date: string): string {
  if (snap_date.includes('T')) {
    // Intraday: "2026-05-27T14" → "May 27, 14:00 UTC"
    const hour = snap_date.slice(11).padStart(2, '0')
    const d = new Date(`${snap_date.slice(0, 10)}T${hour}:00:00Z`)
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ` ${hour}:00 UTC`
  }
  return fmtDate(snap_date)
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  const { fmt } = useMoney()
  if (!active || !payload?.length || !label) return null
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 shadow-lg text-small pointer-events-none">
      <p className="text-text-3 text-[11px] mb-0.5">{fmtSnapLabel(label)}</p>
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
    if (range === '1D') {
      // Anchor: most recent daily (non-intraday) snapshot before today → yesterday's close
      const anchor = [...navData]
        .filter(s => !s.snap_date.includes('T') && s.snap_date < today)
        .sort((a, b) => a.snap_date.localeCompare(b.snap_date))
        .at(-1)

      // Collect real intraday snapshots for today into an hour → value map
      const snapByHour = new Map<number, number>()
      for (const s of navData) {
        if (s.snap_date.startsWith(today) && s.snap_date.includes('T')) {
          snapByHour.set(parseInt(s.snap_date.slice(11), 10), s.value)
        }
      }
      // Pin current hour to the live holdings value
      const currentHour = new Date().getUTCHours()
      snapByHour.set(currentHour, currentValue)
      const sortedHours = [...snapByHour.keys()].sort((a, b) => a - b)

      // Interpolate to fill every hour 0..currentHour
      const intradayPts: { date: string; value: number }[] = []
      for (let h = 0; h <= currentHour; h++) {
        const dateKey = `${today}T${String(h).padStart(2, '0')}`
        if (snapByHour.has(h)) {
          intradayPts.push({ date: dateKey, value: snapByHour.get(h)! })
        } else {
          const before = sortedHours.filter(sh => sh < h).at(-1)
          const after  = sortedHours.find(sh => sh > h)
          let value: number
          if (before === undefined) {
            // Before first real data → flat at anchor close or first snapshot
            value = anchor?.value ?? snapByHour.get(sortedHours[0])!
          } else if (after === undefined) {
            value = snapByHour.get(before)!
          } else {
            const t = (h - before) / (after - before)
            value = snapByHour.get(before)! + t * (snapByHour.get(after)! - snapByHour.get(before)!)
          }
          intradayPts.push({ date: dateKey, value })
        }
      }

      return anchor
        ? [{ date: anchor.snap_date, value: anchor.value }, ...intradayPts]
        : intradayPts
    }

    // Non-1D ranges: one point per day, no intraday T-points
    const since = daysAgoDate(RANGE_DAYS[range])
    const pts = navData
      .filter(s => {
        if (s.snap_date < since) return false
        if (s.snap_date.includes('T')) return false
        return true
      })
      .map(s => ({ date: s.snap_date, value: s.value }))

    if (pts.length > 0 && pts[pts.length - 1].date === today) {
      pts[pts.length - 1].value = currentValue
    } else {
      pts.push({ date: today, value: currentValue })
    }
    return pts
  }, [navData, currentValue, range, today])

  // If there's only one snapshot (no history yet), add a flat anchor so the chart renders
  if (chartData.length === 1) {
    chartData.unshift({ date: daysAgoDate(1), value: chartData[0].value })
  }
  if (chartData.length < 2) {
    return (
      <div className="h-[180px] flex items-center justify-center text-text-3 text-small">
        No portfolio history yet — data appears after the next market-hours snapshot
      </div>
    )
  }

  const tickFmt = (v: string) => {
    if (range === '1D') {
      if (v.includes('T')) return v.slice(11).padStart(2, '0') + ':00'  // "14:00"
      return v.slice(5).replace('-', '/')
    }
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
              <stop offset="0%"  stopColor={color} stopOpacity={0.28} />
              <stop offset="65%" stopColor={color} stopOpacity={0.06} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
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
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: 'var(--color-border-strong, #d1d5db)', strokeWidth: 1, strokeDasharray: '4 3' }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 5, fill: color, strokeWidth: 2, stroke: 'var(--color-surface)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Period stat cell ──────────────────────────────────────────

const RANGE_LABEL: Record<string, string> = {
  '1D': 'Today', '1W': 'Past week', '1M': 'Past month',
  '3M': 'Past 3 months', '1Y': 'Past year', 'ALL': 'All time',
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
        label: h.symbol === 'CASH' ? 'Cash' : (h.kind === 'option' ? `${h.symbol}*` : h.qty < 0 ? `${h.symbol} (short)` : h.symbol),
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
        <p className="text-[16px] sm:text-small font-bold sm:font-semibold text-text">Allocation</p>
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
        <div className="relative flex-shrink-0" style={{ width: 200, height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                cx="50%"
                cy="50%"
                innerRadius={62}
                outerRadius={90}
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
            <p className="text-[10px] text-text-3 uppercase tracking-widest">TOTAL</p>
            <p className="text-[15px] font-bold text-text private-val tabular">{fmtCompact(total)}</p>
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
  const qc = useQueryClient()
  const [range, setRange] = useState<Range>('1M')

  const { data: holdingsData = [] } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => holdingsApi.list(selectedAccountId ?? undefined),
  })

  const { data: navData = [] } = useQuery({
    queryKey: ['nav', selectedAccountId, 'full'],
    queryFn: () => nav.history(1825, selectedAccountId ?? undefined),
    staleTime: STALE.history,
  })

  const { data: accountsList = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
    staleTime: STALE.static,
  })

  // If there are holdings but no nav history, trigger a snapshot so the chart populates
  useEffect(() => {
    if (holdingsData.length > 0 && navData.length === 0) {
      admin.runSnapshot()
        .then(() => qc.invalidateQueries({ queryKey: ['nav'] }))
        .catch(() => {})
    }
  }, [holdingsData.length > 0, navData.length === 0]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const allTimeChange = {
    change: currentValue - costBasis,
    pct: costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0,
    pending: false,
  }

  const selectedPeriodChange = range === 'ALL' ? allTimeChange : periodChange(RANGE_DAYS[range])
  const chartColor = selectedPeriodChange.change >= 0 ? '#10B981' : '#EF4444'

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">

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
      <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush px-4 sm:px-6 pt-4 sm:pt-5 pb-4 sm:pb-5">

        {/* Top: title + range selector — stack on mobile */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
          <div>
            <p className="text-micro text-text-3 uppercase tracking-widest mb-1">Total Net Worth</p>
            <p className="tabular font-bold text-[38px] sm:text-[54px] leading-none tracking-tight text-text private-val">
              {fmt(currentValue)}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
              {(() => {
                const d = range === '1D' ? todayChange : selectedPeriodChange
                const up = d.change >= 0
                if (d.pending) return (
                  <span className="text-[11px] text-text-3">{RANGE_LABEL[range]}: —</span>
                )
                return (
                  <div className="flex items-center gap-1.5">
                    <span className={cn('tabular text-small font-medium private-val', up ? 'text-up' : 'text-down')}>
                      {up ? '+' : ''}{fmt(d.change)}
                    </span>
                    <span className={cn('text-[11px]', up ? 'text-up' : 'text-down')}>
                      ({up ? '+' : ''}{d.pct.toFixed(2)}%)
                    </span>
                    <span className="text-[11px] text-text-3">{RANGE_LABEL[range]}</span>
                  </div>
                )
              })()}
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
          <div className="flex items-center gap-0.5 bg-surface-2 rounded-full p-0.5 self-start sm:self-auto overflow-x-auto">
            {(['1D', '1W', '1M', '3M', '1Y', 'ALL'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  'px-3 py-1 rounded-full text-[11.5px] font-medium transition-all duration-150',
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

      </div>

      {/* ── Market sentiment (VIX + Fear & Greed) ─────────── */}
      <MarketSentimentRow />

      {/* ── Bottom row ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Allocation */}
        <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush px-4 sm:px-6 py-4 sm:py-5">
          <AllocationDonut holdings={holdingsData} />
        </div>

        {/* Accounts */}
        <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush px-4 sm:px-6 py-4 sm:py-5">
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
        'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-all duration-150',
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
      <p className="text-[16px] sm:text-small font-bold sm:font-semibold text-text">Accounts</p>
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
      <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush px-4 sm:px-6 py-4 sm:py-5">
        <p className="text-[16px] sm:text-small font-bold sm:font-semibold text-text mb-2">Top Movers</p>
        <p className="text-[12px] text-text-3">
          Daily price changes will appear here after the next live quote refresh.
        </p>
      </div>
    )
  }

  const gainers = [...movable].filter(m => m.todayPct > 0).sort((a, b) => b.todayPct - a.todayPct).slice(0, 5)
  const losers  = [...movable].filter(m => m.todayPct < 0).sort((a, b) => a.todayPct - b.todayPct).slice(0, 5)

  return (
    <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush px-4 sm:px-6 py-4 sm:py-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[16px] sm:text-small font-bold sm:font-semibold text-text">Top Movers</p>
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
            <p className="text-small font-medium text-text truncate">
              {h.symbol}{h.kind === 'option' && <sup className="text-accent text-[9px] ml-0.5">*</sup>}
            </p>
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

// ── Market Sentiment row ──────────────────────────────────────────
// Two stat cards: VIX (volatility, lower is calmer) and CNN Fear & Greed
// Index (0-100, higher is greedier). Cached 15 min server-side.

const VIX_TONE = (v: number): 'up' | 'neutral' | 'warn' | 'down' => {
  if (v < 15) return 'up'
  if (v < 20) return 'neutral'
  if (v < 30) return 'warn'
  return 'down'
}

// F&G: greed isn't "bad," it just describes the market. Color reflects the
// emotional zone (red = fear, green = greed), not investment advice.
const FG_TONE = (v: number): 'down' | 'warn' | 'neutral' | 'up' => {
  if (v < 25) return 'down'
  if (v < 45) return 'warn'
  if (v < 55) return 'neutral'
  return 'up'
}

const TONE_TEXT: Record<string, string> = {
  up:      'text-up',
  warn:    'text-warn',
  down:    'text-down',
  neutral: 'text-text-2',
}
const TONE_CHIP: Record<string, string> = {
  up:      'bg-up/12 text-up',
  warn:    'bg-warn/15 text-warn',
  down:    'bg-down/15 text-down',
  neutral: 'bg-surface-2 text-text-2',
}

function MarketSentimentRow() {
  const { data, isLoading } = useQuery({
    queryKey: ['sentiment'],
    queryFn: sentimentApi.get,
    staleTime: 5 * 60_000,         // re-poll at most every 5 min on this client
    refetchInterval: 15 * 60_000,  // background refresh every 15 min
    refetchOnWindowFocus: false,
  })

  return (
    <div className="grid grid-cols-2 gap-3">
      <SentimentCard
        title="VIX"
        sub="Volatility Index"
        loading={isLoading}
        metric={data?.vix}
        tone={data?.vix ? VIX_TONE(data.vix.value) : 'neutral'}
        precision={2}
        deltaSuffix="today"
      />
      <SentimentCard
        title="Fear & Greed"
        sub="CNN Index · 0–100"
        loading={isLoading}
        metric={data?.fearGreed}
        tone={data?.fearGreed ? FG_TONE(data.fearGreed.value) : 'neutral'}
        precision={0}
        deltaSuffix="vs prev close"
      />
    </div>
  )
}

function SentimentCard({ title, sub, loading, metric, tone, precision, deltaSuffix }: {
  title: string
  sub: string
  loading: boolean
  metric: { value: number; change: number; label: string } | null | undefined
  tone: 'up' | 'down' | 'warn' | 'neutral'
  precision: number
  deltaSuffix: string
}) {
  return (
    <div className="sm:bg-surface sm:rounded-2xl sm:shadow-md sm:dark:shadow-none sm:border sm:border-transparent sm:dark:border-border px-0 sm:px-5 py-0 sm:py-4 min-w-0">
      <div className="flex items-baseline justify-between mb-1 min-w-0">
        <p className="text-micro text-text-3 uppercase tracking-widest">{title}</p>
        <p className="text-[10px] text-text-3 truncate ml-2 min-w-0">{sub}</p>
      </div>

      {loading ? (
        <div className="h-[44px] sm:h-[52px] bg-surface-2 rounded animate-pulse" />
      ) : metric == null ? (
        <p className="text-small text-text-3 mt-2">Unavailable</p>
      ) : (
        <>
          <p className={cn(
            'tabular font-bold text-[30px] sm:text-[36px] leading-none tracking-tight mt-0.5',
            TONE_TEXT[tone]
          )}>
            {metric.value.toFixed(precision)}
          </p>
          <div className="flex items-center justify-between mt-2">
            <span className={cn(
              'inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold',
              TONE_CHIP[tone]
            )}>
              {metric.label}
            </span>
            {Math.abs(metric.change) >= 0.01 && (
              <span className="flex items-center gap-0.5 text-[11px] text-text-3">
                {metric.change >= 0
                  ? <TrendingUp size={11} className="text-up" />
                  : <TrendingDown size={11} className="text-down" />}
                <span className={cn('tabular', metric.change >= 0 ? 'text-up' : 'text-down')}>
                  {metric.change >= 0 ? '+' : ''}{metric.change.toFixed(precision)}
                </span>
                <span>{deltaSuffix}</span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
