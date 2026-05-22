import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accounts as accountsApi, transactions as txApi, nav as navApi, market, fx as fxApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Button } from './ui/button'
import { todayISO } from '@/lib/utils'
import type { TxType, AssetKind } from '@shared/types'

interface TxConfig {
  label: string
  sub: string
  color: string
  fields: ('account' | 'date' | 'symbol' | 'qty' | 'price' | 'total' | 'note' |
           'fromAccount' | 'toAccount' | 'optionFields' | 'frequency' | 'splitRatio')[]
  kind?: AssetKind
}

const TX_TYPES: Record<TxType, TxConfig> = {
  buy:          { label: 'Buy',         sub: 'Stock / ETF',     color: '#10B981', fields: ['account','date','symbol','qty','price','total','note'], kind: 'stock' },
  sell:         { label: 'Sell',        sub: 'Stock / ETF',     color: '#EF4444', fields: ['account','date','symbol','qty','price','total','note'], kind: 'stock' },
  buy_option:   { label: 'Buy Option',  sub: 'Calls & Puts',    color: '#F59E0B', fields: ['account','date','symbol','optionFields','qty','price','total','note'], kind: 'option' },
  sell_option:  { label: 'Sell Option', sub: 'Close position',  color: '#EF4444', fields: ['account','date','symbol','optionFields','qty','price','total','note'], kind: 'option' },
  buy_crypto:   { label: 'Buy Crypto',  sub: 'BTC, ETH, etc.',  color: '#F97316', fields: ['account','date','symbol','qty','price','total','note'], kind: 'crypto' },
  sell_crypto:  { label: 'Sell Crypto', sub: 'Exit position',   color: '#EF4444', fields: ['account','date','symbol','qty','price','total','note'], kind: 'crypto' },
  deposit:      { label: 'Deposit',     sub: 'Add cash',        color: '#10B981', fields: ['account','date','total','note'], kind: 'cash' },
  withdraw:     { label: 'Withdraw',    sub: 'Remove cash',     color: '#EF4444', fields: ['account','date','total','note'], kind: 'cash' },
  transfer:     { label: 'Transfer',    sub: 'Between accounts',color: '#6B7280', fields: ['fromAccount','toAccount','date','total','note'] },
  dividend:     { label: 'Dividend',    sub: 'Income received', color: '#06B6D4', fields: ['account','date','symbol','total','note'] },
  interest:     { label: 'Interest',    sub: 'Bank / bond',     color: '#06B6D4', fields: ['account','date','total','note'], kind: 'cash' },
  recurring:    { label: 'Recurring',   sub: 'Auto-invest',     color: '#7C3AED', fields: ['account','date','total','frequency'] },
  split:        { label: 'Stock Split', sub: 'Forward / reverse', color: '#7C3AED', fields: ['account','date','symbol','splitRatio','note'], kind: 'stock' },
  transfer_in:  { label: 'Transfer In', sub: 'Shares from another broker', color: '#10B981', fields: ['account','date','symbol','qty','price','note'], kind: 'stock' },
  transfer_out: { label: 'Transfer Out',sub: 'Shares to another broker',   color: '#A1A1AA', fields: ['account','date','symbol','qty','note'],          kind: 'stock' },
}

const TYPE_GRID = [
  'buy','sell','buy_option','sell_option',
  'buy_crypto','sell_crypto','deposit','withdraw',
  'transfer','transfer_in','transfer_out','dividend',
  'interest','split',
] as TxType[]

