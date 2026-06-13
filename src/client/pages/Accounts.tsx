import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check, Pencil, Plus, Trash2, X, Wifi,
  ExternalLink, ChevronRight, Building2,
  RefreshCw,
} from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { formatDistanceToNowStrict, parseISO } from 'date-fns'
import {
  accounts as accountsApi,
  holdings as holdingsApi,
  snaptrade as snapApi,
  ibkrFlex as ibkrFlexApi,
} from '@/lib/api'

function formatRelativeTime(iso: string): string {
  try {
    return `${formatDistanceToNowStrict(parseISO(iso))} ago`
  } catch {
    return 'recently'
  }
}

// Compact form for inline display: "2 minutes" → "2m", "5 hours" → "5h", etc.
function formatRelativeShort(iso: string): string {
  try {
    const s = formatDistanceToNowStrict(parseISO(iso))
    const m = s.match(/^(\d+)\s+(second|minute|hour|day|month|year)/)
    if (!m) return s
    const map: Record<string, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', month: 'mo', year: 'y' }
    return `${m[1]}${map[m[2]] ?? ''}`
  } catch {
    return ''
  }
}
import type { SnapBrokerage, SnapBrokerAccount, ImportAccountItem } from '@/lib/api'
import { useStore } from '@/lib/store'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, rectSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AccountTypeBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Account, AccountType } from '@shared/types'

const ACCOUNT_TYPES: AccountType[] = [
  'Brokerage', 'Roth IRA', 'Traditional IRA', '401k', 'HSA',
  'RRSP', 'TFSA', 'FHSA', 'RESP', 'Crypto',
]

// 6×4 grid of curated swatches covering the hue wheel at two saturations,
// plus a freeform `<input type="color">` for anything else.
const ACCENT_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#22C55E',
  '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1',
  '#8B5CF6', '#A855F7', '#D946EF', '#EC4899', '#F43F5E', '#78716C',
  '#991B1B', '#9A3412', '#854D0E', '#166534', '#1E40AF', '#581C87',
]

// ── Add Account modal (multi-step) ───────────────────────────

type AddStep =
  | { kind: 'pick' }
  | { kind: 'manual' }
  | { kind: 'connecting'; broker: SnapBrokerage; url: string }
  | { kind: 'review'; broker: SnapBrokerage; snapAccounts: SnapBrokerAccount[] }

