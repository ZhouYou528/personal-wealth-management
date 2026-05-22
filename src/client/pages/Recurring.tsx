import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Play, Pause, Calendar, Pencil } from 'lucide-react'
import { recurring as recurringApi, accounts as accountsApi, nav as navApi, fx as fxApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import { fmtDate, todayISO, cn } from '@/lib/utils'
import type { RecurringFrequency, RecurringRule, TxType } from '@shared/types'

const FREQUENCIES: { value: RecurringFrequency; label: string; days: string }[] = [
  { value: 'biweekly',  label: 'Bi-weekly',  days: 'every 14 days' },
  { value: 'monthly',   label: 'Monthly',    days: 'same day each month' },
  { value: 'quarterly', label: 'Quarterly',  days: 'same day each 3 months' },
]

// The subset of TxTypes that make sense as recurring. Add more later as needed.
const TX_TYPE_OPTIONS: { value: TxType; label: string }[] = [
  { value: 'deposit',  label: 'Deposit' },
  { value: 'withdraw', label: 'Withdraw' },
  { value: 'interest', label: 'Interest' },
  { value: 'dividend', label: 'Dividend' },
]

export function Recurring() {
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [addOpen, setAddOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<RecurringRule | null>(null)

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['recurring'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['holdings'] })
  }

  const deleteMutation = useMutation({
    mutationFn: recurringApi.delete,
    onSuccess: invalidateAll,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: number }) =>
      recurringApi.update(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => recurringApi.runOne(id),
    onSuccess: async (data, id) => {
      invalidateAll()
      const rule = rules.find(r => r.id === id)
      if (rule && data.fired.length > 0) {
        navApi.backfill(rule.account_id)
          .then(() => qc.invalidateQueries({ queryKey: ['nav'] }))
          .catch(() => {})
        alert(`Fired ${data.fired.length} transaction${data.fired.length === 1 ? '' : 's'}: ${data.fired.join(', ')}`)
      } else {
        alert('Nothing due — rule is already up to date.')
      }
    },
  })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-page-title text-text">Recurring</h1>
          <p className="text-small text-text-3 mt-0.5">
            Auto-generate transactions on a schedule. Fires daily at 22:00 UTC.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} /> New rule
        </Button>
      </div>

      {isLoading ? (
        <p className="text-text-3 text-small py-8 text-center">Loading…</p>
      ) : rules.length === 0 ? (
        <div className="border border-dashed border-border rounded-md p-12 text-center">
          <Calendar size={28} className="text-text-3 mx-auto mb-2" />
          <p className="text-text-2 text-small">No recurring rules yet.</p>
          <p className="text-text-3 text-[12px] mt-1">
            Add a bi-weekly contribution, monthly deposit, etc.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => {
            const acc = accMap[rule.account_id]
            const dueText = rule.active
              ? rule.next_due
                ? rule.next_due <= todayISO()
                  ? `Due now (${fmtDate(rule.next_due)})`
                  : `Next: ${fmtDate(rule.next_due)}`
                : 'Inactive'
              : 'Paused'
            return (
              <div key={rule.id} className="bg-surface border border-border rounded-md p-4 flex items-start gap-4 flex-wrap sm:flex-nowrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-small font-semibold text-text capitalize">{rule.tx_type}</span>
                    <span className="tabular text-small font-semibold text-text private-val">{fmt(rule.total)}</span>
                    <span className="text-[11px] text-text-3">
                      · {FREQUENCIES.find(f => f.value === rule.frequency)?.label}
                    </span>
                    {!rule.active && (
                      <span className="text-[10px] uppercase tracking-wider text-text-3 bg-surface-2 px-1.5 py-0.5 rounded">Paused</span>
                    )}
                  </div>
                  <p className="text-[11px] text-text-3">
                    {acc ? <><span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: acc.color }} />{acc.institution} · {acc.type}</> : 'Unknown account'}
                    {' · '} Started {fmtDate(rule.start_date)}
                    {rule.end_date && <> · Ends {fmtDate(rule.end_date)}</>}
                    {rule.last_fired && <> · Last fired {fmtDate(rule.last_fired)}</>}
                  </p>
                  <p className={cn(
                    'text-[12px] tabular mt-1',
                    rule.active && rule.next_due && rule.next_due <= todayISO() ? 'text-accent' : 'text-text-3'
                  )}>
                    {dueText}
                  </p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => runMutation.mutate(rule.id)}
                    disabled={runMutation.isPending}
                    title="Run any pending firings now"
                  >
                    Run now
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    onClick={() => setEditingRule(rule)}
                    title="Edit rule"
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    onClick={() => toggleMutation.mutate({ id: rule.id, active: rule.active ? 0 : 1 })}
                    title={rule.active ? 'Pause' : 'Resume'}
                  >
                    {rule.active ? <Pause size={14} /> : <Play size={14} />}
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    onClick={() => {
                      if (confirm(`Delete this recurring rule? Already-created transactions stay; only future firings stop.`)) {
                        deleteMutation.mutate(rule.id)
                      }
                    }}
                    className="hover:text-down"
                    title="Delete rule"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {addOpen && <AddRuleModal onClose={() => setAddOpen(false)} accs={accs} onCreated={invalidateAll} />}
      {editingRule && (
        <AddRuleModal
          onClose={() => setEditingRule(null)}
          accs={accs}
          onCreated={invalidateAll}
          editing={editingRule}
        />
      )}
    </div>
  )
}

