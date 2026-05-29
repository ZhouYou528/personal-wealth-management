import type { Transaction, Holding, AssetKind } from '@shared/types'

interface Accumulator {
  account_id: string
  symbol: string
  kind: AssetKind
  qty: number
  cost: number  // weighted-average cost per unit
  option_type?: 'call' | 'put'
  strike?: number
  expiry?: string
  underlying?: string
  multiplier?: number
}

function optionKey(tx: Transaction): string {
  // Each distinct option contract gets its own bucket
  return `${tx.account_id}:${tx.symbol}:${tx.option_type ?? ''}:${tx.strike ?? ''}:${tx.expiry ?? ''}`
}

// Apply a cash delta (positive credits, negative debits) to the account's CASH bucket.
// Allows negative balances so margin/data errors are visible rather than hidden.
function adjustCash(map: Map<string, Accumulator>, account_id: string, delta: number): void {
  if (delta === 0) return
  const key = `${account_id}:CASH`
  const pos = map.get(key)
  if (pos) {
    pos.qty += delta
  } else {
    map.set(key, {
      account_id,
      symbol: 'CASH',
      kind: 'cash',
      qty: delta,
      cost: 1,
    })
  }
}

function kindFromTxType(tx: Transaction): AssetKind {
  if (tx.kind) return tx.kind
  switch (tx.type) {
    case 'buy_crypto':
    case 'sell_crypto': return 'crypto'
    case 'buy_option':
    case 'sell_option': return 'option'
    case 'deposit':
    case 'withdraw':
    case 'transfer':
    case 'interest': return 'cash'
    case 'split':
    case 'transfer_in':
    case 'transfer_out': return 'stock'
    default: return 'stock'
  }
}

