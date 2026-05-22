// Pure calculation functions for the Insights page.
// Lives in `shared` so worker + client can both import; vitest covers the math.

import type { Transaction, TxType, AssetKind, AllocationTargets, Holding } from './types'

// ── Realized P&L (FIFO lot matching) ─────────────────────────────────────────

interface OpenLot {
  date: string
  qty: number
  price: number
  multiplier: number
}

export interface RealizedLot {
  symbol: string
  account_id: string
  buy_date: string
  sell_date: string
  qty: number
  buy_price: number
  sell_price: number
  realized: number               // total $ realized for this matched chunk
  multiplier: number             // 100 for options, 1 otherwise
  is_option: boolean
  option_label?: string          // e.g. "AAPL 150P 3/15/26"
}

const OPTION_TYPES: TxType[] = ['buy_option', 'sell_option']
const BUY_LIKE:    TxType[] = ['buy', 'buy_crypto', 'transfer_in', 'buy_option']
const SELL_LIKE:   TxType[] = ['sell', 'sell_crypto', 'sell_option', 'transfer_out']

/**
 * FIFO-match sells against buys to compute realized P&L per closed chunk.
 * Each option contract is bucketed by symbol+strike+expiry+type so different
 * contracts on the same underlying don't cross-match. Shorts (sell-to-open) are
 * not realized here — those are surfaced in `computeOptionsPremium` instead.
 */
export function computeRealized(transactions: Transaction[]): RealizedLot[] {
  const queues = new Map<string, OpenLot[]>()
  const realizations: RealizedLot[] = []
  const sorted = [...transactions].sort((a, b) =>
    a.tx_date.localeCompare(b.tx_date) || (a.created_at ?? '').localeCompare(b.created_at ?? '')
  )

  for (const tx of sorted) {
    if (!tx.symbol) continue
    const isOption = OPTION_TYPES.includes(tx.type)
    const mult = isOption ? 100 : 1

    const key = `${tx.account_id}:${tx.symbol}${isOption
      ? `:${tx.option_type ?? ''}:${tx.strike ?? ''}:${tx.expiry ?? ''}` : ''}`
    let queue = queues.get(key)
    if (!queue) { queue = []; queues.set(key, queue) }

    if (BUY_LIKE.includes(tx.type)) {
      const qty = tx.qty ?? 0
      if (qty > 0) queue.push({ date: tx.tx_date, qty, price: tx.price ?? 0, multiplier: mult })
    } else if (SELL_LIKE.includes(tx.type)) {
      let remaining = tx.qty ?? 0
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0]
        const matchQty = Math.min(remaining, lot.qty)
        if (tx.type !== 'transfer_out') {
          // transfer_out doesn't realize a gain (no money received)
          realizations.push({
            symbol: tx.symbol,
            account_id: tx.account_id,
            buy_date: lot.date,
            sell_date: tx.tx_date,
            qty: matchQty,
            buy_price: lot.price,
            sell_price: tx.price ?? 0,
            realized: matchQty * ((tx.price ?? 0) - lot.price) * lot.multiplier,
            multiplier: lot.multiplier,
            is_option: isOption,
            option_label: isOption
              ? `${tx.symbol} ${tx.option_type === 'put' ? 'P' : 'C'}${tx.strike ?? ''}`
              : undefined,
          })
        }
        lot.qty -= matchQty
        remaining -= matchQty
        if (lot.qty <= 1e-9) queue.shift()
      }
    } else if (tx.type === 'split') {
      if (tx.qty && tx.price && tx.price > 0) {
        const ratio = tx.qty / tx.price
        for (const lot of queue) {
          lot.qty *= ratio
          lot.price /= ratio
        }
      }
    }
  }
  return realizations
}

export function sumRealizedInRange(
  realizations: RealizedLot[],
  fromISO: string,
  toISO: string,
): number {
  return realizations
    .filter(r => r.sell_date >= fromISO && r.sell_date <= toISO)
    .reduce((s, r) => s + r.realized, 0)
}

// ── Options premium income (closed CSPs etc.) ───────────────────────────────

export interface PremiumStats {
  netPremium: number             // sells − buys, all time
  ytdNet: number
  premiumReceived: number        // sum of sell_option totals (all time)
  premiumPaid: number            // sum of buy_option totals (all time)
  ytdReceived: number
  ytdPaid: number
}

export function computeOptionsPremium(
  transactions: Transaction[],
  yearStart: string,
): PremiumStats {
  let received = 0, paid = 0, ytdReceived = 0, ytdPaid = 0
  for (const tx of transactions) {
    if (tx.type === 'sell_option') {
      received += tx.total
      if (tx.tx_date >= yearStart) ytdReceived += tx.total
    } else if (tx.type === 'buy_option') {
      paid += tx.total
      if (tx.tx_date >= yearStart) ytdPaid += tx.total
    }
  }
  return {
    netPremium:        received - paid,
    ytdNet:            ytdReceived - ytdPaid,
    premiumReceived:   received,
    premiumPaid:       paid,
    ytdReceived,
    ytdPaid,
  }
}

