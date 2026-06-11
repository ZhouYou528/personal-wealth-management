import { holdings as holdingsApi, transactions as txApi, nav, accounts as accountsApi } from './api'
import type { Account, Holding } from '@shared/types'

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function colWidths(...widths: number[]) {
  return widths.map(w => ({ wch: w }))
}

export async function exportToSpreadsheet(): Promise<void> {
  // Lazy-load xlsx so the ~220 KB bundle only downloads on first export
  const [XLSX, holdingsData, txData, navData, accountsData] = await Promise.all([
    import('xlsx').then(m => m.default ?? m),
    holdingsApi.list(),
    txApi.list({ limit: 99999 }),
    nav.history(1825),
    accountsApi.list() as Promise<Account[]>,
  ])

  const accountMap = new Map<string, string>(accountsData.map(a => [a.id, a.name]))
  const wb = XLSX.utils.book_new()
  const date = new Date().toISOString().split('T')[0]

  // ── Holdings ──────────────────────────────────────────────────
  const totalValue = holdingsData.reduce((s: number, h: Holding) => s + h.qty * h.px * (h.multiplier ?? 1), 0)

  const holdingsRows = holdingsData.map((h: Holding) => {
    const mult = h.multiplier ?? 1
    const mktVal   = h.qty * h.px   * mult
    const costBasis = h.qty * h.cost * mult
    const pnl      = mktVal - costBasis
    const pnlPct   = costBasis > 0 ? (pnl / costBasis) * 100 : 0
    const weight   = totalValue > 0 ? (mktVal / totalValue) * 100 : 0

    const row: Record<string, string | number> = {
      Account:               accountMap.get(h.account_id) ?? h.account_id,
      Symbol:                h.symbol,
      Name:                  h.name,
      Type:                  h.kind,
      Quantity:              h.qty,
      'Cost/Share ($)':      r2(h.cost),
      'Current Price ($)':   r2(h.px),
      'Market Value ($)':    r2(mktVal),
      'Cost Basis ($)':      r2(costBasis),
      'Unrealized P&L ($)':  r2(pnl),
      'Unrealized P&L (%)':  r2(pnlPct),
      'Portfolio Weight (%)': r2(weight),
      'Today Change ($)':    h.change    != null ? r2(h.change)    : '',
      'Today Change (%)':    h.changePct != null ? r2(h.changePct) : '',
    }

    if (h.kind === 'option') {
      row['Option Type']  = h.option_type  ?? ''
      row['Strike ($)']   = h.strike       ?? ''
      row['Expiry']       = h.expiry       ?? ''
      row['Underlying']   = h.underlying   ?? ''
      row['Multiplier']   = mult
    }

    return row
  })

  const holdingsSheet = XLSX.utils.json_to_sheet(holdingsRows)
  holdingsSheet['!cols'] = colWidths(22, 10, 30, 12, 12, 14, 16, 16, 14, 18, 18, 20, 16, 16)
  XLSX.utils.book_append_sheet(wb, holdingsSheet, 'Holdings')

  // ── Transactions ──────────────────────────────────────────────
  const txRows = txData.map(t => ({
    Date:        t.tx_date,
    Account:     accountMap.get(t.account_id) ?? t.account_id,
    Symbol:      t.symbol   ?? '',
    Type:        t.type,
    Kind:        t.kind     ?? '',
    Quantity:    t.qty      ?? '',
    Price:       t.price    != null ? r2(t.price) : '',
    'Total ($)': r2(t.total),
    Note:        t.note     ?? '',
  }))

  const txSheet = XLSX.utils.json_to_sheet(txRows)
  txSheet['!cols'] = colWidths(12, 22, 10, 14, 10, 10, 10, 12, 35)
  XLSX.utils.book_append_sheet(wb, txSheet, 'Transactions')

  // ── NAV History (aggregate only) ──────────────────────────────
  const aggNav = navData
    .filter(n => !n.account_id)
    .sort((a, b) => a.snap_date.localeCompare(b.snap_date))

  const navRows = aggNav.map((n, i) => {
    const prev = aggNav[i - 1]
    const change    = prev ? r2(n.value - prev.value) : ''
    const changePct = (prev && prev.value > 0) ? r2(((n.value - prev.value) / prev.value) * 100) : ''
    return {
      Date:                 n.snap_date,
      'Portfolio Value ($)': r2(n.value),
      'Change ($)':         change,
      'Change (%)':         changePct,
    }
  })

  const navSheet = XLSX.utils.json_to_sheet(navRows)
  navSheet['!cols'] = colWidths(14, 20, 14, 12)
  XLSX.utils.book_append_sheet(wb, navSheet, 'NAV History')

  // ── Accounts ──────────────────────────────────────────────────
  const acctValues = holdingsData.reduce((map: Map<string, number>, h: Holding) => {
    map.set(h.account_id, (map.get(h.account_id) ?? 0) + h.qty * h.px * (h.multiplier ?? 1))
    return map
  }, new Map<string, number>())

  const accountRows = accountsData.map((a: Account) => ({
    Name:              a.name,
    Institution:       a.institution,
    Type:              a.type,
    'Current Value ($)': r2(acctValues.get(a.id) ?? 0),
  }))

  const acctSheet = XLSX.utils.json_to_sheet(accountRows)
  acctSheet['!cols'] = colWidths(25, 22, 16, 18)
  XLSX.utils.book_append_sheet(wb, acctSheet, 'Accounts')

  XLSX.writeFile(wb, `meridian-export-${date}.xlsx`)
}