export function computeHoldings(transactions: Transaction[]): Omit<Holding, 'name' | 'px'>[] {
  const map = new Map<string, Accumulator>()

  for (const tx of transactions) {
    switch (tx.type) {
      case 'buy':
      case 'buy_crypto': {
        if (!tx.symbol || tx.qty == null || tx.price == null) break
        const key = `${tx.account_id}:${tx.symbol}`
        const pos = map.get(key)
        if (pos) {
          const newQty = pos.qty + tx.qty
          if (newQty <= 1e-9) {
            map.delete(key)
          } else {
            // only weighted-avg with the positive (long) portion; negative stub contributes 0 cost
            const prevLong = Math.max(pos.qty, 0)
            pos.cost = prevLong > 0
              ? (prevLong * pos.cost + tx.qty * tx.price) / newQty
              : tx.price
            pos.qty = newQty
          }
        } else {
          map.set(key, {
            account_id: tx.account_id,
            symbol: tx.symbol,
            kind: kindFromTxType(tx),
            qty: tx.qty,
            cost: tx.price,
          })
        }
        adjustCash(map, tx.account_id, -tx.total)
        break
      }

      case 'sell':
      case 'sell_crypto': {
        if (!tx.symbol || tx.qty == null) break
        const key = `${tx.account_id}:${tx.symbol}`
        const pos = map.get(key)
        if (pos) {
          pos.qty -= tx.qty
          if (pos.qty < 1e-9) map.delete(key)
        } else {
          // sell arrived before corresponding buy (same-day ordering); store as negative stub
          map.set(key, {
            account_id: tx.account_id,
            symbol: tx.symbol,
            kind: kindFromTxType(tx),
            qty: -tx.qty,
            cost: 0,
          })
        }
        adjustCash(map, tx.account_id, tx.total)
        break
      }

      case 'buy_option': {
        if (!tx.symbol || tx.qty == null || tx.price == null) break
        const key = optionKey(tx)
        const pos = map.get(key)
        if (pos) {
          const newQty = pos.qty + tx.qty
          if (newQty <= 1e-9) {
            map.delete(key)
          } else {
            const prevLong = Math.max(pos.qty, 0)
            pos.cost = prevLong > 0
              ? (prevLong * pos.cost + tx.qty * tx.price) / newQty
              : tx.price
            pos.qty = newQty
          }
        } else {
          map.set(key, {
            account_id: tx.account_id,
            symbol: tx.symbol,
            kind: 'option',
            qty: tx.qty,
            cost: tx.price,
            option_type: tx.option_type,
            strike: tx.strike,
            expiry: tx.expiry,
            underlying: tx.underlying ?? tx.symbol,
            multiplier: 100,
          })
        }
        // Cash handled by companion withdraw transaction (see 0002_option_cash migration)
        break
      }

      case 'sell_option': {
        if (!tx.symbol || tx.qty == null) break
        const key = optionKey(tx)
        const pos = map.get(key)
        if (pos) {
          pos.qty -= tx.qty
          if (pos.qty < 1e-9) map.delete(key)
        } else {
          // sell-to-open or close-before-open: store as negative stub
          map.set(key, {
            account_id: tx.account_id,
            symbol: tx.symbol,
            kind: 'option',
            qty: -tx.qty,
            cost: tx.price ?? 0,
            option_type: tx.option_type,
            strike: tx.strike,
            expiry: tx.expiry,
            underlying: tx.underlying ?? tx.symbol,
            multiplier: 100,
          })
        }
        // Cash handled by companion deposit transaction (see 0002_option_cash migration)
        break
      }

      case 'deposit':
      case 'dividend':
      case 'interest': {
        const key = `${tx.account_id}:CASH`
        const pos = map.get(key)
        if (pos) {
          pos.qty += tx.total
        } else {
          map.set(key, {
            account_id: tx.account_id,
            symbol: 'CASH',
            kind: 'cash',
            qty: tx.total,
            cost: 1,
          })
        }
        break
      }

      case 'withdraw': {
        // Use adjustCash so a withdraw dated before any deposit still applies
        // (negative cash is allowed; the final filter keeps non-trivial cash either sign).
        adjustCash(map, tx.account_id, -tx.total)
        break
      }

      case 'transfer_in': {
        // Shares moved in from another broker (ACAT, journal, etc.) — no cash leaves this account.
        // qty = shares received, price = cost basis per share (from originating broker).
        if (!tx.symbol || tx.qty == null) break
        const key = `${tx.account_id}:${tx.symbol}`
        const pos = map.get(key)
        const cost = tx.price ?? 0
        if (pos) {
          const newQty = pos.qty + tx.qty
          if (newQty <= 1e-9) {
            map.delete(key)
          } else {
            const prevLong = Math.max(pos.qty, 0)
            pos.cost = prevLong > 0
              ? (prevLong * pos.cost + tx.qty * cost) / newQty
              : cost
            pos.qty = newQty
          }
        } else {
          map.set(key, {
            account_id: tx.account_id,
            symbol: tx.symbol,
            kind: kindFromTxType(tx),
            qty: tx.qty,
            cost,
          })
        }
        // intentionally no cash adjustment
        break
      }

      case 'transfer_out': {
        // Shares moved out to another broker — no cash credited here.
        if (!tx.symbol || tx.qty == null) break
        const key = `${tx.account_id}:${tx.symbol}`
        const pos = map.get(key)
        if (pos) {
          pos.qty -= tx.qty
          if (pos.qty < 1e-9) map.delete(key)
        }
        break
      }

      case 'split': {
        // qty = new-share numerator, price = old-share denominator
        // e.g. 2-for-1 → qty=2, price=1 (ratio=2); 1-for-10 reverse → qty=1, price=10 (ratio=0.1)
        if (!tx.symbol || tx.qty == null || tx.price == null || tx.price === 0) break
        const ratio = tx.qty / tx.price
        if (ratio <= 0) break
        const key = `${tx.account_id}:${tx.symbol}`
        const pos = map.get(key)
        if (pos) {
          pos.qty  *= ratio
          pos.cost /= ratio
        }
        break
      }

      case 'transfer': {
        if (tx.from_account) {
          const fromKey = `${tx.from_account}:CASH`
          const from = map.get(fromKey)
          if (from) {
            from.qty -= tx.total
            if (from.qty < 1e-9) map.delete(fromKey)
          }
        }
        if (tx.to_account) {
          const toKey = `${tx.to_account}:CASH`
          const to = map.get(toKey)
          if (to) {
            to.qty += tx.total
          } else {
            map.set(toKey, {
              account_id: tx.to_account,
              symbol: 'CASH',
              kind: 'cash',
              qty: tx.total,
              cost: 1,
            })
          }
        }
        break
      }
    }
  }

  return Array.from(map.entries())
    .filter(([, p]) =>
      p.kind === 'cash'   ? Math.abs(p.qty) > 0.01 :
      p.kind === 'option' ? Math.abs(p.qty) > 1e-4 :       // keep short option positions
      p.qty > 1e-4)
    .map(([key, p]) => ({
      id: key,
      account_id: p.account_id,
      symbol: p.symbol,
      kind: p.kind,
      qty: p.qty,
      cost: p.cost,
      option_type: p.option_type,
      strike: p.strike,
      expiry: p.expiry,
      underlying: p.underlying,
      multiplier: p.multiplier,
    }))
}
