import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Upload, CheckCircle, XCircle, AlertCircle, FileText } from 'lucide-react'
import { accounts as accountsApi, transactions as txApi, nav as navApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn, fmtMoney } from '@/lib/utils'
import type { TxType, AssetKind } from '@shared/types'

// ── CSV parser (handles quoted fields with embedded newlines) ─────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
      else if (ch === '"') { inQuote = false }
      else { field += ch }
    } else {
      if (ch === '"') { inQuote = true }
      else if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (ch !== '\r') { field += ch }
    }
    i++
  }
  if (field || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

// ── Amount parser: "$1,234.56" / "($1,234.56)" → number ──────────────────────

function parseAmount(s: string): number {
  if (!s) return 0
  const neg = s.includes('(')
  const n = parseFloat(s.replace(/[$,() ]/g, '')) || 0
  return neg ? -n : n
}

// ── Date parser: "12/31/2025" → "2025-12-31" ─────────────────────────────────

function parseRHDate(s: string): string {
  const parts = s.trim().split('/')
  if (parts.length !== 3) return s
  const [m, d, y] = parts
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// ── Robinhood Trans Code → our types ─────────────────────────────────────────

interface MappedTx {
  tx_date: string
  type: TxType
  symbol?: string
  kind?: AssetKind
  qty?: number
  price?: number
  total: number
  note?: string
  // meta
  _label: string
  _skip: boolean
  _skipReason?: string
  _warn?: string
}

const ETF_SYMBOLS = new Set([
  'SPY','QQQ','IVV','VOO','VTI','VEA','VWO','GLD','SLV','TLT','HYG','LQD',
  'ARKK','ARKG','ARKW','XLF','XLE','XLK','XLV','SCHD','VNQ','JEPI',
])

function mapRow(cols: string[]): MappedTx | null {
  if (cols.length < 9) return null
  const [actDate,,, instrument, description, transCode, qtyStr, priceStr, amountStr] = cols
  if (!actDate || !transCode) return null

  const tx_date = parseRHDate(actDate)
  const symbol = instrument?.trim().toUpperCase() || undefined
  const kind: AssetKind = symbol
    ? ETF_SYMBOLS.has(symbol) ? 'etf' : 'stock'
    : undefined as unknown as AssetKind
  const qty = parseFloat(qtyStr) || undefined
  const price = parseAmount(priceStr) || undefined
  const amount = parseAmount(amountStr)
  // Clean description: take first line, strip CUSIP line
  const note = description?.split('\n')[0]?.trim() || undefined

  switch (transCode.trim()) {
    case 'Buy':
      return { tx_date, type: 'buy', symbol, kind, qty, price,
        total: Math.abs(amount), note, _label: 'Buy', _skip: false }

    case 'Sell':
      return { tx_date, type: 'sell', symbol, kind, qty, price,
        total: Math.abs(amount), note, _label: 'Sell', _skip: false }

    case 'ACATI': {
      // ACAT transfer in — no price/amount available
      const hasQty = qty != null && qty > 0
      return {
        tx_date, type: 'buy', symbol, kind, qty, price: 0, total: 0,
        note: 'ACAT Transfer In — update cost basis',
        _label: 'ACAT In', _skip: !hasQty,
        _skipReason: hasQty ? undefined : 'No quantity',
        _warn: hasQty ? 'Price/cost is $0 — edit after import' : undefined,
      }
    }

    case 'CDIV':
      return { tx_date, type: 'dividend', symbol, qty: undefined, price: undefined,
        total: Math.abs(amount), note, _label: 'Dividend', _skip: false }

    case 'INT':
    case 'ABIP':
    case 'MISC':
    case 'GMPC':
      return { tx_date, type: 'interest', symbol: undefined, qty: undefined, price: undefined,
        total: Math.abs(amount), note, _label: 'Interest / Credit', _skip: false }

    case 'ACH':
      return {
        tx_date,
        type: amount >= 0 ? 'deposit' : 'withdraw',
        total: Math.abs(amount),
        note,
        _label: amount >= 0 ? 'ACH Deposit' : 'ACH Withdrawal',
        _skip: false,
      }

    case 'GOLD':
      return { tx_date, type: 'withdraw', total: Math.abs(amount), note: 'Gold subscription fee',
        _label: 'Gold Fee', _skip: true, _skipReason: 'Subscription fee' }

    case 'XENT_CC':
      return { tx_date, type: 'withdraw', total: Math.abs(amount), note,
        _label: 'CC Payment', _skip: true, _skipReason: 'Credit card payment' }

    case 'FUTSWP':
      return { tx_date, type: 'interest', total: Math.abs(amount), note: 'Event contracts',
        _label: 'Event Contracts', _skip: true, _skipReason: 'Event contracts not supported' }

    default:
      return { tx_date, type: 'deposit', total: Math.abs(amount), note: `${transCode}: ${note ?? ''}`.trim(),
        _label: transCode, _skip: true, _skipReason: 'Unknown transaction type' }
  }
}

// ── Type colour pills ─────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  buy: '#10B981', sell: '#EF4444', dividend: '#06B6D4',
  interest: '#06B6D4', deposit: '#10B981', withdraw: '#EF4444',
  buy_crypto: '#F97316', sell_crypto: '#EF4444',
}

// ── Main component ────────────────────────────────────────────────────────────

type Filter = 'all' | 'importing' | 'skipping'

export function Import() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [rows, setRows] = useState<MappedTx[]>([])
  const [csvFormat, setCsvFormat] = useState('robinhood')
  const [accountId, setAccountId] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [done, setDone] = useState<{ ok: number; failed: Array<{ row: MappedTx; error: string }> } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })

  const { data: existingTxs = [] } = useQuery({
    queryKey: ['transactions-dedup', accountId],
    queryFn: () => txApi.list({ accountId, limit: 5000 }),
    enabled: !!accountId,
    staleTime: 0,
    gcTime: 0,
  })

  const existingFingerprints = useMemo(() => {
    const set = new Set<string>()
    for (const tx of existingTxs) {
      set.add(`${tx.tx_date}|${tx.type}|${tx.symbol ?? ''}|${Math.abs(tx.total).toFixed(2)}`)
    }
    return set
  }, [existingTxs])

  const rowsWithDedup = useMemo(() => {
    if (!rows.length) return rows
    return rows.map(r => {
      if (r._skip) return r
      const fp = `${r.tx_date}|${r.type}|${r.symbol ?? ''}|${Math.abs(r.total).toFixed(2)}`
      if (existingFingerprints.has(fp)) return { ...r, _skip: true, _skipReason: 'Duplicate' }
      return r
    })
  }, [rows, existingFingerprints])

  // When format or accounts change, default accountId to the matching broker account
  useEffect(() => {
    if (!accs.length) return
    const match = accs.find(a => a.institution.toLowerCase().includes(csvFormat))
      ?? accs[0]
    setAccountId(match.id)
  }, [csvFormat, accs])

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const parsed = parseCSV(text)
      // Skip header row and footer/disclaimer rows
      const header = parsed[0]
      if (!header?.includes('Trans Code')) {
        alert('This doesn\'t look like a Robinhood CSV. Expected columns: Activity Date, Trans Code, etc.')
        return
      }
      const mapped = parsed
        .slice(1)
        .map(mapRow)
        .filter((r): r is MappedTx => r !== null && r.tx_date.length === 10)
        // Sort oldest → newest so cost basis builds correctly
        .sort((a, b) => a.tx_date.localeCompare(b.tx_date))

      setRows(mapped)
      setDone(null)
    }
    reader.readAsText(file)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  async function handleImport() {
    const toImport = rowsWithDedup.filter(r => !r._skip)
    if (!toImport.length || !accountId) return
    setImporting(true)
    let ok = 0
    const failed: Array<{ row: MappedTx; error: string }> = []
    for (let i = 0; i < toImport.length; i++) {
      const r = toImport[i]
      const label = r.symbol ? `${r._label} ${r.symbol} · ${r.tx_date}` : `${r._label} · ${r.tx_date}`
      setProgress({ current: i + 1, total: toImport.length, label })
      try {
        await txApi.create({
          tx_date: r.tx_date,
          account_id: accountId,
          type: r.type,
          symbol: r.symbol,
          kind: r.kind,
          qty: r.qty,
          price: r.price,
          total: r.total,
          note: r.note,
        })
        ok++
      } catch (e) {
        failed.push({ row: r, error: e instanceof Error ? e.message : 'Unknown error' })
      }
    }
    setProgress({ current: toImport.length, total: toImport.length, label: 'Backfilling chart data…' })
    if (ok > 0) {
      await navApi.backfill(accountId).catch(() => {})
    }
    // Switch to done screen before invalidating so the table doesn't flash duplicate state
    setImporting(false)
    setProgress(null)
    setDone({ ok, failed })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['transactions-dedup'] })
    qc.invalidateQueries({ queryKey: ['holdings'] })
    qc.invalidateQueries({ queryKey: ['nav'] })
  }

  const toImport   = rowsWithDedup.filter(r => !r._skip)
  const skipped    = rowsWithDedup.filter(r => r._skip)
  const warned     = toImport.filter(r => r._warn)
  const duplicates = skipped.filter(r => r._skipReason === 'Duplicate')

  const visible = filter === 'importing' ? toImport
    : filter === 'skipping' ? skipped
    : rowsWithDedup

  // ── Done state ──────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="p-8 max-w-2xl mx-auto space-y-5 mt-8">
        <div className="text-center space-y-3">
          <CheckCircle size={48} className="text-up mx-auto" />
          <h1 className="text-page-title text-text">Import Complete</h1>
          <p className="text-text-2">
            <span className="tabular font-semibold text-up">{done.ok}</span> transactions imported
            {done.failed.length > 0 && (
              <>, <span className="text-down font-semibold">{done.failed.length}</span> failed</>
            )}
          </p>
        </div>

        {done.failed.length > 0 && (
          <div className="bg-surface border border-border rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-surface-2 flex items-center gap-2">
              <XCircle size={14} className="text-down" />
              <p className="text-small font-medium text-down">Failed transactions</p>
            </div>
            <table className="w-full text-small">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-micro text-text-3 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-2.5 text-micro text-text-3 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-2.5 text-micro text-text-3 uppercase tracking-wider">Symbol</th>
                  <th className="text-left px-4 py-2.5 text-micro text-text-3 uppercase tracking-wider">Amount</th>
                  <th className="text-left px-4 py-2.5 text-micro text-text-3 uppercase tracking-wider">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {done.failed.map(({ row, error }, i) => (
                  <tr key={i} className="hover:bg-surface-2">
                    <td className="px-4 py-2.5 tabular text-text-2">{row.tx_date}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                        style={{ background: `${TYPE_COLOR[row.type] ?? '#A1A1AA'}20`, color: TYPE_COLOR[row.type] ?? '#A1A1AA' }}>
                        {row._label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text">{row.symbol ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular text-text">{fmtMoney(row.total)}</td>
                    <td className="px-4 py-2.5 text-down text-[11px]">{error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-3 justify-center">
          <Button variant="outline" onClick={() => { setRows([]); setDone(null) }}>Import Another</Button>
          <Button onClick={() => navigate('/transactions')}>View Transactions</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-page-title text-text mb-1">Import Transactions</h1>
      <p className="text-small text-text-3 mb-4">Import from your broker's CSV export. Select the format below, then drop your file.</p>

      {/* Format + destination selectors — always visible */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <div className="flex items-center gap-2">
          <label className="text-small text-text-2 font-medium whitespace-nowrap">CSV format:</label>
          <select value={csvFormat} onChange={e => setCsvFormat(e.target.value)} className="field-input w-40">
            <option value="robinhood">Robinhood</option>
            <option value="questrade" disabled>Questrade (soon)</option>
            <option value="ibkr" disabled>IBKR (soon)</option>
            <option value="wealthsimple" disabled>Wealthsimple (soon)</option>
            <option value="coinbase" disabled>Coinbase (soon)</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-small text-text-2 font-medium whitespace-nowrap">Import into account:</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className="field-input w-56">
            {accs.map(a => (
              <option key={a.id} value={a.id}>{a.institution} · {a.type}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Drop zone */}
      {rows.length === 0 && (
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileRef.current?.click()}
          className={cn(
            'border-2 border-dashed rounded-lg p-16 flex flex-col items-center gap-3 cursor-pointer transition-colors',
            dragOver ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong hover:bg-surface-2'
          )}
        >
          <Upload size={32} className="text-text-3" />
          <p className="text-text font-medium">
            Drop your {csvFormat === 'robinhood' ? 'Robinhood' : csvFormat} CSV here
          </p>
          <p className="text-small text-text-3">or click to browse</p>
          {csvFormat === 'robinhood' && (
            <p className="text-[11px] text-text-3 mt-2">
              Robinhood → Account → Statements &amp; History → Download CSV
            </p>
          )}
          <input ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
        </div>
      )}

      {/* Preview */}
      {rows.length > 0 && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total rows',  value: rowsWithDedup.length, color: 'text-text' },
              { label: 'To import',   value: toImport.length,      color: 'text-up' },
              { label: 'Duplicates',  value: duplicates.length,    color: 'text-warn' },
              { label: 'Skipping',    value: skipped.length - duplicates.length, color: 'text-text-3' },
            ].map(s => (
              <div key={s.label} className="bg-surface border border-border rounded-md p-4">
                <p className="text-micro text-text-3 uppercase tracking-wider">{s.label}</p>
                <p className={cn('tabular text-[22px] font-semibold mt-1', s.color)}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Import actions */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={() => setRows([])} disabled={importing}>
              <FileText size={13} /> Change file
            </Button>
            <Button
              onClick={handleImport}
              disabled={importing || !accountId || toImport.length === 0}
            >
              {importing ? 'Importing…' : `Import ${toImport.length} transactions`}
            </Button>
          </div>

          {/* Progress bar */}
          {progress && (
            <div className="bg-surface border border-border rounded-md px-5 py-4 space-y-3">
              <div className="flex items-center justify-between text-small">
                <span className="text-text-2 truncate pr-4">{progress.label}</span>
                <span className="tabular text-text-3 flex-shrink-0">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <div className="w-full h-2 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-150"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <p className="text-[11px] text-text-3">
                {progress.current < progress.total
                  ? `${Math.round((progress.current / progress.total) * 100)}% complete — do not close this tab`
                  : 'Finalising…'}
              </p>
            </div>
          )}

          {/* Warn banner */}
          {warned.length > 0 && (
            <div className="flex items-start gap-2 bg-warn/10 border border-warn/30 rounded-md px-4 py-3">
              <AlertCircle size={15} className="text-warn mt-0.5 flex-shrink-0" />
              <p className="text-small text-text-2">
                <span className="font-medium text-warn">{warned.length} ACAT transfer row{warned.length > 1 ? 's' : ''}</span>
                {' '}will be imported with $0 cost basis. Edit them in Transactions after import to set the correct price.
              </p>
            </div>
          )}

          {/* Filter tabs */}
          <div className="flex gap-1">
            {([
              { key: 'all',       label: `All (${rowsWithDedup.length})` },
              { key: 'importing', label: `Importing (${toImport.length})` },
              { key: 'skipping',  label: `Skipping (${skipped.length})` },
            ] as { key: Filter; label: string }[]).map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={cn(
                  'px-3 py-1.5 rounded-sm text-[12.5px] font-medium transition-colors',
                  filter === f.key ? 'bg-accent-soft text-accent' : 'text-text-2 hover:bg-surface-2'
                )}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-surface border border-border rounded-md overflow-hidden">
            <table className="w-full text-small">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Symbol</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Qty</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Price</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Amount</th>
                  <th className="text-left px-4 py-3 text-micro text-text-3 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((r, i) => (
                  <tr key={i} className={cn('hover:bg-surface-2', r._skip && 'opacity-40')}>
                    <td className="px-4 py-2.5 tabular text-text-2">{r.tx_date}</td>
                    <td className="px-4 py-2.5">
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                        style={{ background: `${TYPE_COLOR[r.type] ?? '#A1A1AA'}20`, color: TYPE_COLOR[r.type] ?? '#A1A1AA' }}>
                        {r._label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-text">{r.symbol ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular text-text-2">{r.qty ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular text-text-2">
                      {r.price != null ? fmtMoney(r.price) : '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular font-medium text-text">{fmtMoney(r.total)}</td>
                    <td className="px-4 py-2.5">
                      {r._skipReason === 'Duplicate' ? (
                        <span className="flex items-center gap-1 text-[11px] text-warn">
                          <XCircle size={12} /> Duplicate
                        </span>
                      ) : r._skip ? (
                        <span className="flex items-center gap-1 text-[11px] text-text-3">
                          <XCircle size={12} /> {r._skipReason}
                        </span>
                      ) : r._warn ? (
                        <span className="flex items-center gap-1 text-[11px] text-warn">
                          <AlertCircle size={12} /> {r._warn}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] text-up">
                          <CheckCircle size={12} /> Ready
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
