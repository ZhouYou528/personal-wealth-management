import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { goals as goalsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { fmtMoney, fmtDate } from '@/lib/utils'
import { differenceInMonths, parseISO } from 'date-fns'

const GOAL_COLORS = ['#10B981', '#3B82F6', '#7C3AED', '#F97316', '#F59E0B', '#EC4899']
const GOAL_ICONS  = ['🎯', '🏠', '🚗', '✈️', '📚', '💍', '🏦', '💰', '🌴', '🎓']

function AddGoalModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [current, setCurrent] = useState('')
  const [deadline, setDeadline] = useState('')
  const [color, setColor] = useState(GOAL_COLORS[0])
  const [icon, setIcon] = useState(GOAL_ICONS[0])

  const mutation = useMutation({
    mutationFn: goalsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] })
      onClose()
      setName(''); setTarget(''); setCurrent(''); setDeadline('')
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-surface rounded-lg shadow-lg p-6 modal-pop">
          <Dialog.Title className="text-section-h2 text-text mb-4">New Goal</Dialog.Title>

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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Target ($)</label>
                <input type="number" value={target} onChange={e => setTarget(e.target.value)}
                  placeholder="50000"
                  className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Current ($)</label>
                <input type="number" value={current} onChange={e => setCurrent(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent" />
              </div>
            </div>

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
                current: Number(current || 0),
                deadline, color, icon,
              })}
            >
              Create Goal
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Goals() {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)

  const { data: goalsList = [] } = useQuery({
    queryKey: ['goals'],
    queryFn: goalsApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: goalsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-page-title text-text">Goals</h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          New Goal
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goalsList.map(goal => {
          const pct = goal.target > 0 ? Math.min((goal.current / goal.target) * 100, 100) : 0
          const remaining = goal.target - goal.current
          const monthsLeft = Math.max(differenceInMonths(parseISO(goal.deadline), new Date()), 1)
          const monthlyNeeded = remaining > 0 ? remaining / monthsLeft : 0

          return (
            <div key={goal.id} className="bg-surface rounded-md border border-border p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[22px]">{goal.icon}</span>
                  <p className="font-semibold text-text">{goal.name}</p>
                </div>
                <Button variant="ghost" size="icon" className="hover:text-down"
                  onClick={() => deleteMutation.mutate(goal.id)}>
                  <Trash2 size={13} />
                </Button>
              </div>

              {/* Progress */}
              <div className="mb-3">
                <div className="flex justify-between text-small mb-1.5">
                  <span className="tabular font-semibold text-text private-val">{fmtMoney(goal.current)}</span>
                  <span className="tabular text-text-3 private-val">of {fmtMoney(goal.target)}</span>
                </div>
                <div className="w-full h-3 bg-surface-2 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: goal.color }}
                  />
                </div>
                <p className="text-[11px] text-text-3 mt-1">{pct.toFixed(1)}% complete</p>
              </div>

              {/* Stats footer */}
              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border">
                <div>
                  <p className="text-micro text-text-3 uppercase">Remaining</p>
                  <p className="tabular text-small font-medium text-text private-val">{fmtMoney(remaining)}</p>
                </div>
                <div>
                  <p className="text-micro text-text-3 uppercase">Monthly</p>
                  <p className="tabular text-small font-medium text-text private-val">{fmtMoney(monthlyNeeded)}</p>
                </div>
                <div>
                  <p className="text-micro text-text-3 uppercase">Deadline</p>
                  <p className="text-small font-medium text-text">{fmtDate(goal.deadline)}</p>
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

      <AddGoalModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
