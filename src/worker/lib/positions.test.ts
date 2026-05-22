import { describe, it, expect } from 'vitest'
import { computeHoldings } from './positions'
import type { Transaction, TxType } from '@shared/types'

// ── Test helpers ──────────────────────────────────────────────

let counter = 0
function tx(partial: Partial<Transaction> & { type: TxType; tx_date: string }): Transaction {
  counter += 1
  return {
    id: `tx_${counter}`,
    account_id: 'acc_a',
    total: 0,
    created_at: `2025-01-01T00:00:${String(counter).padStart(2, '0')}Z`,
    ...partial,
  } as Transaction
}

function holding(rows: Transaction[], symbol: string) {
  return computeHoldings(rows).find(h => h.symbol === symbol)
}

function cash(rows: Transaction[], account = 'acc_a') {
  return computeHoldings(rows).find(h => h.symbol === 'CASH' && h.account_id === account)?.qty ?? 0
}

// ── Buys & sells ──────────────────────────────────────────────

describe('computeHoldings — buy/sell', () => {
  it('records a buy with correct qty and cost', () => {
    const h = holding([
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 150, total: 1500 }),
    ], 'AAPL')
    expect(h?.qty).toBe(10)
    expect(h?.cost).toBe(150)
  })

  it('debits cash from the same account on buy', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 5000 }),
      tx({ type: 'buy', tx_date: '2025-01-02', symbol: 'AAPL', qty: 10, price: 150, total: 1500 }),
    ]
    expect(cash(rows)).toBeCloseTo(3500, 2)
  })

  it('credits cash on sell', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 150, total: 1500 }),
      tx({ type: 'sell', tx_date: '2025-02-01', symbol: 'AAPL', qty: 5, price: 200, total: 1000 }),
    ]
    expect(holding(rows, 'AAPL')?.qty).toBe(5)
    expect(cash(rows)).toBeCloseTo(-500, 2)
  })

  it('computes weighted-average cost across multiple buys', () => {
    const h = holding([
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      tx({ type: 'buy', tx_date: '2025-02-01', symbol: 'AAPL', qty: 10, price: 200, total: 2000 }),
    ], 'AAPL')
    expect(h?.qty).toBe(20)
    expect(h?.cost).toBe(150)
  })

  it('removes a position fully sold (within float tolerance)', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      tx({ type: 'sell', tx_date: '2025-02-01', symbol: 'AAPL', qty: 10, price: 200, total: 2000 }),
    ]
    expect(holding(rows, 'AAPL')).toBeUndefined()
  })

  it('filters fractional residual positions under 1e-4', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10.123456, price: 100, total: 1012.3456 }),
      tx({ type: 'sell', tx_date: '2025-02-01', symbol: 'AAPL', qty: 10.12345, price: 200, total: 2024.69 }),
    ]
    // Residual ≈ 0.000006 shares — should be filtered
    expect(holding(rows, 'AAPL')).toBeUndefined()
  })
})

// ── Same-day ordering ─────────────────────────────────────────

describe('computeHoldings — same-day sell before buy', () => {
  it('still nets to zero when sell is processed before its buy', () => {
    const rows = [
      // Sell with earlier created_at than the buy on the same day
      tx({ type: 'sell', tx_date: '2025-01-01', symbol: 'AAPL', qty: 5, price: 100, total: 500 }),
      tx({ type: 'buy',  tx_date: '2025-01-01', symbol: 'AAPL', qty: 5, price: 100, total: 500 }),
    ]
    expect(holding(rows, 'AAPL')).toBeUndefined()
  })

  it('partial cover keeps remaining long with the buy price as cost', () => {
    const rows = [
      tx({ type: 'sell', tx_date: '2025-01-01', symbol: 'AAPL', qty: 3, price: 100, total: 300 }),
      tx({ type: 'buy',  tx_date: '2025-01-01', symbol: 'AAPL', qty: 5, price: 100, total: 500 }),
    ]
    const h = holding(rows, 'AAPL')
    expect(h?.qty).toBe(2)
    expect(h?.cost).toBe(100)
  })
})

