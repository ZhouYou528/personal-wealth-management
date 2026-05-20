import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accounts as accountsApi, transactions as txApi, market } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Button } from './ui/button'
import { todayISO } from '@/lib/utils'
import type { TxType, AssetKind } from '@shared/types'

interface TxConfig {
  label: string
  sub: string
  color: string
  fields: ('account' | 'date' | 'symbol' | 'qty' | 'price' | 'total' | 'note' |
           'fromAccount' | 'toAccount' | 'optionFields' | 'frequency')[]
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
}

const TYPE_GRID = [
  'buy','sell','buy_option','sell_option',
  'buy_crypto','sell_crypto','deposit','withdraw',
  'transfer','dividend','interest','recurring',
] as TxType[]

export function AddTxModal() {
  const { addTxOpen, addTxPrefill, closeAddTx } = useStore()
  const qc = useQueryClient()

  const [step, setStep] = useState<'pick' | 'form'>('pick')
  const [type, setType] = useState<TxType>('buy')
  const [accountId, setAccountId] = useState('')
  const [fromAccountId, setFromAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [date, setDate] = useState(todayISO())
  const [symbol, setSymbol] = useState('')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [total, setTotal] = useState('')
  const [note, setNote] = useState('')
  const [optionType, setOptionType] = useState<'call' | 'put'>('call')
  const [strike, setStrike] = useState('')
  const [expiry, setExpiry] = useState('')
  const [symbolResults, setSymbolResults] = useState<{ symbol: string; name: string }[]>([])

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })

  const mutation = useMutation({
    mutationFn: txApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
      handleClose()
    },
  })

  function handleClose() {
    closeAddTx()
    setTimeout(() => {
      setStep('pick'); setSymbol(''); setQty(''); setPrice(''); setTotal(''); setNote('')
      setStrike(''); setExpiry('')
    }, 200)
  }

  function handlePickType(t: TxType) {
    setType(t)
    setStep('form')
  }

  // Apply prefill when modal opens
  useEffect(() => {
    if (!addTxOpen) return
    if (addTxPrefill?.type) { setType(addTxPrefill.type as TxType); setStep('form') }
    if (addTxPrefill?.symbol) setSymbol(addTxPrefill.symbol)
    if (addTxPrefill?.accountId) setAccountId(addTxPrefill.accountId)
    else if (accs.length > 0 && !accountId) setAccountId(accs[0].id)
  }, [addTxOpen, addTxPrefill, accs])

  // Auto-compute total for trades
  useEffect(() => {
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

  function handleSubmit() {
    const cfg = TX_TYPES[type]
    mutation.mutate({
      date, type,
      account_id: accountId || accs[0]?.id,
      symbol: symbol || undefined,
      kind: cfg.kind,
      qty: qty ? Number(qty) : undefined,
      price: price ? Number(price) : undefined,
      total: Number(total),
      note: note || undefined,
      to_account: toAccountId || undefined,
      from_account: fromAccountId || undefined,
      option_type: (type === 'buy_option' || type === 'sell_option') ? optionType : undefined,
      strike: strike ? Number(strike) : undefined,
      expiry: expiry || undefined,
    })
  }

  const cfg = TX_TYPES[type]
  const fields = cfg.fields

  return (
    <Dialog.Root open={addTxOpen} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl bg-surface rounded-lg shadow-lg modal-pop max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between p-5 border-b border-border">
            <Dialog.Title className="text-section-h2 text-text">
              {step === 'pick' ? 'Add Transaction' : cfg.label}
            </Dialog.Title>
            <button onClick={handleClose} className="text-text-3 hover:text-text">
              <X size={18} />
            </button>
          </div>

          {step === 'pick' ? (
            <div className="p-5">
              <div className="grid grid-cols-4 gap-2">
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
              {/* Back to picker */}
              <button onClick={() => setStep('pick')} className="text-[12px] text-text-3 hover:text-text">
                ← Choose type
              </button>

              {fields.includes('account') && (
                <Field label="Account">
                  <select value={accountId} onChange={e => setAccountId(e.target.value)}
                    className="field-input">
                    {accs.map(a => <option key={a.id} value={a.id}>{a.name} · {a.institution}</option>)}
                  </select>
                </Field>
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

              <Field label="Date">
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className="field-input" />
              </Field>

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

              {(fields.includes('qty') || fields.includes('price')) && (
                <div className="grid grid-cols-3 gap-4">
                  <Field label="Quantity">
                    <input type="number" value={qty} onChange={e => setQty(e.target.value)} placeholder="10" className="field-input" />
                  </Field>
                  <Field label="Price">
                    <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" className="field-input" />
                  </Field>
                  <Field label="Total">
                    <input type="number" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00" className="field-input" />
                  </Field>
                </div>
              )}

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
                  disabled={!total || mutation.isPending}
                  onClick={handleSubmit}
                >
                  {mutation.isPending ? 'Saving…' : 'Add Transaction'}
                </Button>
              </div>
            </div>
          )}
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