function AddAccountModal({
  open,
  onClose,
  existingAccounts,
}: {
  open: boolean
  onClose: () => void
  existingAccounts: Account[]
}) {
  const qc = useQueryClient()
  const [step, setStep] = useState<AddStep>({ kind: 'pick' })
  const [error, setError] = useState('')

  // Manual form state
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('TFSA')
  const [institution, setInstitution] = useState('')
  const [color, setColor] = useState(ACCENT_COLORS[0])

  // Review step: action per snap account
  const [importItems, setImportItems] = useState<
    Record<string, { action: 'create' | 'skip'; name: string; accountType: string }>
  >({})

  const { data: brokerages = [], isLoading: loadingBrokerages } = useQuery({
    queryKey: ['snaptrade-brokerages'],
    queryFn: snapApi.brokerages,
    staleTime: 86_400_000,
    enabled: open,
  })

  const currentBrokerRef = useRef<SnapBrokerage | null>(null)

  // Listen for OAuth callback postMessage to auto-advance
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'snaptrade-connected' && currentBrokerRef.current) {
        handleConnectDone(currentBrokerRef.current)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const registerMut = useMutation({ mutationFn: snapApi.register })

  const connectMut = useMutation({
    mutationFn: (body: { broker?: string; redirectUri?: string }) => snapApi.getConnectUrl(body),
  })

  const createManualMut = useMutation({
    mutationFn: accountsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      handleClose()
    },
  })

  const importMut = useMutation({
    mutationFn: (items: ImportAccountItem[]) => snapApi.importAccounts(items),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
      qc.invalidateQueries({ queryKey: ['snaptrade-status'] })
      handleClose()
    },
    onError: (e) => setError(String(e)),
  })

  function handleClose() {
    setStep({ kind: 'pick' })
    setError('')
    setName(''); setInstitution(''); setColor(ACCENT_COLORS[0]); setType('TFSA')
    setImportItems({})
    onClose()
  }

  async function handleBrokerClick(broker: SnapBrokerage) {
    setError('')
    try {
      await registerMut.mutateAsync()
      const redirectUri = `${window.location.origin}/snaptrade/callback`
      currentBrokerRef.current = broker
      const { url } = await connectMut.mutateAsync({ broker: broker.slug, redirectUri })
      window.open(url, '_blank', 'noopener,noreferrer,width=800,height=600')
      setStep({ kind: 'connecting', broker, url })
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleConnectDone(broker: SnapBrokerage) {
    setError('')
    try {
      const accs = await snapApi.brokerAccounts()
      // Show only unlinked accounts from this broker (institution_name match is approximate)
      const newAccs = accs.filter(a => !a.linkedTo)
      if (newAccs.length === 0) {
        setError('No new accounts found. Try refreshing or reconnecting.')
        return
      }
      // Init import items
      const init: typeof importItems = {}
      for (const a of newAccs) {
        init[a.id] = { action: 'create', name: a.name, accountType: a.type }
      }
      setImportItems(init)
      setStep({ kind: 'review', broker, snapAccounts: newAccs })
    } catch (e) {
      setError(String(e))
    }
  }

  function handleImport() {
    const items: ImportAccountItem[] = Object.entries(importItems).map(([snapAccountId, v]) => ({
      snapAccountId,
      action: v.action,
      name: v.name,
      accountType: v.accountType,
      institution: step.kind === 'review' ? step.broker.display_name : undefined,
    }))
    importMut.mutate(items)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg max-h-[85vh] flex flex-col">
          <div className="modal-pop bg-surface rounded-lg shadow-lg flex flex-col max-h-[85vh]">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
              {step.kind !== 'pick' && (
                <button
                  onClick={() => { setError(''); setStep({ kind: 'pick' }) }}
                  className="text-text-3 hover:text-text p-1 rounded mr-2"
                >
                  <ChevronRight size={16} className="rotate-180" />
                </button>
              )}
              <Dialog.Title className="text-section-h2 text-text flex-1">
                {step.kind === 'pick'      && 'Add Account'}
                {step.kind === 'manual'    && 'Manual Account'}
                {step.kind === 'connecting' && `Connect ${step.broker.display_name}`}
                {step.kind === 'review'    && 'Review Accounts'}
              </Dialog.Title>
              <button onClick={handleClose} className="text-text-3 hover:text-text p-1 rounded">
                <X size={16} />
              </button>
            </div>

            {error && (
              <div className="mx-6 mb-4 px-3 py-2 bg-down-soft text-down rounded-sm text-small flex-shrink-0">
                {error}
              </div>
            )}

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6">

              {/* ── Step: Broker picker ── */}
              {step.kind === 'pick' && (
                <div className="pb-6">
                  <p className="text-small text-text-3 mb-4">
                    Choose a broker to connect live data, or add a manual account.
                  </p>

                  {loadingBrokerages ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="h-20 rounded-md bg-surface-2 animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {brokerages.map((b) => (
                        <BrokerTile
                          key={b.id}
                          broker={b}
                          onClick={() => handleBrokerClick(b)}
                          loading={connectMut.isPending || registerMut.isPending}
                        />
                      ))}
                    </div>
                  )}

                  {/* Manual option */}
                  <button
                    onClick={() => setStep({ kind: 'manual' })}
                    className="mt-3 w-full flex items-center gap-3 px-4 py-3 rounded-md border border-dashed border-border hover:border-border-strong hover:bg-surface-2 transition-colors text-left"
                  >
                    <Building2 size={18} className="text-text-3" />
                    <div>
                      <p className="text-small font-medium text-text">Manual account</p>
                      <p className="text-micro text-text-3">Enter trades yourself — for Canada Life, private, or other</p>
                    </div>
                  </button>
                </div>
              )}

              {/* ── Step: Manual form ── */}
              {step.kind === 'manual' && (
                <div className="space-y-4 pb-6">
                  <div>
                    <label className="text-micro text-text-3 uppercase tracking-wider block mb-1.5">Account Name</label>
                    <input
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="e.g. My TFSA"
                      autoFocus
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
                          className={cn(
                            'px-3 py-1.5 rounded-sm text-[12.5px] font-medium border transition-colors',
                            type === t
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-border text-text-2 hover:border-border-strong'
                          )}
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
                      placeholder="e.g. Canada Life"
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
                          className={cn('w-7 h-7 rounded-full transition-transform', color === c ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105')}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end pt-2">
                    <Button variant="outline" onClick={() => setStep({ kind: 'pick' })}>Back</Button>
                    <Button
                      disabled={!name.trim() || createManualMut.isPending}
                      onClick={() => createManualMut.mutate({ name, type, institution, color, number: '' })}
                    >
                      {createManualMut.isPending ? 'Adding…' : 'Add Account'}
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Step: Connecting (waiting for OAuth) ── */}
              {step.kind === 'connecting' && (
                <div className="space-y-4 pb-6">
                  <div className="flex items-center gap-3 p-4 bg-surface-2 rounded-md">
                    {step.broker.aws_s3_logo_url ? (
                      <img src={step.broker.aws_s3_logo_url} alt="" className="w-10 h-10 object-contain rounded-sm" />
                    ) : (
                      <div className="w-10 h-10 rounded-sm bg-border flex items-center justify-center text-[10px] font-bold text-text-3">
                        {step.broker.display_name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <p className="text-small font-medium text-text">{step.broker.display_name}</p>
                      <p className="text-micro text-text-3">Authorization page opened in a new tab</p>
                    </div>
                  </div>

                  <p className="text-small text-text-2 leading-relaxed">
                    Complete the authorization in the new tab, then click <strong>Done</strong> to import your accounts.
                  </p>

                  <a
                    href={step.broker.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-small text-accent hover:underline w-fit"
                  >
                    <ExternalLink size={13} />
                    Re-open authorization page
                  </a>

                  <div className="flex gap-2 justify-end pt-2">
                    <Button variant="outline" onClick={() => setStep({ kind: 'pick' })}>Back</Button>
                    <Button onClick={() => handleConnectDone(step.broker)}>
                      Done — import accounts
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Step: Review / import accounts ── */}
              {step.kind === 'review' && (
                <div className="space-y-3 pb-6">
                  <p className="text-small text-text-3">
                    {step.snapAccounts.length} account{step.snapAccounts.length !== 1 ? 's' : ''} found. Choose what to do with each.
                  </p>

                  {step.snapAccounts.map((acc) => {
                    const item = importItems[acc.id] ?? { action: 'create', name: acc.name, accountType: acc.type }
                    return (
                      <div key={acc.id} className="border border-border rounded-md p-3 space-y-2">
                        <div>
                          <p className="text-small font-medium text-text">{acc.name}</p>
                          <p className="text-micro text-text-3">{acc.institution} {acc.number ? `· ${acc.number}` : ''} {acc.type ? `· ${acc.type}` : ''}</p>
                        </div>

                        {/* Action tabs */}
                        <div className="flex gap-1">
                          {(['create', 'skip'] as const).map(a => (
                            <button
                              key={a}
                              onClick={() => setImportItems(prev => ({
                                ...prev,
                                [acc.id]: { ...prev[acc.id], action: a, name: prev[acc.id]?.name ?? acc.name, accountType: prev[acc.id]?.accountType ?? acc.type }
                              }))}
                              className={cn(
                                'px-2.5 py-1 rounded-sm text-micro font-medium border transition-colors capitalize',
                                item.action === a
                                  ? 'border-accent bg-accent-soft text-accent'
                                  : 'border-border text-text-3 hover:border-border-strong'
                              )}
                            >
                              {a === 'create' ? 'Create new' : 'Skip'}
                            </button>
                          ))}
                        </div>

                        {/* Create: editable name */}
                        {item.action === 'create' && (
                          <input
                            value={item.name}
                            onChange={e => setImportItems(prev => ({ ...prev, [acc.id]: { ...prev[acc.id], name: e.target.value } }))}
                            placeholder="Account name"
                            className="w-full px-2.5 py-1.5 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent"
                          />
                        )}
                      </div>
                    )
                  })}

                  <div className="flex gap-2 justify-end pt-2">
                    <Button variant="outline" onClick={() => setStep({ kind: 'connecting', broker: step.broker, url: '' })}>Back</Button>
                    <Button
                      onClick={handleImport}
                      disabled={importMut.isPending}
                    >
                      {importMut.isPending ? 'Importing…' : 'Import accounts'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function BrokerTile({
  broker,
  onClick,
  loading,
}: {
  broker: SnapBrokerage
  onClick: () => void
  loading: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex flex-col items-center justify-center gap-2 px-2 py-3 rounded-md border border-border hover:border-accent hover:bg-accent-soft transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {broker.aws_s3_logo_url ? (
        <img
          src={broker.aws_s3_logo_url}
          alt={broker.display_name}
          className="w-full h-10 object-contain"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div className="w-full h-10 rounded-sm bg-surface-2 flex items-center justify-center text-[11px] font-bold text-text-3">
          {broker.display_name.slice(0, 3).toUpperCase()}
        </div>
      )}
      <span className="text-[11px] font-medium text-text text-center leading-tight line-clamp-2">
        {broker.display_name}
      </span>
    </button>
  )
}

// ── Delete confirmation dialog ───────────────────────────────

function DeleteConfirmDialog({
  account,
  onConfirm,
  onCancel,
  pending,
}: {
  account: Account
  onConfirm: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <Dialog.Root open onOpenChange={o => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm">
          <div className="bg-surface rounded-xl shadow-xl border border-border p-6">
            <Dialog.Title className="text-section-h2 text-text mb-1">Delete account?</Dialog.Title>
            <Dialog.Description className="text-small text-text-3 mb-5">
              <strong className="text-text">{account.name}</strong> and all its transactions, holdings, and nav history will be permanently removed.
            </Dialog.Description>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
              <Button
                className="bg-down hover:bg-down/90 text-white border-0"
                onClick={onConfirm}
                disabled={pending}
              >
                {pending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Sortable card wrapper ─────────────────────────────────────

function SortableCard({ id, children }: { id: string; children: (dragHandle: React.ReactNode) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  }
  const handle = (
    <button
      {...attributes}
      {...listeners}
      className="p-1 rounded text-text-3 hover:text-text-2 cursor-grab active:cursor-grabbing touch-none"
      title="Drag to reorder"
      tabIndex={-1}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/>
        <circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/>
        <circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/>
      </svg>
    </button>
  )
  return (
    <div ref={setNodeRef} style={style}>
      {children(handle)}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────

export function Accounts() {
  const { selectedAccountId, setSelectedAccountId } = useStore()
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)
  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [refreshMsg, setRefreshMsg] = useState<{ accountId: string; text: string; tone: 'ok' | 'warn' } | null>(null)

  const refreshOne = useCallback(async (acc: Account) => {
    if (refreshingId) return
    setRefreshingId(acc.id)
    setRefreshMsg(null)
    try {
      // IBKR accounts use the Flex Web Service; one call refreshes both IBKR
      // accounts at once (the API is statement-wide, not per-account).
      const isIbkr = acc.institution === 'Interactive Brokers'
      if (isIbkr) {
        const r = await ibkrFlexApi.sync()
        if (r.rateLimited) {
          setRefreshMsg({ accountId: acc.id, text: `Wait ${r.retryAfter}s`, tone: 'warn' })
        } else {
          const parts: string[] = []
          const txTotal = r.trades_inserted + r.cash_inserted
          if (txTotal) parts.push(`+${txTotal} tx`)
          parts.push(`${r.positions_upserted} pos`)
          if (r.positions_culled) parts.push(`-${r.positions_culled} closed`)
          setRefreshMsg({ accountId: acc.id, text: parts.join(' · ') || 'Up to date', tone: 'ok' })
          qc.invalidateQueries({ queryKey: ['transactions'] })
          qc.invalidateQueries({ queryKey: ['holdings'] })
          qc.invalidateQueries({ queryKey: ['accounts'] })
        }
      } else {
        const r = await snapApi.syncAccount(acc.id)
        if (r.rateLimited) {
          setRefreshMsg({ accountId: acc.id, text: `Wait ${r.retryAfter}s`, tone: 'warn' })
        } else {
          const parts: string[] = []
          if (r.activities_inserted) parts.push(`+${r.activities_inserted} tx`)
          parts.push(`${r.positions_upserted} pos`)
          if (r.positions_culled) parts.push(`-${r.positions_culled} closed`)
          setRefreshMsg({ accountId: acc.id, text: parts.join(' · ') || 'Up to date', tone: 'ok' })
          qc.invalidateQueries({ queryKey: ['transactions'] })
          qc.invalidateQueries({ queryKey: ['holdings'] })
          qc.invalidateQueries({ queryKey: ['accounts'] })
        }
      }
    } catch (e) {
      setRefreshMsg({ accountId: acc.id, text: String(e), tone: 'warn' })
    } finally {
      setRefreshingId(null)
      setTimeout(() => setRefreshMsg(curr => curr?.accountId === acc.id ? null : curr), 3500)
    }
  }, [refreshingId, qc])

  const { data: accs = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  })

  // Keep local order in sync when server data arrives (only on first load / external change)
  useEffect(() => {
    if (accs.length > 0) setOrderedIds(accs.map(a => a.id))
  }, [accs.map(a => a.id).join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const orderedAccs = useMemo(() => {
    if (orderedIds.length === 0) return accs
    const map = Object.fromEntries(accs.map(a => [a.id, a]))
    return orderedIds.map(id => map[id]).filter(Boolean)
  }, [accs, orderedIds])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const reorderMut = useMutation({ mutationFn: accountsApi.reorder })

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrderedIds(prev => {
      const oldIdx = prev.indexOf(active.id as string)
      const newIdx = prev.indexOf(over.id as string)
      const next = arrayMove(prev, oldIdx, newIdx)
      reorderMut.mutate(next)
      return next
    })
  }, [reorderMut])

  const { data: allHoldings = [] } = useQuery({
    queryKey: ['holdings', null],
    queryFn: () => holdingsApi.list(undefined),
  })

  const valueByAccount = useMemo(() => {
    const m: Record<string, { value: number; pnl: number }> = {}
    for (const acc of accs) {
      const ah = allHoldings.filter(h => h.account_id === acc.id)
      const value = ah.reduce((s, h) => s + h.qty * h.px * (h.multiplier ?? 1), 0)
      const cost  = ah.reduce((s, h) => s + h.qty * h.cost * (h.multiplier ?? 1), 0)
      m[acc.id] = { value, pnl: value - cost }
    }
    return m
  }, [allHoldings, accs])

  const deleteMutation = useMutation({
    mutationFn: accountsApi.delete,
    onSuccess: (_, id) => {
      if (selectedAccountId === id) setSelectedAccountId(null)
      qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const updateColorMut = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => accountsApi.update(id, { color }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => accountsApi.update(id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setEditingId(null)
    },
  })

  const updateTypeMut = useMutation({
    mutationFn: ({ id, type }: { id: string; type: AccountType }) => accountsApi.update(id, { type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })

  function startEdit(id: string, currentName: string) {
    setEditingId(id)
    setDraftName(currentName)
  }
  function saveEdit() {
    const name = draftName.trim()
    if (editingId && name && name !== accs.find(a => a.id === editingId)?.name) {
      renameMutation.mutate({ id: editingId, name })
    } else {
      setEditingId(null)
    }
  }

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-page-title text-text">Accounts</h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add Account
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedIds} strategy={rectSortingStrategy}>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {orderedAccs.map(acc => {
          const isLive = !!acc.snaptrade_account_id || acc.institution === 'Interactive Brokers'
          return (
            <SortableCard key={acc.id} id={acc.id}>{(dragHandle) => (
            <div
              className="group relative bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200"
            >
              {editingId !== acc.id && (
                <div className="absolute top-3 right-3 flex gap-1 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity bg-surface/95 backdrop-blur-sm rounded-md px-1 py-0.5 shadow-sm">
                  {dragHandle}
                  {isLive && (
                    <button
                      onClick={e => { e.stopPropagation(); refreshOne(acc) }}
                      disabled={refreshingId === acc.id}
                      className="p-1 rounded hover:text-accent text-text-3 disabled:opacity-50"
                      title="Refresh now (positions, balances, recent activities)"
                    >
                      <RefreshCw size={13} className={refreshingId === acc.id ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); startEdit(acc.id, acc.name) }}
                    className="p-1 rounded hover:text-accent text-text-3"
                    title="Rename"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteTarget(acc) }}
                    className="p-1 rounded hover:text-down text-text-3"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3 mb-3">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      onClick={e => e.stopPropagation()}
                      title="Change color"
                      className="block flex-shrink-0 rounded focus:outline-none"
                    >
                      <AccountTypeBadge type={acc.type} color={acc.color} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={6}
                      className="z-50 bg-surface border border-border rounded-lg shadow-lg p-2.5 w-[212px]"
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="grid grid-cols-6 gap-1.5">
                        {ACCENT_COLORS.map(c => (
                          <button
                            key={c}
                            onClick={() => updateColorMut.mutate({ id: acc.id, color: c })}
                            title={c}
                            className="w-7 h-7 rounded-md transition-transform hover:scale-110 active:scale-95"
                            style={{
                              backgroundColor: c,
                              outline: c === acc.color ? `2px solid ${c}` : '2px solid transparent',
                              outlineOffset: 1,
                            }}
                          />
                        ))}
                      </div>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <div className="flex-1 min-w-0">
                  {editingId === acc.id ? (
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={draftName}
                        onChange={e => setDraftName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        disabled={renameMutation.isPending}
                        className="font-semibold text-text text-small bg-surface-2 border border-border rounded-sm px-1.5 py-0.5 flex-1 min-w-0 focus:outline-none focus:border-accent"
                      />
                      <button onClick={saveEdit} disabled={renameMutation.isPending} className="text-up p-0.5 hover:bg-up/10 rounded-sm" title="Save">
                        <Check size={13} />
                      </button>
                      <button onClick={() => setEditingId(null)} disabled={renameMutation.isPending} className="text-text-3 p-0.5 hover:bg-surface-2 rounded-sm" title="Cancel">
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <p className="font-semibold text-text text-small truncate">{acc.name}</p>
                  )}
                  <p className="text-[11px] text-text-3">{acc.institution}</p>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      onClick={e => e.stopPropagation()}
                      className="text-[11px] px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity data-[state=open]:ring-2 data-[state=open]:ring-offset-1 data-[state=open]:ring-offset-surface focus:outline-none"
                      style={{
                        background: `${acc.color}20`,
                        color: acc.color,
                        ['--tw-ring-color' as string]: acc.color,
                      } as React.CSSProperties}
                      title="Click to change account type"
                    >
                      {acc.type}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={6}
                      className="z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[120px]"
                      onClick={e => e.stopPropagation()}
                    >
                      {ACCOUNT_TYPES.map(t => (
                        <DropdownMenu.Item
                          key={t}
                          onSelect={() => updateTypeMut.mutate({ id: acc.id, type: t as AccountType })}
                          className={cn(
                            'text-[11.5px] px-3 py-1.5 transition-colors cursor-pointer outline-none',
                            t === acc.type
                              ? 'font-semibold'
                              : 'text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text'
                          )}
                          style={t === acc.type ? { color: acc.color, background: `${acc.color}12` } : undefined}
                        >
                          {t}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {isLive && (
                  <span
                    className="flex items-center gap-1 text-[10px] text-up font-medium"
                    title={acc.last_synced_at
                      ? `Last synced ${formatRelativeTime(acc.last_synced_at)}`
                      : 'Not yet synced — click ↻ to refresh'}
                  >
                    <Wifi size={10} />
                    {acc.last_synced_at ? `Synced ${formatRelativeShort(acc.last_synced_at)}` : 'Live'}
                  </span>
                )}
              </div>

              {(valueByAccount[acc.id]?.value ?? 0) > 0.01 && (
                <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between">
                  <span className="text-[11px] text-text-3">Portfolio value</span>
                  <div className="text-right">
                    <p className="tabular text-small font-semibold text-text private-val">
                      {fmt(valueByAccount[acc.id].value)}
                    </p>
                    <p className={cn('tabular text-[11px]', valueByAccount[acc.id].pnl >= 0 ? 'text-up' : 'text-down')}>
                      <span className="private-val">
                        {valueByAccount[acc.id].pnl >= 0 ? '+' : ''}{fmt(valueByAccount[acc.id].pnl)}
                      </span>
                    </p>
                  </div>
                </div>
              )}

              {refreshMsg?.accountId === acc.id && (
                <div
                  className={cn(
                    'absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-medium shadow-md pointer-events-none tabular animate-in fade-in slide-in-from-bottom-1 duration-200',
                    refreshMsg.tone === 'ok' ? 'bg-up text-white' : 'bg-warn text-white'
                  )}
                >
                  {refreshMsg.text}
                </div>
              )}
            </div>
          )}</SortableCard>
          )
        })}

        {accs.length === 0 && (
          <div className="col-span-3 text-center py-12 text-text-3 text-small">
            No accounts yet. Click <strong>Add Account</strong> to get started.
          </div>
        )}
      </div>
        </SortableContext>
      </DndContext>

      {selectedAccountId && (
        <p className="text-small text-text-3 mt-4">
          Filtering by <strong className="text-text">{accs.find(a => a.id === selectedAccountId)?.name}</strong>.{' '}
          <button className="text-accent underline" onClick={() => setSelectedAccountId(null)}>Clear filter</button>
        </p>
      )}

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} existingAccounts={accs} />
      {deleteTarget && (
        <DeleteConfirmDialog
          account={deleteTarget}
          pending={deleteMutation.isPending}
          onConfirm={() => {
            deleteMutation.mutate(deleteTarget.id, {
              onSuccess: () => setDeleteTarget(null),
            })
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