// ── Transfer in / out ─────────────────────────────────────────

describe('computeHoldings — transfer_in', () => {
  it('adds shares with provided cost basis without touching cash', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000 }),
      tx({ type: 'transfer_in', tx_date: '2025-02-01', symbol: 'AAPL', qty: 10, price: 150 }),
    ]
    expect(holding(rows, 'AAPL')?.qty).toBe(10)
    expect(holding(rows, 'AAPL')?.cost).toBe(150)
    expect(cash(rows)).toBe(1000)  // unchanged
  })

  it('weighted-averages with subsequent buys', () => {
    const rows = [
      tx({ type: 'transfer_in', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 100 }),
      tx({ type: 'buy', tx_date: '2025-02-01', symbol: 'AAPL', qty: 10, price: 200, total: 2000 }),
    ]
    const h = holding(rows, 'AAPL')
    expect(h?.qty).toBe(20)
    expect(h?.cost).toBe(150)
  })

  it('transfer_out removes shares without crediting cash', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000 }),
      tx({ type: 'buy', tx_date: '2025-01-02', symbol: 'AAPL', qty: 10, price: 50, total: 500 }),
      tx({ type: 'transfer_out', tx_date: '2025-02-01', symbol: 'AAPL', qty: 4 }),
    ]
    expect(holding(rows, 'AAPL')?.qty).toBe(6)
    expect(cash(rows)).toBe(500)  // unchanged by transfer_out
  })
})

// ── Splits ─────────────────────────────────────────────────────

describe('computeHoldings — splits', () => {
  it('2-for-1 split doubles qty and halves cost', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 10, price: 100, total: 1000 }),
      // Encoding: qty=numerator (new), price=denominator (old)
      tx({ type: 'split', tx_date: '2025-06-01', symbol: 'AAPL', qty: 2, price: 1 }),
    ]
    const h = holding(rows, 'AAPL')
    expect(h?.qty).toBe(20)
    expect(h?.cost).toBe(50)
  })

  it('1-for-10 reverse split divides qty by 10 and 10x the cost', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'XYZ', qty: 100, price: 1, total: 100 }),
      tx({ type: 'split', tx_date: '2025-06-01', symbol: 'XYZ', qty: 1, price: 10 }),
    ]
    const h = holding(rows, 'XYZ')
    expect(h?.qty).toBe(10)
    expect(h?.cost).toBe(10)
  })

  it('split preserves total cost basis', () => {
    const rows = [
      tx({ type: 'buy', tx_date: '2025-01-01', symbol: 'AAPL', qty: 7, price: 123.45, total: 864.15 }),
      tx({ type: 'split', tx_date: '2025-06-01', symbol: 'AAPL', qty: 3, price: 2 }),
    ]
    const h = holding(rows, 'AAPL')!
    expect(h.qty * h.cost).toBeCloseTo(7 * 123.45, 4)
  })
})

// ── Cash flow ──────────────────────────────────────────────────

describe('computeHoldings — cash', () => {
  it('aggregates deposits, dividends, interest', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000 }),
      tx({ type: 'dividend', tx_date: '2025-01-15', total: 50 }),
      tx({ type: 'interest', tx_date: '2025-02-01', total: 25 }),
    ]
    expect(cash(rows)).toBeCloseTo(1075, 2)
  })

  it('withdraws apply even when no prior cash position exists (allows negative)', () => {
    const rows = [
      tx({ type: 'withdraw', tx_date: '2025-01-01', total: 500 }),
    ]
    expect(cash(rows)).toBeCloseTo(-500, 2)
  })

  it('cross-account buys never touch the other account cash', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000, account_id: 'acc_a' }),
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000, account_id: 'acc_b' }),
      tx({ type: 'buy', tx_date: '2025-02-01', symbol: 'AAPL', qty: 5, price: 100, total: 500, account_id: 'acc_b' }),
    ]
    expect(cash(rows, 'acc_a')).toBe(1000)
    expect(cash(rows, 'acc_b')).toBe(500)
  })

  it('transfer between accounts moves cash', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 1000, account_id: 'acc_a' }),
      tx({ type: 'transfer', tx_date: '2025-02-01', total: 300, from_account: 'acc_a', to_account: 'acc_b' }),
    ]
    expect(cash(rows, 'acc_a')).toBe(700)
    expect(cash(rows, 'acc_b')).toBe(300)
  })
})

