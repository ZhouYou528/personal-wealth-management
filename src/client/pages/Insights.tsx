import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, TrendingDown, DollarSign, CalendarClock, Wallet, PiggyBank } from 'lucide-react'
import { transactions as txApi, accounts as accountsApi } from '@/lib/api'
import { useMoney } from '@/lib/money'
import { fmtDate, todayISO, cn } from '@/lib/utils'
import {
  computeRealized,
  computeOptionsPremium,
  computeDividendIncome,
  computeContributions,
  sumRealizedInRange,
} from '@shared/insights'

export function Insights() {
  const { fmt } = useMoney()
  const today = todayISO()
  const currentYear = today.slice(0, 4)
  const yearStart = `${currentYear}-01-01`
  const yearEnd   = `${currentYear}-12-31`

  // Pull all transactions in one shot; insights compute client-side.
  const { data: txs = [], isLoading } = useQuery({
    queryKey: ['transactions', 'insights'],
    queryFn: () => txApi.list({ limit: 10000 }),
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  // Memoize the expensive realizations walk
  const realizations = useMemo(() => computeRealized(txs), [txs])
  const premium      = useMemo(() => computeOptionsPremium(txs, yearStart), [txs, yearStart])
  const dividends    = useMemo(() => computeDividendIncome(txs, today), [txs, today])
  const contribs     = useMemo(() => computeContributions(txs, yearStart, yearEnd), [txs, yearStart, yearEnd])

  const ytdRealized   = useMemo(() => sumRealizedInRange(realizations, yearStart, yearEnd), [realizations, yearStart, yearEnd])
  const allRealized   = useMemo(() => realizations.reduce((s, r) => s + r.realized, 0), [realizations])

  const topWinners = useMemo(() =>
    [...realizations].filter(r => r.sell_date >= yearStart).sort((a, b) => b.realized - a.realized).slice(0, 5),
    [realizations, yearStart]
  )
  const topLosers = useMemo(() =>
    [...realizations].filter(r => r.sell_date >= yearStart).sort((a, b) => a.realized - b.realized).slice(0, 5),
    [realizations, yearStart]
  )

  // Sorted symbol → income tables for the dividend section
  const ytdDivList = useMemo(() =>
    Object.entries(dividends.ytdBySymbol).sort(([, a], [, b]) => b - a),
    [dividends.ytdBySymbol]
  )
  const ttmDivList = useMemo(() =>
    Object.entries(dividends.ttmBySymbol).sort(([, a], [, b]) => b - a),
    [dividends.ttmBySymbol]
  )

  if (isLoading) {
    return <div className="p-8 text-text-3 text-small text-center">Loading…</div>
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="text-page-title text-text">Insights</h1>
        <p className="text-small text-text-3 mt-0.5">
          Realized gains, premium income, dividends & contributions for {currentYear}
        </p>
      </div>

      {/* ── Top stat row ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<DollarSign size={14} />}
          label={`Realized P&L ${currentYear}`}
          value={fmt(ytdRealized)}
          tone={ytdRealized >= 0 ? 'up' : 'down'}
          sub={`All-time: ${fmt(allRealized)}`}
        />
        <StatCard
          icon={<TrendingUp size={14} />}
          label={`Options premium ${currentYear}`}
          value={fmt(premium.ytdNet)}
          tone={premium.ytdNet >= 0 ? 'up' : 'down'}
          sub={`Received ${fmt(premium.ytdReceived)} − Paid ${fmt(premium.ytdPaid)}`}
        />
        <StatCard
          icon={<CalendarClock size={14} />}
          label={`Dividends ${currentYear}`}
          value={fmt(dividends.ytdTotal)}
          tone="up"
          sub={`Trailing 12mo: ${fmt(dividends.ttmTotal)}`}
        />
        <StatCard
          icon={<PiggyBank size={14} />}
          label={`Contributions ${currentYear}`}
          value={fmt(contribs.total)}
          tone="up"
          sub={`${Object.keys(contribs.byAccount).length} account${Object.keys(contribs.byAccount).length === 1 ? '' : 's'}`}
        />
      </div>

      {/* ── Realized gains detail ────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-md p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-section-h2 text-text">Realized gains — {currentYear}</h2>
          <p className="text-[11px] text-text-3 tabular">
            {topWinners.length + topLosers.length} closed lot{topWinners.length + topLosers.length === 1 ? '' : 's'}
          </p>
        </div>
        {realizations.length === 0 ? (
          <p className="text-small text-text-3 py-4">No closed positions yet this year.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <RealizationList title="Top gainers" icon={<TrendingUp size={13} className="text-up" />}
              list={topWinners} accMap={accMap} fmt={fmt} />
            <RealizationList title="Top losers"  icon={<TrendingDown size={13} className="text-down" />}
              list={topLosers}  accMap={accMap} fmt={fmt} />
          </div>
        )}
      </div>

      {/* ── Dividend income ─────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-md p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-section-h2 text-text">Dividend income</h2>
          <p className="text-[11px] text-text-3 tabular">
            Forward estimate: <span className="font-semibold text-text">{fmt(dividends.ttmTotal)}</span>/yr
          </p>
        </div>
        {ytdDivList.length === 0 ? (
          <p className="text-small text-text-3 py-4">No dividends received yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-micro text-text-3 uppercase tracking-wider mb-2">YTD by symbol</p>
              <DividendTable list={ytdDivList} fmt={fmt} />
            </div>
            <div>
              <p className="text-micro text-text-3 uppercase tracking-wider mb-2">Trailing 12 months</p>
              <DividendTable list={ttmDivList} fmt={fmt} />
            </div>
          </div>
        )}
      </div>

      {/* ── Contributions ───────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-md p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-section-h2 text-text">Contributions — {currentYear}</h2>
          <p className="text-[11px] text-text-3 tabular">{fmt(contribs.total)} total</p>
        </div>
        {Object.keys(contribs.byAccount).length === 0 ? (
          <p className="text-small text-text-3 py-4">No deposits this year yet.</p>
        ) : (
          <div className="space-y-1.5">
            {Object.entries(contribs.byAccount)
              .sort(([, a], [, b]) => b - a)
              .map(([id, amount]) => {
                const acc = accMap[id]
                return (
                  <div key={id} className="flex items-center gap-3 py-2 px-1 rounded-sm hover:bg-surface-2">
                    {acc && (
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: acc.color }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-small font-medium text-text">{acc?.institution ?? id}</p>
                      <p className="text-[11px] text-text-3">{acc?.type ?? ''}</p>
                    </div>
                    <span className="tabular text-small font-semibold text-text private-val">{fmt(amount)}</span>
                  </div>
                )
              })}
          </div>
        )}
        <p className="text-[11px] text-text-3 mt-3">
          Only counts deposit transactions. Share transfers (ACAT/transfer_in) are excluded since
          they're moved-in assets, not new contributions.
        </p>
      </div>

      {/* ── Options detail ───────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-md p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-section-h2 text-text">Options premium — {currentYear}</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <Mini label="Premium received" value={fmt(premium.ytdReceived)} tone="up" />
          <Mini label="Premium paid"     value={fmt(premium.ytdPaid)} tone="down" />
          <Mini label="Net (YTD)"        value={fmt(premium.ytdNet)} tone={premium.ytdNet >= 0 ? 'up' : 'down'} />
          <Mini label="Net (all-time)"   value={fmt(premium.netPremium)} tone={premium.netPremium >= 0 ? 'up' : 'down'} />
        </div>
        <p className="text-[11px] text-text-3 mt-4">
          Net = sell_option totals − buy_option totals. Open short positions count their full
          premium received until you close or the option expires worthless.
        </p>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function StatCard({ icon, label, value, tone, sub }: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'up' | 'down' | 'neutral'
  sub?: string
}) {
  return (
    <div className="bg-surface border border-border rounded-md p-4">
      <div className="flex items-center gap-1.5 text-text-3 text-[11px] uppercase tracking-wider mb-2">
        <Wallet size={12} className="opacity-0" />{/* spacer for alignment, replaced by icon */}
        <div className="-ml-[18px] flex items-center gap-1.5">
          {icon}<span>{label}</span>
        </div>
      </div>
      <p className={cn(
        'tabular text-[20px] sm:text-[22px] font-semibold private-val',
        tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text'
      )}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-text-3 mt-0.5 private-val">{sub}</p>}
    </div>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' }) {
  return (
    <div>
      <p className="text-micro text-text-3 uppercase tracking-wider mb-1">{label}</p>
      <p className={cn('tabular text-[18px] font-semibold private-val', tone === 'up' ? 'text-up' : 'text-down')}>
        {value}
      </p>
    </div>
  )
}

function RealizationList({ title, icon, list, accMap, fmt }: {
  title: string
  icon: React.ReactNode
  list: Array<{
    symbol: string
    account_id: string
    sell_date: string
    qty: number
    realized: number
    is_option: boolean
    option_label?: string
  }>
  accMap: Record<string, { institution: string; color: string }>
  fmt: (v: number) => string
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-text-3 text-[11px] uppercase tracking-wider mb-2">
        {icon} {title}
      </div>
      {list.length === 0 ? (
        <p className="text-[12px] text-text-3 py-2">None</p>
      ) : list.map((r, i) => (
        <div key={i} className="flex items-center gap-2.5 py-2 px-1 border-b border-border last:border-0">
          <div className="flex-1 min-w-0">
            <p className="text-small font-medium text-text truncate">
              {r.option_label ?? r.symbol}
              <span className="ml-1 text-[11px] text-text-3">×{r.qty}</span>
            </p>
            <p className="text-[11px] text-text-3">
              {accMap[r.account_id]?.institution ?? '—'} · {fmtDate(r.sell_date)}
            </p>
          </div>
          <span className={cn(
            'tabular text-small font-semibold private-val',
            r.realized >= 0 ? 'text-up' : 'text-down'
          )}>
            {r.realized >= 0 ? '+' : ''}{fmt(r.realized)}
          </span>
        </div>
      ))}
    </div>
  )
}

function DividendTable({ list, fmt }: { list: [string, number][]; fmt: (v: number) => string }) {
  if (list.length === 0) return <p className="text-[12px] text-text-3 py-2">None</p>
  const total = list.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="space-y-1">
      {list.slice(0, 8).map(([sym, amount]) => (
        <div key={sym} className="flex items-center gap-2 py-1 border-b border-border last:border-0">
          <span className="text-small font-medium text-text flex-1 min-w-0 truncate">{sym}</span>
          <span className="tabular text-small text-text private-val">{fmt(amount)}</span>
        </div>
      ))}
      {list.length > 8 && (
        <p className="text-[11px] text-text-3 pt-1">+{list.length - 8} more</p>
      )}
      <div className="flex items-center gap-2 pt-2 mt-1 border-t border-border">
        <span className="text-[11px] text-text-3 uppercase tracking-wider flex-1">Total</span>
        <span className="tabular text-small font-semibold text-text private-val">{fmt(total)}</span>
      </div>
    </div>
  )
}
