import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Pencil, AlertTriangle, Target } from 'lucide-react'
import { PageLoader } from '@/components/ui/spinner'
import {
  allocation as allocationApi,
  holdings as holdingsApi,
  accounts as accountsApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import { cn, KIND_COLOR, KIND_LABEL } from '@/lib/utils'
import { computeAllocationDrift } from '@shared/insights'
import type { AssetKind, AllocationPlan, AllocationTargets, Holding } from '@shared/types'

const ALL_KINDS: AssetKind[] = ['stock', 'etf', 'mutual_fund', 'option', 'crypto', 'cash']

export function Allocation() {
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingPlan, setEditingPlan] = useState<AllocationPlan | null>(null)

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['allocation-plans'],
    queryFn: allocationApi.list,
  })
  const { data: allHoldings = [] } = useQuery({
    queryKey: ['holdings', null],
    queryFn: () => holdingsApi.list(undefined),
  })
  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  // Default to the first plan once data arrives
  const activePlan = plans.find(p => p.id === selectedId) ?? plans[0]

  // Filter holdings to the plan's scope
  const scopedHoldings: Holding[] = useMemo(() => {
    if (!activePlan?.scope_account_ids || activePlan.scope_account_ids.length === 0) return allHoldings
    const scope = new Set(activePlan.scope_account_ids)
    return allHoldings.filter(h => scope.has(h.account_id))
  }, [allHoldings, activePlan])

  const drift = useMemo(() => {
    if (!activePlan) return null
    return computeAllocationDrift(scopedHoldings, activePlan.targets, activePlan.drift_threshold)
  }, [scopedHoldings, activePlan])

  const deleteMutation = useMutation({
    mutationFn: allocationApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allocation-plans'] }),
  })

  if (isLoading) {
    return <PageLoader />
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-page-title text-text">Target Allocation</h1>
          <p className="text-small text-text-3 mt-0.5">
            Compare your current asset mix against a target and surface drift.
          </p>
        </div>
        <Button onClick={() => { setEditingPlan(null); setModalOpen(true) }}>
          <Plus size={14} /> New plan
        </Button>
      </div>

      {plans.length === 0 ? (
        <div className="border-2 border-dashed border-border rounded-2xl p-12 text-center">
          <Target size={28} className="text-text-3 mx-auto mb-2" />
          <p className="text-text-2 text-small">No allocation plans yet.</p>
          <p className="text-text-3 text-[12px] mt-1">
            Create one to set target %'s per asset class and see drift.
          </p>
        </div>
      ) : (
        <>
          {/* Plan selector + edit/delete */}
          <div className="flex items-center gap-2 flex-wrap">
            {plans.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium transition-all duration-150',
                  (activePlan?.id === p.id)
                    ? 'bg-accent-soft text-accent'
                    : 'bg-surface border border-border text-text-2 hover:text-text hover:border-border-strong'
                )}
              >
                {p.name}
                {(!p.scope_account_ids || p.scope_account_ids.length === 0) && (
                  <span className="text-[10px] opacity-70">· all</span>
                )}
              </button>
            ))}
            {activePlan && (
              <>
                <Button variant="ghost" size="icon" onClick={() => { setEditingPlan(activePlan); setModalOpen(true) }} title="Edit plan">
                  <Pencil size={13} />
                </Button>
                <Button variant="ghost" size="icon" className="hover:text-down"
                  onClick={() => {
                    if (confirm(`Delete plan "${activePlan.name}"?`)) deleteMutation.mutate(activePlan.id)
                  }}
                  title="Delete plan">
                  <Trash2 size={13} />
                </Button>
              </>
            )}
          </div>

          {activePlan && drift && (
            <PlanDetail
              plan={activePlan}
              drift={drift}
              scopedAccountNames={activePlan.scope_account_ids?.map(id => accMap[id]?.institution).filter(Boolean) as string[] | undefined}
              fmt={fmt}
            />
          )}
        </>
      )}

      {modalOpen && (
        <PlanModal
          onClose={() => { setModalOpen(false); setEditingPlan(null) }}
          accs={accs}
          editing={editingPlan}
          onSaved={() => qc.invalidateQueries({ queryKey: ['allocation-plans'] })}
        />
      )}
    </div>
  )
}