// ── Options ───────────────────────────────────────────────────

describe('computeHoldings — options', () => {
  it('keeps distinct contracts separate (strike/expiry/type)', () => {
    const rows = [
      tx({ type: 'buy_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500,
          option_type: 'call', strike: 150, expiry: '2025-03-15' }),
      tx({ type: 'buy_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 3, total: 300,
          option_type: 'put',  strike: 140, expiry: '2025-03-15' }),
      tx({ type: 'buy_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 7, total: 700,
          option_type: 'call', strike: 150, expiry: '2025-06-20' }),
    ]
    const contracts = computeHoldings(rows).filter(h => h.kind === 'option')
    expect(contracts).toHaveLength(3)
  })

  it('buy_option debits cash by total (premium × multiplier)', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 10000 }),
      tx({ type: 'buy_option', tx_date: '2025-01-02', symbol: 'AAPL', qty: 2, price: 5, total: 1000,
          option_type: 'call', strike: 150, expiry: '2025-03-15' }),
    ]
    expect(cash(rows)).toBeCloseTo(9000, 2)
  })

  it('sell_option closes a long contract and credits cash', () => {
    const open = tx({ type: 'buy_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500,
                     option_type: 'call', strike: 150, expiry: '2025-03-15' })
    const close = tx({ type: 'sell_option', tx_date: '2025-02-01', symbol: 'AAPL', qty: 1, price: 8, total: 800,
                      option_type: 'call', strike: 150, expiry: '2025-03-15' })
    const positions = computeHoldings([open, close]).filter(h => h.kind === 'option')
    expect(positions).toHaveLength(0)
    expect(cash([open, close])).toBeCloseTo(300, 2)  // net premium
  })

  it('cash-secured put: short position is visible with negative qty + premium credited', () => {
    const rows = [
      tx({ type: 'deposit', tx_date: '2025-01-01', total: 20000 }),
      // Sell-to-open 1 put at $150 strike for $5/share premium
      tx({ type: 'sell_option', tx_date: '2025-01-02', symbol: 'AAPL', qty: 1, price: 5, total: 500,
           option_type: 'put', strike: 150, expiry: '2025-03-15' }),
    ]
    const all = computeHoldings(rows)
    const shortPut = all.find(h => h.kind === 'option')
    expect(shortPut).toBeDefined()
    expect(shortPut?.qty).toBe(-1)
    expect(shortPut?.option_type).toBe('put')
    expect(shortPut?.strike).toBe(150)
    // Cash now reflects deposit + premium
    expect(cash(rows)).toBeCloseTo(20500, 2)
  })

  it('buying to close a short put zeros the position', () => {
    const open = tx({ type: 'sell_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500,
                     option_type: 'put', strike: 150, expiry: '2025-03-15' })
    const close = tx({ type: 'buy_option', tx_date: '2025-02-01', symbol: 'AAPL', qty: 1, price: 2, total: 200,
                      option_type: 'put', strike: 150, expiry: '2025-03-15' })
    const positions = computeHoldings([open, close]).filter(h => h.kind === 'option')
    expect(positions).toHaveLength(0)
    expect(cash([open, close])).toBeCloseTo(300, 2)  // +500 premium, -200 to close
  })

  it('options have multiplier=100', () => {
    const rows = [
      tx({ type: 'buy_option', tx_date: '2025-01-01', symbol: 'AAPL', qty: 1, price: 5, total: 500,
          option_type: 'call', strike: 150, expiry: '2025-03-15' }),
    ]
    expect(computeHoldings(rows)[0].multiplier).toBe(100)
  })
})
