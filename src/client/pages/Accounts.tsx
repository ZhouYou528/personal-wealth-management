import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { accounts as accountsApi } from '@/lib/api'
import { useStore } from '@/lib/store'
import { AccountTypeBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import type { AccountType } from '@shared/types'

const ACCOUNT_TYPES: AccountType[] = [
  'Brokerage', 'Roth IRA', 'Traditional IRA', '401k', 'HSA',
  'RRSP', 'TFSA', 'FHSA', 'RESP',
  'Crypto',
]

const ACCENT_COLORS = [
  '#10B981', '#3B82F6', '#7C3AED', '#F97316', '#F59E0B', '#06B6D4', '#EC4899', '#A1A1AA',
]

function AddAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('TFSA')
  const [institution, setInstitution] = useState('')
  const [color, setColor] = useState(ACCENT_COLORS[0])

  const mutation = useMutation({
    mutationFn: accountsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      onClose()
      setName(''); setInstitution('')
    },
  })

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md">
          <div className="modal-pop bg-surface rounded-lg shadow-lg p-6">
          <Dialog.Title className="text-section-h2 text-text mb-4">Add Account</Dialog.Title>

          <div className="space-y-4">
            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Account Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. My TFSA"
                className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Type</label>
              <div className="flex flex-wrap gap-2">
                {ACCOUNT_TYPES.map(t => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`px-3 py-1.5 rounded-sm text-[12.5px] font-medium border transition-colors ${
                      type === t
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-border text-text-2 hover:border-border-strong'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Institution</label>
              <input
                value={institution}
                onChange={e => setInstitution(e.target.value)}
                placeholder="e.g. Questrade"
                className="w-full px-3 py-2 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Color</label>
              <div className="flex gap-2">
                {ACCENT_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-7 h-7 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2 justify-end mt-6">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={!name.trim() || mutation.isPending}
              onClick={() => mutation.mutate({ name, type, institution, color, number: '' })}
            >
              Add Account
            </Button>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Accounts() {
  const { selectedAccountId, setSelectedAccountId } = useStore()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)

  const { data: accs = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: accountsApi.delete,
    onSuccess: (_, id) => {
      if (selectedAccountId === id) setSelectedAccountId(null)
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-page-title text-text">Accounts</h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add Account
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {accs.map(acc => (
          <div
            key={acc.id}
            onClick={() => setSelectedAccountId(selectedAccountId === acc.id ? null : acc.id)}
            className={`group relative bg-surface rounded-md border p-5 cursor-pointer transition-all ${
              selectedAccountId === acc.id
                ? 'border-accent shadow-md'
                : 'border-border hover:border-border-strong'
            }`}
          >
            <button
              onClick={e => {
                e.stopPropagation()
                if (confirm(`Delete "${acc.name}"? This won't delete its transactions.`)) {
                  deleteMutation.mutate(acc.id)
                }
              }}
              className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:text-down text-text-3"
            >
              <Trash2 size={13} />
            </button>

            <div className="flex items-center gap-3 mb-3">
              <AccountTypeBadge type={acc.type} color={acc.color} />
              <div>
                <p className="font-semibold text-text text-small">{acc.name}</p>
                <p className="text-[11px] text-text-3">{acc.institution}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span
                className="text-[11px] px-2 py-0.5 rounded-sm"
                style={{ background: `${acc.color}20`, color: acc.color }}
              >
                {acc.type}
              </span>
              <span className="text-[11px] text-text-3 tabular">{acc.number}</span>
            </div>
          </div>
        ))}

        {accs.length === 0 && (
          <div className="col-span-3 text-center py-12 text-text-3 text-small">
            No accounts yet. Add your first account to get started.
          </div>
        )}
      </div>

      {selectedAccountId && (
        <p className="text-small text-text-3 mt-4">
          Filtering by <strong className="text-text">{accs.find(a => a.id === selectedAccountId)?.name}</strong>.{' '}
          <button className="text-accent underline" onClick={() => setSelectedAccountId(null)}>Clear filter</button>
        </p>
      )}

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