// ── Drift detail card ─────────────────────────────────────────────────────

type DriftMetric = {
  label: string
  render: (r: NonNullable<ReturnType<typeof computeAllocationDrift>>['rows'][number], fmt: (v: number) => string) => React.ReactNode
}

const DRIFT_METRICS: DriftMetric[] = [
  {
    label: 'Current',
    render: (r, fmt) => (
      <div className="text-right">
        <div className="tabular text-small font-semibold text-text">{r.current_pct.toFixed(1)}%</div>
        <div className="tabular text-[11px] text-text-3 private-val">{fmt(r.current_value)}</div>
      </div>
    ),
  },
  {
    label: 'Target',
    render: (r, fmt) => (
      <div className="text-right">
        <div className="tabular text-small font-semibold text-text">{r.target_pct.toFixed(1)}%</div>
        <div className="tabular text-[11px] text-text-3 private-val">{fmt(r.target_value)}</div>
      </div>
    ),
  },
  {
    label: 'Drift',
    render: (r) => (
      <span className={cn('tabular text-small font-semibold', r.out_of_range ? 'text-warn' : 'text-text-3')}>
        {r.drift_pct >= 0 ? '+' : ''}{r.drift_pct.toFixed(1)}%
      </span>
    ),
  },
  {
    label: 'Rebalance',
    render: (r, fmt) => {
      const overweight = r.delta_value > 0
      if (Math.abs(r.delta_value) < 0.01) return <span className="text-small text-text-3">—</span>
      return (
        <span className={cn('tabular text-small font-semibold private-val', overweight ? 'text-down' : 'text-up')}>
          {overweight ? `Sell ${fmt(Math.abs(r.delta_value))}` : `Buy ${fmt(Math.abs(r.delta_value))}`}
        </span>
      )
    },
  },
]

