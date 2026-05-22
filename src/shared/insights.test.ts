import { describe, it, expect } from 'vitest'
import {
  computeRealized,
  computeOptionsPremium,
  computeDividendIncome,
  computeContributions,
  sumRealizedInRange,
  computeAllocationDrift,
} from './insights'
import type { Transaction, TxType, Holding } from './types'

let counter = 0
function tx(partial: Partial<Transaction> & { type: TxType; tx_date: string }): Transaction {
  counter += 1
  return {
    id: `tx_${counter}`,
    account_id: 'acc_a',
    total: 0,
    created_at: `2026-01-01T00:00:${String(counter).padStart(2, '0')}Z`,
    ...partial,
  } as Transaction
}

// ── Realized P&L ──────────────────────────────────────────────────────────

describe('computeRealized — stocks', () => {
  it('FIFO-matches a single buy/sell', () => {
    const rs = computeRealized([
      tx({ type: 'buy',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      tx({ type: 'sell', tx_date: '2026-06-01', symbol: 'AAPL', qty: 10, price: 150, total: 1500 }),
    ])
    expect(rs).toHaveLength(1)
    expect(rs[0].realized).toBe(500)
    expect(rs[0].buy_price).toBe(100)
    expect(rs[0].sell_price).toBe(150)
  })

  it('partial sell leaves remaining lot open', () => {
    const rs = computeRealized([
      tx({ type: 'buy',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      tx({ type: 'sell', tx_date: '2026-06-01', symbol: 'AAPL', qty: 4,  price: 200, total: 800 }),
    ])
    expect(rs).toHaveLength(1)
    expect(rs[0].qty).toBe(4)
    expect(rs[0].realized).toBe(400)   // 4 × (200 − 100)
  })

  it('FIFO across multiple buy lots', () => {
    const rs = computeRealized([
      tx({ type: 'buy',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 5, price: 100, total: 500 }),
      tx({ type: 'buy',  tx_date: '2026-02-01', symbol: 'AAPL', qty: 5, price: 200, total: 1000 }),
      tx({ type: 'sell', tx_date: '2026-06-01', symbol: 'AAPL', qty: 7, price: 250, total: 1750 }),
    ])
    // First 5 close out earliest lot ($100 cost), next 2 from $200 lot
    expect(rs).toHaveLength(2)
    expect(rs[0].realized).toBe(5 * (250 - 100))   // 750
    expect(rs[1].realized).toBe(2 * (250 - 200))   // 100
  })

  it('transfer_in counts as a buy with its own cost basis', () => {
    const rs = computeRealized([
      tx({ type: 'transfer_in', tx_date: '2026-01-01', symbol: 'AAPL', qty: 10, price: 100 }),
      tx({ type: 'sell',        tx_date: '2026-06-01', symbol: 'AAPL', qty: 10, price: 150, total: 1500 }),
    ])
    expect(rs[0].realized).toBe(500)
  })

  it('transfer_out consumes a lot but creates no realization', () => {
    const rs = computeRealized([
      tx({ type: 'buy',          tx_date: '2026-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      tx({ type: 'transfer_out', tx_date: '2026-06-01', symbol: 'AAPL', qty: 4 }),
      tx({ type: 'sell',         tx_date: '2026-09-01', symbol: 'AAPL', qty: 6, price: 200, total: 1200 }),
    ])
    expect(rs).toHaveLength(1)
    expect(rs[0].qty).toBe(6)
    expect(rs[0].realized).toBe(600)
  })

  it('split adjusts open lot cost basis before sell', () => {
    const rs = computeRealized([
      tx({ type: 'buy',   tx_date: '2026-01-01', symbol: 'AAPL', qty: 10, price: 200, total: 2000 }),
      tx({ type: 'split', tx_date: '2026-03-01', symbol: 'AAPL', qty: 2, price: 1 }),  // 2:1
      tx({ type: 'sell',  tx_date: '2026-06-01', symbol: 'AAPL', qty: 20, price: 150, total: 3000 }),
    ])
    // After split: 20 shares @ $100 cost. Sell at $150 → $50 × 20 = $1000
    expect(rs[0].qty).toBe(20)
    expect(rs[0].realized).toBe(1000)
  })
})

describe('computeRealized — options', () => {
  it('option close uses multiplier=100', () => {
    const rs = computeRealized([
      tx({ type: 'buy_option',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 2, price: 5, total: 1000,
           option_type: 'call', strike: 150, expiry: '2026-03-15' }),
      tx({ type: 'sell_option', tx_date: '2026-02-01', symbol: 'AAPL', qty: 2, price: 8, total: 1600,
           option_type: 'call', strike: 150, expiry: '2026-03-15' }),
    ])
    expect(rs).toHaveLength(1)
    expect(rs[0].realized).toBe(2 * (8 - 5) * 100)   // 600
    expect(rs[0].is_option).toBe(true)
    expect(rs[0].multiplier).toBe(100)
  })

  it('different option contracts on same symbol stay independent', () => {
    const rs = computeRealized([
      tx({ type: 'buy_option',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500,
           option_type: 'call', strike: 150, expiry: '2026-03-15' }),
      tx({ type: 'buy_option',  tx_date: '2026-01-01', symbol: 'AAPL', qty: 1, price: 3, total: 300,
           option_type: 'put',  strike: 140, expiry: '2026-03-15' }),
      tx({ type: 'sell_option', tx_date: '2026-02-01', symbol: 'AAPL', qty: 1, price: 8, total: 800,
           option_type: 'call', strike: 150, expiry: '2026-03-15' }),
    ])
    expect(rs).toHaveLength(1)
    expect(rs[0].realized).toBe(300)   // 1 × (8−5) × 100
  })
})

describe('sumRealizedInRange', () => {
  it('filters by sell_date inclusive', () => {
    const rs = computeRealized([
      tx({ type: 'buy',  tx_date: '2025-12-01', symbol: 'A', qty: 1, price: 100, total: 100 }),
      tx({ type: 'sell', tx_date: '2025-12-31', symbol: 'A', qty: 1, price: 150, total: 150 }),
      tx({ type: 'buy',  tx_date: '2026-01-15', symbol: 'B', qty: 1, price: 100, total: 100 }),
      tx({ type: 'sell', tx_date: '2026-06-01', symbol: 'B', qty: 1, price: 200, total: 200 }),
    ])
    expect(sumRealizedInRange(rs, '2026-01-01', '2026-12-31')).toBe(100)
    expect(sumRealizedInRange(rs, '2025-01-01', '2025-12-31')).toBe(50)
  })
})

// ── Options premium ───────────────────────────────────────────────────────

describe('computeOptionsPremium', () => {
  it('sums all sell_option minus buy_option', () => {
    const stats = computeOptionsPremium([
      tx({ type: 'sell_option', tx_date: '2026-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500 }),
      tx({ type: 'sell_option', tx_date: '2026-02-01', symbol: 'TSLA', qty: 1, price: 8, total: 800 }),
      tx({ type: 'buy_option',  tx_date: '2026-02-15', symbol: 'AAPL', qty: 1, price: 2, total: 200 }),
    ], '2026-01-01')
    expect(stats.premiumReceived).toBe(1300)
    expect(stats.premiumPaid).toBe(200)
    expect(stats.netPremium).toBe(1100)
    expect(stats.ytdNet).toBe(1100)
  })

  it('correctly buckets ytd vs all-time', () => {
    const stats = computeOptionsPremium([
      tx({ type: 'sell_option', tx_date: '2025-06-01', symbol: 'AAPL', qty: 1, price: 5, total: 500 }),
      tx({ type: 'sell_option', tx_date: '2026-03-01', symbol: 'AAPL', qty: 1, price: 5, total: 500 }),
    ], '2026-01-01')
    expect(stats.premiumReceived).toBe(1000)
    expect(stats.ytdReceived).toBe(500)
  })
})

// ── Dividend income ───────────────────────────────────────────────────────

describe('computeDividendIncome', () => {
  it('sums YTD dividends + trailing 12 months', () => {
    const stats = computeDividendIncome([
      tx({ type: 'dividend', tx_date: '2025-08-15', symbol: 'AAPL', total: 10 }),
      tx({ type: 'dividend', tx_date: '2025-11-15', symbol: 'AAPL', total: 12 }),
      tx({ type: 'dividend', tx_date: '2026-02-15', symbol: 'AAPL', total: 14 }),
      tx({ type: 'dividend', tx_date: '2026-04-15', symbol: 'MSFT', total: 8 }),
    ], '2026-05-22')
    expect(stats.ytdTotal).toBe(22)            // Jan-current of 2026: AAPL 14 + MSFT 8
    expect(stats.ttmTotal).toBe(44)            // last 365 days: 10+12+14+8
    expect(stats.ytdBySymbol['AAPL']).toBe(14)
    expect(stats.ytdBySymbol['MSFT']).toBe(8)
  })
})

// ── Contributions ─────────────────────────────────────────────────────────

describe('computeContributions', () => {
  it('sums deposits per account, scoped to the given year', () => {
    const stats = computeContributions([
      tx({ type: 'deposit', tx_date: '2025-12-30', total: 1000, account_id: 'acc_a' }),
      tx({ type: 'deposit', tx_date: '2026-01-15', total: 2000, account_id: 'acc_a' }),
      tx({ type: 'deposit', tx_date: '2026-03-20', total: 5000, account_id: 'acc_b' }),
      tx({ type: 'deposit', tx_date: '2027-01-01', total: 99,   account_id: 'acc_a' }),
    ], '2026-01-01', '2026-12-31')
    expect(stats.byAccount['acc_a']).toBe(2000)
    expect(stats.byAccount['acc_b']).toBe(5000)
    expect(stats.total).toBe(7000)
  })

  it('does not count transfer_in as a contribution (those are shares moved in, not new money)', () => {
    const stats = computeContributions([
      tx({ type: 'deposit',     tx_date: '2026-02-01', total: 1000, account_id: 'acc_a' }),
      tx({ type: 'transfer_in', tx_date: '2026-02-01', total: 50000, account_id: 'acc_a' }),
    ], '2026-01-01', '2026-12-31')
    expect(stats.byAccount['acc_a']).toBe(1000)
  })
})

// ── Allocation drift ──────────────────────────────────────────────────────

function h(partial: Partial<Holding> & { kind: Holding['kind']; qty: number; px: number }): Holding {
  return {
    id: 'x', account_id: 'a', symbol: 'X', name: 'X',
    cost: 0, ...partial,
  } as Holding
}

describe('computeAllocationDrift', () => {
  it('current % matches when current = target', () => {
    const { rows, sumAbsDrift } = computeAllocationDrift(
      [h({ kind: 'stock', qty: 1, px: 7000 }), h({ kind: 'etf', qty: 1, px: 2000 }), h({ kind: 'cash', qty: 1000, px: 1, symbol: 'CASH' })],
      { stock: 70, etf: 20, cash: 10 },
      5,
    )
    expect(sumAbsDrift).toBe(0)
    for (const r of rows) expect(r.out_of_range).toBe(false)
  })

  it('flags kinds whose drift exceeds threshold', () => {
    // $10k portfolio: $9k stock, $1k cash; targets 70/30 → stock+20%, cash-20%
    const { rows } = computeAllocationDrift(
      [h({ kind: 'stock', qty: 1, px: 9000 }), h({ kind: 'cash', qty: 1000, px: 1, symbol: 'CASH' })],
      { stock: 70, cash: 30 },
      5,
    )
    const stock = rows.find(r => r.kind === 'stock')!
    const cash  = rows.find(r => r.kind === 'cash')!
    expect(stock.drift_pct).toBeCloseTo(20, 5)
    expect(cash.drift_pct).toBeCloseTo(-20, 5)
    expect(stock.out_of_range).toBe(true)
    expect(cash.out_of_range).toBe(true)
    expect(stock.delta_value).toBeCloseTo(2000, 1)   // $2k overweight
    expect(cash.delta_value).toBeCloseTo(-2000, 1)   // $2k underweight
  })

  it('includes a target kind that has zero current holdings', () => {
    const { rows } = computeAllocationDrift(
      [h({ kind: 'stock', qty: 1, px: 10000 })],
      { stock: 70, etf: 30 },
      5,
    )
    const etf = rows.find(r => r.kind === 'etf')!
    expect(etf.current_pct).toBe(0)
    expect(etf.target_pct).toBe(30)
    expect(etf.drift_pct).toBeCloseTo(-30, 5)
  })

  it('handles empty portfolio without dividing by zero', () => {
    const { rows, totalValue } = computeAllocationDrift([], { stock: 100 }, 5)
    expect(totalValue).toBe(0)
    expect(rows[0].current_pct).toBe(0)
  })
})
