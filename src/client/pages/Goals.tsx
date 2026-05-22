import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Link2, Pencil } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { goals as goalsApi, holdings as holdingsApi, accounts as accountsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { fmtDate, cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import { differenceInMonths, parseISO } from 'date-fns'
import type { Goal } from '@shared/types'

const GOAL_COLORS = ['#10B981', '#3B82F6', '#7C3AED', '#F97316', '#F59E0B', '#EC4899']
const GOAL_ICONS  = ['🎯', '🏠', '🚗', '✈️', '📚', '💍', '🏦', '💰', '🌴', '🎓']

/** Sum the value of all holdings in the given accounts.
 *  Uses live market price × qty × multiplier. */
function liveValueForAccounts(
  holdings: { account_id: string; qty: number; px: number; multiplier?: number }[],
  accountIds: string[],
): number {
  if (!accountIds.length) return 0
  const set = new Set(accountIds)
  return holdings
    .filter(h => set.has(h.account_id))
    .reduce((sum, h) => sum + h.qty * h.px * (h.multiplier ?? 1), 0)
}

function GoalModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: Goal }) {
  const isEdit = !!editing
  const qc = useQueryClient()
  const [name, setName] = useState(editing?.name ?? '')
  const [target, setTarget] = useState(editing ? String(editing.target) : '')
  const [current, setCurrent] = useState(editing ? String(editing.current) : '')
  const [deadline, setDeadline] = useState(editing?.deadline ?? '')
  const [color, setColor] = useState(editing?.color ?? GOAL_COLORS[0])
  const [icon, setIcon] = useState(editing?.icon ?? GOAL_ICONS[0])
  const [linkedAccountIds, setLinkedAccountIds] = useState<string[]>(editing?.account_ids ?? [])

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })

  const createMutation = useMutation({
    mutationFn: goalsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      onClose()
      setName(''); setTarget(''); setCurrent(''); setDeadline('')
      setLinkedAccountIds([])
    },
  })

  const updateMutation = useMutation({
    mutationFn: (body: Partial<Goal>) => goalsApi.update(editing!.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      onClose()
    },
  })

  const mutation = isEdit ? updateMutation : createMutation

  function toggleAccount(id: string) {
    setLinkedAccountIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const isLinked = linkedAccountIds.length > 0

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md">
          <div className="modal-pop bg-surface rounded-lg shadow-lg p-6 max-h-[90vh] overflow-y-auto">
          <Dialog.Title className="text-section-h2 text-text mb-4">{isEdit ? 'Edit Goal' : 'New Goal'}</Dialog.Title>

          <div className="space-y-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Goal Name</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. Emergency Fund"
                  className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Icon</label>
                <select value={icon} onChange={e => setIcon(e.target.value)}
                  className="h-[38px] px-3 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent">
                  {GOAL_ICONS.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Target ($)</label>
              <input type="number" value={target} onChange={e => setTarget(e.target.value)}
                placeholder="50000"
                className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
            </div>

            {/* Account linking — when set, `current` auto-tracks live holdings */}
            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">
                Linked accounts (optional)
              </label>
              <p className="text-[11px] text-text-3 mb-2">
                {isLinked
                  ? 'Goal progress auto-updates from the combined value of these accounts.'
                  : 'Pick one or more accounts to auto-track, or leave empty and enter "Current" manually below.'}
              </p>
              <div className="space-y-1 max-h-40 overflow-y-auto border border-border rounded-sm p-2">
                {accs.length === 0 && <p className="text-[11px] text-text-3 px-1 py-2">No accounts yet</p>}
                {accs.map(a => (
                  <label key={a.id} className="flex items-center gap-2 px-1 py-1 hover:bg-surface-2 rounded-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={linkedAccountIds.includes(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: a.color }} />
                    <span className="text-small text-text">{a.institution}</span>
                    <span className="text-[11px] text-text-3">· {a.type}</span>
                  </label>
                ))}
              </div>
            </div>

            {!isLinked && (
              <div>
                <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Current ($)</label>
                <input type="number" value={current} onChange={e => setCurrent(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
              </div>
            )}

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Deadline</label>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
            </div>

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Color</label>
              <div className="flex gap-2">
                {GOAL_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)}
                    className={`w-7 h-7 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105'}`}
                    style={{ background: c }} />
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2 justify-end mt-6">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!name || !target || !deadline || mutation.isPending}
              onClick={() => mutation.mutate({
                name, target: Number(target),
                current: isLinked ? 0 : Number(current || 0),
                deadline, color, icon,
                account_ids: isLinked ? linkedAccountIds : undefined,
              })}
            >
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create Goal'}
            </Button>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Goals() {
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [addOpen, setAddOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null)

  const { data: goalsList = [] } = useQuery({
    queryKey: ['goals'],
    queryFn: goalsApi.list,
  })

  const { data: holdingsData = [] } = useQuery({
    queryKey: ['holdings', null],
    queryFn: () => holdingsApi.list(undefined),
  })

  const { data: accs = [] } = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.list })
  const accMap = Object.fromEntries(accs.map(a => [a.id, a]))

  const deleteMutation = useMutation({
    mutationFn: goalsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-page-title text-text">Goals</h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          New Goal
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goalsList.map(goal => {
          const linked = goal.account_ids && goal.account_ids.length > 0
          // Linked goals: pull current value from live holdings. Manual goals: use stored value.
          const liveCurrent = linked ? liveValueForAccounts(holdingsData, goal.account_ids!) : goal.current
          const pct = goal.target > 0 ? Math.min((liveCurrent / goal.target) * 100, 100) : 0
          const remaining = Math.max(goal.target - liveCurrent, 0)

          const monthsLeft = differenceInMonths(parseISO(goal.deadline), new Date())
          const monthlyText = remaining <= 0
            ? '—'
            : monthsLeft < 0
              ? 'Overdue'
              : monthsLeft === 0
                ? fmt(remaining)
                : fmt(remaining / monthsLeft)

          const deadlineText = monthsLeft < 0 ? `Past · ${fmtDate(goal.deadline)}` : fmtDate(goal.deadline)

          return (
            <div key={goal.id} className="bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[22px]">{goal.icon}</span>
                  <p className="font-semibold text-text">{goal.name}</p>
                  {linked && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-accent-soft text-accent">
                      <Link2 size={9} /> Auto
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditingGoal(goal)} title="Edit">
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="icon" className="hover:text-down"
                    onClick={() => {
                      if (confirm(`Delete "${goal.name}"?`)) deleteMutation.mutate(goal.id)
                    }}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>

              {/* Linked accounts row */}
              {linked && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {goal.account_ids!.map(id => {
                    const a = accMap[id]
                    if (!a) return null
                    return (
                      <span key={id} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-surface-2">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: a.color }} />
                        {a.institution} · {a.type}
                      </span>
                    )
                  })}
                </div>
              )}

              {/* Progress */}
              <div className="mb-3">
                <div className="flex justify-between text-small mb-1.5">
                  <span className="tabular font-semibold text-text private-val">{fmt(liveCurrent)}</span>
                  <span className="tabular text-text-3 private-val">of {fmt(goal.target)}</span>
                </div>
                <div className="w-full h-3 bg-surface-2 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: goal.color }}
                  />
                </div>
                <p className={cn('text-[11px] mt-1', pct >= 100 ? 'text-up font-medium' : 'text-text-3')}>
                  {pct.toFixed(1)}% complete{pct >= 100 ? ' — goal reached 🎉' : ''}
                </p>
              </div>

              {/* Stats footer */}
              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border">
                <div>
                  <p className="text-micro text-text-3 uppercase">Remaining</p>
                  <p className="tabular text-small font-medium text-text private-val">{fmt(remaining)}</p>
                </div>
                <div>
                  <p className="text-micro text-text-3 uppercase">Monthly</p>
                  <p className={cn(
                    'tabular text-small font-medium',
                    monthlyText === 'Overdue' ? 'text-down' : 'text-text',
                    monthlyText !== 'Overdue' && monthlyText !== '—' && 'private-val'
                  )}>
                    {monthlyText}
                  </p>
                </div>
                <div>
                  <p className="text-micro text-text-3 uppercase">Deadline</p>
                  <p className={cn('text-small font-medium', monthsLeft < 0 ? 'text-down' : 'text-text')}>
                    {deadlineText}
                  </p>
                </div>
              </div>
            </div>
          )
        })}

        {goalsList.length === 0 && (
          <div className="col-span-2 text-center py-12 text-text-3 text-small">
            No goals yet. Create your first savings goal.
          </div>
        )}
      </div>

      <GoalModal open={addOpen} onClose={() => setAddOpen(false)} />
      {editingGoal && (
        <GoalModal
          open={true}
          onClose={() => setEditingGoal(null)}
          editing={editingGoal}
        />
      )}
    </div>
  )
}