function PlanDetail({ plan, drift, scopedAccountNames, fmt }: {
  plan: AllocationPlan
  drift: NonNullable<ReturnType<typeof computeAllocationDrift>>
  scopedAccountNames?: string[]
  fmt: (v: number) => string
}) {
  const [mobileMetricIdx, setMobileMetricIdx] = useState(0)
  const mobileMetric = DRIFT_METRICS[mobileMetricIdx]
  const flagged = drift.rows.filter(r => r.out_of_range)
  const inScopeText = !plan.scope_account_ids || plan.scope_account_ids.length === 0
    ? 'All accounts'
    : scopedAccountNames?.join(' · ') ?? `${plan.scope_account_ids.length} account(s)`

  return (
    <div className="space-y-4">
      <div className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush p-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-section-h2 text-text">{plan.name}</h2>
          <p className="text-[11px] text-text-3 tabular">
            Total: <span className="font-semibold text-text private-val">{fmt(drift.totalValue)}</span>
            {' · '}
            Drift {drift.sumAbsDrift.toFixed(1)}%
            {' · '}
            Threshold ±{plan.drift_threshold}%
          </p>
        </div>
        <p className="text-[12px] text-text-3 mb-4">Scope: {inScopeText}</p>

        {flagged.length > 0 && (
          <div className="flex items-start gap-2 bg-warn/10 border border-warn/30 rounded-md px-4 py-3 mb-4">
            <AlertTriangle size={14} className="text-warn mt-0.5 flex-shrink-0" />
            <div className="text-small text-text-2">
              <span className="font-medium text-warn">{flagged.length} kind{flagged.length === 1 ? '' : 's'} out of range.</span>
              {' '}Drift exceeds the ±{plan.drift_threshold}% threshold.
            </div>
          </div>
        )}

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-small min-w-[640px]">
            <thead>
              <tr className="border-b border-border text-left">
                <Th>Kind</Th>
                <Th align="right">Current</Th>
                <Th align="right">Target</Th>
                <Th align="right">Drift</Th>
                <Th align="right">Rebalance</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {drift.rows.map(r => {
                const color = KIND_COLOR[r.kind] ?? '#A1A1AA'
                const overweight = r.delta_value > 0
                return (
                  <tr key={r.kind} className={cn(r.out_of_range && 'bg-warn/5')}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                        <span className="font-medium text-text">{KIND_LABEL[r.kind] ?? r.kind}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">
                      <div className="text-text">{r.current_pct.toFixed(1)}%</div>
                      <div className="text-[11px] text-text-3 private-val">{fmt(r.current_value)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">
                      <div className="text-text">{r.target_pct.toFixed(1)}%</div>
                      <div className="text-[11px] text-text-3 private-val">{fmt(r.target_value)}</div>
                    </td>
                    <td className={cn(
                      'px-3 py-2.5 text-right tabular',
                      r.out_of_range ? 'text-warn' : 'text-text-3',
                    )}>
                      {r.drift_pct >= 0 ? '+' : ''}{r.drift_pct.toFixed(1)}%
                    </td>
                    <td className={cn(
                      'px-3 py-2.5 text-right tabular private-val',
                      Math.abs(r.delta_value) < 0.01 ? 'text-text-3' :
                      overweight ? 'text-down' : 'text-up',
                    )}>
                      {Math.abs(r.delta_value) < 0.01
                        ? '—'
                        : overweight
                          ? `Sell ${fmt(Math.abs(r.delta_value))}`
                          : `Buy ${fmt(Math.abs(r.delta_value))}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── Mobile card list ─────────────────────────────── */}
        <div className="sm:hidden border-t border-border">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <span className="text-micro text-text-3 uppercase tracking-wider">Kind</span>
            <button
              onClick={() => setMobileMetricIdx(i => (i + 1) % DRIFT_METRICS.length)}
              className="text-micro text-text-3 uppercase tracking-wider font-medium flex items-center gap-1 active:opacity-60"
            >
              {mobileMetric.label} ›
            </button>
          </div>
          <div className="divide-y divide-border">
            {drift.rows.map(r => {
              const color = KIND_COLOR[r.kind] ?? '#A1A1AA'
              return (
                <div
                  key={r.kind}
                  className={cn('flex items-center gap-3 px-4 py-3', r.out_of_range && 'bg-warn/5')}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-small font-medium text-text flex-1">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  {r.out_of_range && <AlertTriangle size={12} className="text-warn flex-shrink-0" />}
                  <div
                    className="flex-shrink-0"
                    onClick={() => setMobileMetricIdx(i => (i + 1) % DRIFT_METRICS.length)}
                  >
                    {mobileMetric.render(r, fmt)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <p className="text-[11px] text-text-3 mt-4">
          Rebalancing amounts assume you'd trade at current prices. They don't account for
          tax consequences or wash-sale windows — treat as a hint, not a recommendation.
        </p>
      </div>
    </div>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={cn(
      'px-3 py-2 text-micro text-text-3 uppercase tracking-wider font-medium',
      align === 'right' ? 'text-right' : 'text-left',
    )}>
      {children}
    </th>
  )
}

// ── Create / edit modal ───────────────────────────────────────────────────

function PlanModal({ onClose, accs, editing, onSaved }: {
  onClose: () => void
  accs: { id: string; name: string; institution: string; type: string; color: string }[]
  editing: AllocationPlan | null
  onSaved: () => void
}) {
  const isEdit = !!editing
  const [name, setName] = useState(editing?.name ?? '')
  const [scopeAccountIds, setScopeAccountIds] = useState<string[]>(editing?.scope_account_ids ?? [])
  const [scopeMode, setScopeMode] = useState<'all' | 'specific'>(
    editing?.scope_account_ids && editing.scope_account_ids.length > 0 ? 'specific' : 'all'
  )
  const [targets, setTargets] = useState<Record<string, string>>(() => {
    const t = editing?.targets ?? {}
    const out: Record<string, string> = {}
    for (const k of ALL_KINDS) out[k] = t[k] != null ? String(t[k]) : ''
    return out
  })
  const [driftThreshold, setDriftThreshold] = useState(String(editing?.drift_threshold ?? 5))
  const [submitting, setSubmitting] = useState(false)

  const numericTargets = useMemo(() => {
    const out: AllocationTargets = {}
    for (const k of ALL_KINDS) {
      const v = parseFloat(targets[k])
      if (!isNaN(v) && v > 0) out[k] = v
    }
    return out
  }, [targets])

  const sum = Object.values(numericTargets).reduce((s, v) => s + v, 0)
  const sumOk = Math.abs(sum - 100) < 0.01

  function toggleAccount(id: string) {
    setScopeAccountIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function handleSave() {
    if (!name.trim() || !sumOk) return
    setSubmitting(true)
    try {
      const body = {
        name: name.trim(),
        scope_account_ids: scopeMode === 'specific' ? scopeAccountIds : undefined,
        targets: numericTargets,
        drift_threshold: parseFloat(driftThreshold) || 5,
      }
      if (isEdit && editing) {
        await allocationApi.update(editing.id, body)
      } else {
        await allocationApi.create(body)
      }
      onSaved()
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-surface rounded-lg shadow-lg w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-section-h2 text-text">{isEdit ? 'Edit allocation plan' : 'New allocation plan'}</h2>

        <Field label="Plan name">
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Overall 70/30, RRSP target"
            className="field-input w-full" />
        </Field>

        {/* Scope */}
        <Field label="Scope">
          <div className="flex gap-2 mb-2">
            <button
              onClick={() => setScopeMode('all')}
              className={cn(
                'px-3 py-1.5 rounded-sm text-[12px] font-medium border transition-colors',
                scopeMode === 'all' ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-2'
              )}
            >
              All accounts
            </button>
            <button
              onClick={() => setScopeMode('specific')}
              className={cn(
                'px-3 py-1.5 rounded-sm text-[12px] font-medium border transition-colors',
                scopeMode === 'specific' ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-2'
              )}
            >
              Specific accounts
            </button>
          </div>
          {scopeMode === 'specific' && (
            <div className="space-y-1 max-h-36 overflow-y-auto border border-border rounded-sm p-2">
              {accs.length === 0 && <p className="text-[11px] text-text-3 px-1 py-2">No accounts yet</p>}
              {accs.map(a => (
                <label key={a.id} className="flex items-center gap-2 px-1 py-1 hover:bg-surface-2 rounded-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopeAccountIds.includes(a.id)}
                    onChange={() => toggleAccount(a.id)}
                  />
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: a.color }} />
                  <span className="text-small text-text">{a.institution}</span>
                  <span className="text-[11px] text-text-3">· {a.type}</span>
                </label>
              ))}
            </div>
          )}
        </Field>

        {/* Targets */}
        <Field label="Targets — must sum to 100%">
          <div className="grid grid-cols-2 gap-2">
            {ALL_KINDS.map(k => (
              <div key={k} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: KIND_COLOR[k] }} />
                <span className="text-small text-text-2 flex-1">{KIND_LABEL[k] ?? k}</span>
                <input
                  type="number" min="0" max="100" step="0.1"
                  value={targets[k]}
                  onChange={e => setTargets(prev => ({ ...prev, [k]: e.target.value }))}
                  placeholder="0"
                  className="field-input w-20 text-right tabular"
                />
                <span className="text-[11px] text-text-3 w-3">%</span>
              </div>
            ))}
          </div>
          <p className={cn('text-[11px] mt-2 tabular', sumOk ? 'text-up' : 'text-down')}>
            Sum: {sum.toFixed(1)}% {sumOk ? '✓' : '— must equal 100%'}
          </p>
        </Field>

        <Field label="Drift threshold (%)">
          <input
            type="number" min="0" max="100" step="0.5"
            value={driftThreshold}
            onChange={e => setDriftThreshold(e.target.value)}
            className="field-input w-28 tabular"
          />
          <p className="text-[11px] text-text-3 mt-1">
            Flag kinds whose actual % deviates from target by more than this.
          </p>
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || !sumOk || submitting} onClick={handleSave}>
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create plan'}
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