export function AddTxModal() {
  const { addTxOpen, addTxPrefill, editTx, closeAddTx } = useStore()
  const qc = useQueryClient()
  const isEdit = editTx !== null

  const [step, setStep] = useState<'pick' | 'form'>('pick')
  const [type, setType] = useState<TxType>('buy')
  const [accountId, setAccountId] = useState('')
  const [accountType, setAccountType] = useState('')
  const [fromAccountId, setFromAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [date, setDate] = useState(todayISO())
  const [symbol, setSymbol] = useState('')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [total, setTotal] = useState('')
  const [note, setNote] = useState('')
  // Currency the user is entering amounts in. Converted to USD on submit since
  // the storage convention is USD.
  const [entryCurrency, setEntryCurrency] = useState('USD')
  const [optionType, setOptionType] = useState<'call' | 'put'>('call')
  const [strike, setStrike] = useState('')
  const [expiry, setExpiry] = useState('')
  const [splitNew, setSplitNew] = useState('2')   // new shares (numerator)
  const [splitOld, setSplitOld] = useState('1')   // old shares (denominator)
  const [symbolResults, setSymbolResults] = useState<{ symbol: string; name: string }[]>([])

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })

  function refreshAfterMutation(accountId: string | undefined) {
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['transactions-dedup'] })
    qc.invalidateQueries({ queryKey: ['holdings'] })
    handleClose()
    // Background: rebuild nav snapshots so the dashboard chart reflects the new/edited tx
    navApi.backfill(accountId)
      .then(() => qc.invalidateQueries({ queryKey: ['nav'] }))
      .catch(() => {})
  }

  const createMutation = useMutation({
    mutationFn: txApi.create,
    onSuccess: (tx) => refreshAfterMutation(tx.account_id),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof txApi.update>[1] }) =>
      txApi.update(id, body),
    onSuccess: (tx) => refreshAfterMutation(tx.account_id),
  })

  const mutation = isEdit ? updateMutation : createMutation

  function handleClose() {
    closeAddTx()
    setTimeout(() => {
      setStep('pick'); setSymbol(''); setQty(''); setPrice(''); setTotal(''); setNote('')
      setStrike(''); setExpiry(''); setDate(todayISO())
      setFromAccountId(''); setToAccountId('')
      setSplitNew('2'); setSplitOld('1')
      setEntryCurrency('USD')
    }, 200)
  }

  function handlePickType(t: TxType) {
    setType(t)
    setStep('form')
  }

  // Prefill once per open. Without this ref, a React Query refetch of `accs` mid-edit
  // would re-run the effect and clobber whatever the user has typed.
  const prefilledForOpenRef = useRef(false)
  useEffect(() => {
    if (!addTxOpen) {
      prefilledForOpenRef.current = false
      return
    }
    if (prefilledForOpenRef.current) return

    // Edit mode: prefill everything from the existing transaction
    if (editTx) {
      prefilledForOpenRef.current = true
      setStep('form')
      setType(editTx.type as TxType)
      setAccountId(editTx.account_id)
      const acc = accs.find(a => a.id === editTx.account_id)
      if (acc) setAccountType(acc.type)
      setFromAccountId(editTx.from_account ?? '')
      setToAccountId(editTx.to_account ?? '')
      setDate(editTx.tx_date.slice(0, 10))
      setSymbol(editTx.symbol ?? '')
      setQty(editTx.qty != null ? String(editTx.qty) : '')
      setPrice(editTx.price != null ? String(editTx.price) : '')
      setTotal(String(editTx.total))
      setNote(editTx.note ?? '')
      if (editTx.option_type) setOptionType(editTx.option_type)
      setStrike(editTx.strike != null ? String(editTx.strike) : '')
      setExpiry(editTx.expiry ?? '')
      if (editTx.type === 'split') {
        setSplitNew(editTx.qty != null ? String(editTx.qty) : '2')
        setSplitOld(editTx.price != null ? String(editTx.price) : '1')
      }
      return
    }

    // Add mode: wait for accs to load before marking as prefilled (otherwise we miss
    // setting the default account).
    if (accs.length === 0) return
    prefilledForOpenRef.current = true
    if (addTxPrefill?.type) { setType(addTxPrefill.type as TxType); setStep('form') }
    if (addTxPrefill?.symbol) setSymbol(addTxPrefill.symbol)
    if (addTxPrefill?.accountId) {
      setAccountId(addTxPrefill.accountId)
      const acc = accs.find(a => a.id === addTxPrefill.accountId)
      if (acc) setAccountType(acc.type)
    } else if (!accountId) {
      setAccountId(accs[0].id)
      setAccountType(accs[0].type)
    }
  }, [addTxOpen, addTxPrefill, editTx, accs])

  // Auto-compute total for trades (skip when type doesn't use a total — e.g. transfer_in)
  useEffect(() => {
    if (!TX_TYPES[type].fields.includes('total')) return
    const q = parseFloat(qty)
    const p = parseFloat(price)
    if (!isNaN(q) && !isNaN(p)) {
      const mult = type === 'buy_option' || type === 'sell_option' ? 100 : 1
      setTotal((q * p * mult).toFixed(2))
    }
  }, [qty, price, type])

  async function handleSymbolSearch(q: string) {
    setSymbol(q)
    if (q.length < 1) { setSymbolResults([]); return }
    const { results } = await market.search(q)
    setSymbolResults(results)
  }

  async function handleSubmit() {
    const cfg = TX_TYPES[type]
    const isSplit = type === 'split'
    const isShareTransfer = type === 'transfer_in' || type === 'transfer_out'

    // Convert entered amounts to USD if user picked a non-USD currency.
    // Source: ECB rates via the worker /api/fx endpoint (cached 60min).
    let priceUSD = price ? Number(price) : undefined
    let totalUSD = Number(total)
    let originalCurrencyNote = ''
    if (entryCurrency !== 'USD' && !isSplit) {
      try {
        const fx = await fxApi.rates('USD')
        const rate = fx.rates[entryCurrency]
        if (rate && rate > 0) {
          if (priceUSD != null) priceUSD = priceUSD / rate
          totalUSD = totalUSD / rate
          originalCurrencyNote = ` [${entryCurrency} ${total} @ rate ${(1 / rate).toFixed(4)}]`
        }
      } catch (e) {
        console.warn('FX fetch failed, storing as-entered:', e)
      }
    }

    const body = {
      tx_date: date, type,
      account_id: accountId || accs[0]?.id,
      symbol: symbol || undefined,
      kind: cfg.kind,
      qty: isSplit ? Number(splitNew) : qty ? Number(qty) : undefined,
      price: isSplit ? Number(splitOld) : priceUSD,
      total: (isSplit || isShareTransfer) ? 0 : totalUSD,
      note: (note ?? '') + originalCurrencyNote || undefined,
      to_account: toAccountId || undefined,
      from_account: fromAccountId || undefined,
      option_type: (type === 'buy_option' || type === 'sell_option') ? optionType : undefined,
      strike: strike ? Number(strike) : undefined,
      expiry: expiry || undefined,
    }
    if (isEdit && editTx) {
      updateMutation.mutate({ id: editTx.id, body })
    } else {
      createMutation.mutate(body)
    }
  }

  const cfg = TX_TYPES[type]
  const fields = cfg.fields

  const brokers = [...new Set(accs.map(a => a.institution))].sort()
  const allTypes = [...new Set(accs.map(a => a.type))].sort()
  const curInstitution = accs.find(a => a.id === accountId)?.institution ?? ''

  return (
    <Dialog.Root open={addTxOpen} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-1rem)] max-w-2xl">
          <div className="modal-pop bg-surface rounded-lg shadow-lg max-h-[92vh] overflow-y-auto">
          <div className="flex items-center justify-between p-5 border-b border-border">
            <Dialog.Title className="text-section-h2 text-text">
              {isEdit ? `Edit ${cfg.label}` : step === 'pick' ? 'Add Transaction' : cfg.label}
            </Dialog.Title>
            <button onClick={handleClose} className="text-text-3 hover:text-text">
              <X size={18} />
            </button>
          </div>

          {step === 'pick' && !isEdit ? (
            <div className="p-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {TYPE_GRID.map(t => {
                  const c = TX_TYPES[t]
                  return (
                    <button
                      key={t}
                      onClick={() => handlePickType(t)}
                      className="flex flex-col items-start gap-1.5 p-3 rounded-md border border-border hover:border-border-strong hover:bg-surface-2 transition-colors text-left"
                    >
                      <span
                        className="w-8 h-8 rounded-sm flex items-center justify-center text-[13px] font-bold"
                        style={{ background: `${c.color}20`, color: c.color }}
                      >
                        {c.label.slice(0, 2)}
                      </span>
                      <div>
                        <p className="text-small font-medium text-text">{c.label}</p>
                        <p className="text-[11px] text-text-3">{c.sub}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="p-5 space-y-4">
              {/* Back to picker — hidden in edit mode since type isn't changeable */}
              {!isEdit && (
                <button onClick={() => setStep('pick')} className="text-[12px] text-text-3 hover:text-text">
                  ← Choose type
                </button>
              )}

              {fields.includes('account') && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Broker">
                    <select
                      value={curInstitution}
                      onChange={e => {
                        const newBroker = e.target.value
                        const match = accs.find(a => a.institution === newBroker && a.type === accountType)
                          ?? accs.find(a => a.institution === newBroker)
                        if (match) { setAccountId(match.id); setAccountType(match.type) }
                      }}
                      className="field-input"
                    >
                      {brokers.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </Field>
                  <Field label="Account Type">
                    <select
                      value={accountType}
                      onChange={e => {
                        const newType = e.target.value
                        setAccountType(newType)
                        const match = accs.find(a => a.institution === curInstitution && a.type === newType)
                        if (match) setAccountId(match.id)
                      }}
                      className="field-input"
                    >
                      {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                </div>
              )}

              {fields.includes('fromAccount') && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="From Account">
                    <select value={fromAccountId} onChange={e => setFromAccountId(e.target.value)} className="field-input">
                      {accs.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </Field>
                  <Field label="To Account">
                    <select value={toAccountId} onChange={e => setToAccountId(e.target.value)} className="field-input">
                      {accs.filter(a => a.id !== fromAccountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </Field>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label="Date">
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} className="field-input" />
                </Field>
                <Field label="Entry currency">
                  <select
                    value={entryCurrency}
                    onChange={e => setEntryCurrency(e.target.value)}
                    className="field-input"
                    title={entryCurrency === 'USD'
                      ? 'Amounts entered in USD (default)'
                      : `Amounts will be converted to USD via today's ECB rate before saving`}
                  >
                    <option value="USD">USD</option>
                    <option value="CAD">CAD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="HKD">HKD</option>
                    <option value="JPY">JPY</option>
                  </select>
                </Field>
              </div>
              {entryCurrency !== 'USD' && (
                <p className="text-[11px] text-text-3 -mt-2">
                  Amount fields below are in {entryCurrency}. They'll be converted to USD on save
                  using today's ECB reference rate (cached 60min).
                </p>
              )}

              {fields.includes('symbol') && (
                <Field label="Symbol">
                  <div className="relative">
                    <input
                      value={symbol}
                      onChange={e => handleSymbolSearch(e.target.value)}
                      placeholder="AAPL, BTC, VEQT.TO…"
                      className="field-input w-full"
                    />
                    {symbolResults.length > 0 && (
                      <div className="absolute top-full left-0 mt-1 w-full bg-surface border border-border rounded-md shadow-md z-10">
                        {symbolResults.map(r => (
                          <button key={r.symbol} onClick={() => { setSymbol(r.symbol); setSymbolResults([]) }}
                            className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface-2 text-left">
                            <span className="text-small font-medium text-text">{r.symbol}</span>
                            <span className="text-[11px] text-text-3">{r.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Field>
              )}

              {fields.includes('splitRatio') && (
                <Field label="Split Ratio">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      value={splitNew}
                      onChange={e => setSplitNew(e.target.value)}
                      className="field-input w-24 text-center"
                      placeholder="2"
                    />
                    <span className="text-text-3 text-small">new for</span>
                    <input
                      type="number"
                      step="any"
                      value={splitOld}
                      onChange={e => setSplitOld(e.target.value)}
                      className="field-input w-24 text-center"
                      placeholder="1"
                    />
                    <span className="text-text-3 text-small">old</span>
                    <span className="text-text-3 text-[11px] ml-2">
                      e.g. 2 new for 1 old = 2:1 forward · 1 new for 10 old = 1:10 reverse
                    </span>
                  </div>
                </Field>
              )}

              {fields.includes('optionFields') && (
                <div className="grid grid-cols-3 gap-4">
                  <Field label="Type">
                    <div className="flex gap-2">
                      {(['call', 'put'] as const).map(ot => (
                        <button key={ot} onClick={() => setOptionType(ot)}
                          className={`flex-1 py-1.5 rounded-sm text-small font-medium border capitalize transition-colors ${
                            optionType === ot ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-2'
                          }`}>
                          {ot}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Strike">
                    <input type="number" value={strike} onChange={e => setStrike(e.target.value)} placeholder="540" className="field-input" />
                  </Field>
                  <Field label="Expiry">
                    <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className="field-input" />
                  </Field>
                </div>
              )}

              {(fields.includes('qty') || fields.includes('price')) && (() => {
                const showPrice = fields.includes('price')
                const showTotal = fields.includes('total')
                const cols = 1 + (showPrice ? 1 : 0) + (showTotal ? 1 : 0)
                const priceLabel = type === 'transfer_in' ? 'Cost basis / share' : 'Price'
                return (
                  <div className={`grid gap-4 ${cols === 3 ? 'grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    <Field label="Quantity">
                      <input type="number" value={qty} onChange={e => setQty(e.target.value)} placeholder="10" className="field-input" />
                    </Field>
                    {showPrice && (
                      <Field label={priceLabel}>
                        <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" className="field-input" />
                      </Field>
                    )}
                    {showTotal && (
                      <Field label="Total">
                        <input type="number" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00" className="field-input" />
                      </Field>
                    )}
                  </div>
                )
              })()}

              {!fields.includes('qty') && fields.includes('total') && (
                <Field label="Amount">
                  <input type="number" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00" className="field-input" />
                </Field>
              )}

              {fields.includes('note') && (
                <Field label="Note (optional)">
                  <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note…" className="field-input" />
                </Field>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={handleClose}>Cancel</Button>
                <Button
                  disabled={
                    mutation.isPending ||
                    (type === 'split'
                      ? !symbol || !Number(splitNew) || !Number(splitOld)
                      : type === 'transfer_in'
                        ? !symbol || !Number(qty)
                        : type === 'transfer_out'
                          ? !symbol || !Number(qty)
                          : !total)
                  }
                  onClick={handleSubmit}
                >
                  {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Transaction'}
                </Button>
              </div>
            </div>
          )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">{label}</label>
      {children}
    </div>
  )
}