// ── Dividend income (YTD + trailing-12-month forecast) ──────────────────────

export interface DividendStats {
  ytdTotal: number
  ttmTotal: number               // trailing 12 months = forward-looking estimate
  ytdBySymbol: Record<string, number>
  ttmBySymbol: Record<string, number>
}

export function computeDividendIncome(
  transactions: Transaction[],
  todayISO: string,
): DividendStats {
  const yearStart = todayISO.slice(0, 4) + '-01-01'
  // ttmCutoff = today - 365 days, as a date string
  const today = new Date(`${todayISO}T00:00:00Z`)
  const ttm = new Date(today.getTime() - 365 * 86400000)
  const ttmCutoff = ttm.toISOString().slice(0, 10)

  let ytdTotal = 0, ttmTotal = 0
  const ytdBySymbol: Record<string, number> = {}
  const ttmBySymbol: Record<string, number> = {}

  for (const tx of transactions) {
    if (tx.type !== 'dividend') continue
    const sym = tx.symbol ?? 'Unknown'
    if (tx.tx_date >= yearStart) {
      ytdTotal += tx.total
      ytdBySymbol[sym] = (ytdBySymbol[sym] ?? 0) + tx.total
    }
    if (tx.tx_date >= ttmCutoff) {
      ttmTotal += tx.total
      ttmBySymbol[sym] = (ttmBySymbol[sym] ?? 0) + tx.total
    }
  }
  return { ytdTotal, ttmTotal, ytdBySymbol, ttmBySymbol }
}

// ── Annual contributions per account ────────────────────────────────────────

export interface ContributionStats {
  byAccount: Record<string, number>     // account_id → $ contributed YTD
  total: number
}

/**
 * Counts only `deposit` transactions toward contributions. ACAT share
 * transfers don't count as new money (they're transferred from elsewhere).
 */
export function computeContributions(
  transactions: Transaction[],
  yearStart: string,
  yearEnd: string,
): ContributionStats {
  const byAccount: Record<string, number> = {}
  let total = 0
  for (const tx of transactions) {
    if (tx.type !== 'deposit') continue
    if (tx.tx_date < yearStart || tx.tx_date > yearEnd) continue
    byAccount[tx.account_id] = (byAccount[tx.account_id] ?? 0) + tx.total
    total += tx.total
  }
  return { byAccount, total }
}

// ── Target allocation & drift ───────────────────────────────────────────────

export interface AllocationDriftRow {
  kind: AssetKind
  current_pct: number         // 0–100
  target_pct: number          // 0–100
  drift_pct: number           // current − target (signed)
  current_value: number       // $
  target_value: number        // $
  delta_value: number         // current − target ($), positive = overweight
  out_of_range: boolean       // |drift_pct| > threshold
}

/**
 * Returns per-kind drift between current allocation and a target.
 * `holdings` should already be filtered to the plan's scope.
 * Uses gross exposure (|qty × px × mult|) so short positions count.
 */
export function computeAllocationDrift(
  holdings: Holding[],
  targets: AllocationTargets,
  driftThreshold: number,
): { rows: AllocationDriftRow[]; totalValue: number; sumAbsDrift: number } {
  const absVal = (h: Holding) => Math.abs(h.qty * h.px * (h.multiplier ?? 1))
  const totalValue = holdings.reduce((s, h) => s + absVal(h), 0)

  const currentByKind: Record<string, number> = {}
  for (const h of holdings) {
    currentByKind[h.kind] = (currentByKind[h.kind] ?? 0) + absVal(h)
  }

  // Union of kinds present in either targets or current holdings
  const allKinds = new Set<AssetKind>([
    ...(Object.keys(targets) as AssetKind[]),
    ...(Object.keys(currentByKind) as AssetKind[]),
  ])

  const rows: AllocationDriftRow[] = []
  for (const kind of allKinds) {
    const current_value = currentByKind[kind] ?? 0
    const current_pct   = totalValue > 0 ? (current_value / totalValue) * 100 : 0
    const target_pct    = targets[kind] ?? 0
    const target_value  = totalValue * (target_pct / 100)
    const drift_pct     = current_pct - target_pct
    rows.push({
      kind,
      current_pct,
      target_pct,
      drift_pct,
      current_value,
      target_value,
      delta_value: current_value - target_value,
      out_of_range: Math.abs(drift_pct) > driftThreshold,
    })
  }

  // Sort by absolute drift descending so the worst offenders are first
  rows.sort((a, b) => Math.abs(b.drift_pct) - Math.abs(a.drift_pct))
  const sumAbsDrift = rows.reduce((s, r) => s + Math.abs(r.drift_pct), 0)

  return { rows, totalValue, sumAbsDrift }
}