function AddRuleModal({ onClose, accs, onCreated, editing }: {
  onClose: () => void
  accs: { id: string; name: string; institution: string; type?: string; color: string }[]
  onCreated: () => void
  editing?: RecurringRule
}) {
  const isEdit = !!editing
  const qc = useQueryClient()
  const [accountId, setAccountId] = useState(editing?.account_id ?? accs[0]?.id ?? '')
  const [txType, setTxType] = useState<TxType>((editing?.tx_type as TxType) ?? 'deposit')
  // In edit mode the modal displays the stored USD amount; we don't try to recover
  // the original currency since we only kept the converted USD value.
  const [total, setTotal] = useState(editing ? String(editing.total) : '')
  const [currency, setCurrency] = useState('USD')
  const [frequency, setFrequency] = useState<RecurringFrequency>(editing?.frequency ?? 'biweekly')
  const [startDate, setStartDate] = useState(editing?.start_date ?? todayISO())
  const [endDate, setEndDate] = useState(editing?.end_date ?? '')
  const [note, setNote] = useState(editing?.note ?? '')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    setSubmitting(true)
    try {
      let usdTotal = Number(total)
      let currencyNote = ''
      if (currency !== 'USD') {
        try {
          const fx = await fxApi.rates('USD')
          const rate = fx.rates[currency]
          if (rate && rate > 0) {
            usdTotal = usdTotal / rate
            currencyNote = ` [${currency} ${total} @ rate ${(1 / rate).toFixed(4)}]`
          }
        } catch (e) {
          console.warn('FX fetch failed; using as-entered:', e)
        }
      }

      if (isEdit && editing) {
        await recurringApi.update(editing.id, {
          account_id: accountId,
          tx_type:    txType,
          total:      usdTotal,
          frequency,
          start_date: startDate,
          end_date:   endDate || undefined,
          note:       (note + currencyNote) || undefined,
        })
      } else {
        await recurringApi.create({
          account_id: accountId,
          tx_type:    txType,
          total:      usdTotal,
          frequency,
          start_date: startDate,
          end_date:   endDate || undefined,
          note:       (note + currencyNote) || undefined,
        })
      }
      qc.invalidateQueries({ queryKey: ['recurring'] })
      onCreated()
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-surface rounded-lg shadow-lg w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-section-h2 text-text">{isEdit ? 'Edit recurring rule' : 'New recurring rule'}</h2>

        <Field label="Account">
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className="field-input w-full">
            {accs.map(a => (
              <option key={a.id} value={a.id}>
                {a.institution}{a.type ? ` · ${a.type}` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Transaction type">
          <select value={txType} onChange={e => setTxType(e.target.value as TxType)} className="field-input w-full">
            {TX_TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Amount">
            <input type="number" step="any" value={total} onChange={e => setTotal(e.target.value)} placeholder="500.00" className="field-input w-full" />
          </Field>
          <Field label="Currency">
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              className="field-input w-full"
              title={currency === 'USD'
                ? 'Amount in USD'
                : `Will be converted to USD at today's ECB rate when the rule is created`}
            >
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="HKD">HKD</option>
              <option value="JPY">JPY</option>
            </select>
          </Field>
          <Field label="Frequency">
            <select value={frequency} onChange={e => setFrequency(e.target.value as RecurringFrequency)} className="field-input w-full">
              {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
        </div>
        {currency !== 'USD' && (
          <p className="text-[11px] text-text-3 -mt-2">
            Amount is in {currency}. Converted to USD now using today's ECB rate — every future
            firing posts the same fixed USD amount (not re-converted on each fire).
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="First firing">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="field-input w-full" />
          </Field>
          <Field label="End date (optional)">
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="field-input w-full" />
          </Field>
        </div>

        <Field label="Note (optional)">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Employer match, paycheck, etc." className="field-input w-full" />
        </Field>

        {startDate < todayISO() && (
          <p className="text-[11px] text-warn">
            ⚠️ Start date is in the past — saving will catch up and create all missed firings.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!accountId || !total || submitting}
            onClick={handleSubmit}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-text-3 uppercase tracking-wider block mb-1">{label}</label>
      {children}
    </div>
  )
}
