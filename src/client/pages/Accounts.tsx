import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check, Pencil, Plus, Trash2, X, Wifi,
  ExternalLink, ChevronRight, Building2, ArrowDownToLine,
  ChevronDown, AlertCircle,
} from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  accounts as accountsApi,
  holdings as holdingsApi,
  snaptrade as snapApi,
} from '@/lib/api'
import type { SnapBrokerage, SnapBrokerAccount, ImportAccountItem, SyncActivity, SyncD1Only } from '@/lib/api'
import { useStore } from '@/lib/store'
import { AccountTypeBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Account, AccountType } from '@shared/types'

const ACCOUNT_TYPES: AccountType[] = [
  'Brokerage', 'Roth IRA', 'Traditional IRA', '401k', 'HSA',
  'RRSP', 'TFSA', 'FHSA', 'RESP', 'Crypto',
]

const ACCENT_COLORS = [
  '#10B981', '#3B82F6', '#7C3AED', '#F97316', '#F59E0B', '#06B6D4', '#EC4899', '#A1A1AA',
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

// ── Sync Modal ───────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  buy: 'Buy', sell: 'Sell', dividend: 'Div', interest: 'Int',
  deposit: 'Dep', withdraw: 'Wdw', transfer: 'Xfer',
  transfer_in: 'Xfer In', transfer_out: 'Xfer Out',
}

function fmtDate(s: string) {
  return s ? new Date(s + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'
}

function SyncModal({
  account,
  open,
  onClose,
}: {
  account: Account
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const oneYearAgo = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)

  const [startDate, setStartDate] = useState(oneYearAgo)
  const [endDate, setEndDate]     = useState(today)
  const [preview, setPreview]     = useState<{ activities: SyncActivity[]; d1Only: SyncD1Only[] } | null>(null)
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [showMatched, setShowMatched]   = useState(false)
  const [showD1Only, setShowD1Only]     = useState(false)
  const [loading, setLoading]     = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError]         = useState('')
  const [importedCount, setImportedCount] = useState<number | null>(null)

  async function loadPreview() {
    setLoading(true); setError(''); setPreview(null); setSelected(new Set()); setImportedCount(null)
    try {
      const data = await snapApi.syncPreview(account.id, startDate, endDate)
      setPreview(data)
      // Auto-select all unmatched
      setSelected(new Set(data.activities.filter(a => !a.matched).map(a => a.id)))
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  async function handleImport() {
    if (!preview || selected.size === 0) return
    setImporting(true); setError('')
    try {
      const res = await snapApi.syncImport(account.id, [...selected], startDate, endDate)
      setImportedCount(res.imported)
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['holdings'] })
      // Refresh preview so imported items now show as matched
      const data = await snapApi.syncPreview(account.id, startDate, endDate)
      setPreview(data)
      setSelected(new Set())
    } catch (e) { setError(String(e)) }
    finally { setImporting(false) }
  }

  function toggleAll(unmatched: SyncActivity[]) {
    if (selected.size === unmatched.length) setSelected(new Set())
    else setSelected(new Set(unmatched.map(a => a.id)))
  }

  function handleClose() {
    setPreview(null); setSelected(new Set()); setError(''); setImportedCount(null)
    onClose()
  }

  const unmatched = preview?.activities.filter(a => !a.matched) ?? []
  const matched   = preview?.activities.filter(a => a.matched) ?? []

  return (
    <Dialog.Root open={open} onOpenChange={o => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl max-h-[88vh] flex flex-col">
          <div className="bg-surface rounded-lg shadow-lg flex flex-col max-h-[88vh]">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border flex-shrink-0">
              <div>
                <Dialog.Title className="text-section-h2 text-text">Sync Transactions</Dialog.Title>
                <p className="text-micro text-text-3 mt-0.5">{account.name} · {account.institution}</p>
              </div>
              <button onClick={handleClose} className="text-text-3 hover:text-text p-1 rounded">
                <X size={16} />
              </button>
            </div>

            {/* Date range + load */}
            <div className="px-6 py-4 flex items-center gap-3 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="date" value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="px-2.5 py-1.5 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent"
                />
                <span className="text-text-3 text-small">to</span>
                <input
                  type="date" value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="px-2.5 py-1.5 rounded-sm border border-border bg-surface-2 text-text text-small focus:outline-none focus:border-accent"
                />
              </div>
              <Button onClick={loadPreview} disabled={loading}>
                {loading ? 'Loading…' : 'Load comparison'}
              </Button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">

              {error && (
                <div className="mx-6 mt-4 px-3 py-2 bg-down-soft text-down rounded-sm text-small flex items-center gap-2">
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              {importedCount !== null && (
                <div className="mx-6 mt-4 px-3 py-2 bg-up/10 text-up rounded-sm text-small font-medium">
                  ✓ Imported {importedCount} transaction{importedCount !== 1 ? 's' : ''} successfully
                </div>
              )}

              {preview && (
                <div className="px-6 py-4 space-y-4">

                  {/* Summary pills */}
                  <div className="flex gap-2 flex-wrap">
                    <span className="px-2.5 py-1 rounded-full bg-surface-2 text-text-2 text-micro">
                      {preview.activities.length} broker activities
                    </span>
                    <span className="px-2.5 py-1 rounded-full bg-up/10 text-up text-micro font-medium">
                      {matched.length} already recorded
                    </span>
                    {unmatched.length > 0 && (
                      <span className="px-2.5 py-1 rounded-full bg-accent/10 text-accent text-micro font-medium">
                        {unmatched.length} missing
                      </span>
                    )}
                    {preview.d1Only.length > 0 && (
                      <span className="px-2.5 py-1 rounded-full bg-surface-2 text-text-3 text-micro">
                        {preview.d1Only.length} manual-only
                      </span>
                    )}
                  </div>

                  {/* Unmatched section */}
                  {unmatched.length === 0 ? (
                    <div className="text-center py-6 text-text-3 text-small">
                      ✓ All broker activities are already in your records
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-small font-semibold text-text">
                          Missing from your records
                        </h3>
                        <button
                          onClick={() => toggleAll(unmatched)}
                          className="text-micro text-accent hover:underline"
                        >
                          {selected.size === unmatched.length ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                      <div className="border border-border rounded-md overflow-hidden">
                        {unmatched.map((a, i) => (
                          <label
                            key={a.id}
                            className={cn(
                              'flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-2 transition-colors',
                              i > 0 && 'border-t border-border',
                              selected.has(a.id) && 'bg-accent/5',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(a.id)}
                              onChange={e => {
                                const s = new Set(selected)
                                e.target.checked ? s.add(a.id) : s.delete(a.id)
                                setSelected(s)
                              }}
                              className="accent-accent"
                            />
                            <span className="text-micro text-text-3 w-20 flex-shrink-0">{fmtDate(a.date)}</span>
                            <span className={cn(
                              'text-micro font-medium px-1.5 py-0.5 rounded-sm w-14 text-center flex-shrink-0',
                              a.txType === 'buy'  ? 'bg-up/10 text-up' :
                              a.txType === 'sell' ? 'bg-down/10 text-down' :
                              a.txType === 'dividend' || a.txType === 'interest' ? 'bg-accent/10 text-accent' :
                              'bg-surface-2 text-text-3'
                            )}>
                              {TYPE_LABELS[a.txType] ?? a.type}
                            </span>
                            <span className="text-small text-text font-medium flex-1 min-w-0 truncate">
                              {a.symbol ?? a.description ?? '—'}
                            </span>
                            {a.qty > 0 && (
                              <span className="text-micro text-text-3 flex-shrink-0">
                                {a.qty % 1 === 0 ? a.qty : a.qty.toFixed(4)} sh
                                {a.price > 0 ? ` @ $${a.price.toFixed(2)}` : ''}
                              </span>
                            )}
                            <span className="text-small font-semibold text-text tabular flex-shrink-0 w-20 text-right">
                              ${a.total.toFixed(2)}
                            </span>
                            <span className="text-micro text-text-3 flex-shrink-0 w-8">{a.currency}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Already matched — collapsible */}
                  {matched.length > 0 && (
                    <div>
                      <button
                        onClick={() => setShowMatched(v => !v)}
                        className="flex items-center gap-1.5 text-small text-text-3 hover:text-text transition-colors"
                      >
                        <ChevronDown size={14} className={cn('transition-transform', showMatched && 'rotate-180')} />
                        Already in your records ({matched.length})
                      </button>
                      {showMatched && (
                        <div className="mt-2 border border-border rounded-md overflow-hidden opacity-60">
                          {matched.map((a, i) => (
                            <div key={a.id} className={cn('flex items-center gap-3 px-3 py-2 text-micro', i > 0 && 'border-t border-border')}>
                              <Check size={12} className="text-up flex-shrink-0" />
                              <span className="text-text-3 w-20 flex-shrink-0">{fmtDate(a.date)}</span>
                              <span className="text-text-3 w-14 flex-shrink-0">{TYPE_LABELS[a.txType] ?? a.type}</span>
                              <span className="text-text flex-1 truncate">{a.symbol ?? a.description ?? '—'}</span>
                              <span className="text-text-3 w-20 text-right">${a.total.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* D1-only — collapsible */}
                  {preview.d1Only.length > 0 && (
                    <div>
                      <button
                        onClick={() => setShowD1Only(v => !v)}
                        className="flex items-center gap-1.5 text-small text-text-3 hover:text-text transition-colors"
                      >
                        <ChevronDown size={14} className={cn('transition-transform', showD1Only && 'rotate-180')} />
                        Manual-only entries ({preview.d1Only.length}) — not found in broker data
                      </button>
                      {showD1Only && (
                        <div className="mt-2 border border-border rounded-md overflow-hidden">
                          {preview.d1Only.map((tx, i) => (
                            <div key={tx.id} className={cn('flex items-center gap-3 px-3 py-2 text-micro', i > 0 && 'border-t border-border')}>
                              <span className="text-text-3 w-20 flex-shrink-0">{fmtDate(tx.date)}</span>
                              <span className="text-text-3 w-14 flex-shrink-0">{TYPE_LABELS[tx.type] ?? tx.type}</span>
                              <span className="text-text flex-1 truncate">{tx.symbol ?? '—'}</span>
                              <span className="text-text-3 w-20 text-right">${tx.total.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!preview && !loading && !error && (
                <div className="px-6 py-10 text-center text-text-3 text-small">
                  Set a date range and click <strong className="text-text">Load comparison</strong> to see what's missing.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border flex items-center justify-between flex-shrink-0">
              <span className="text-micro text-text-3">
                {selected.size > 0 ? `${selected.size} selected to import` : ''}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleClose}>Cancel</Button>
                <Button
                  onClick={handleImport}
                  disabled={selected.size === 0 || importing}
                >
                  <ArrowDownToLine size={14} />
                  {importing ? 'Importing…' : `Import ${selected.size > 0 ? selected.size : ''} selected`}
                </Button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Main page ─────────────────────────────────────────────────

export function Accounts() {
  const { selectedAccountId, setSelectedAccountId } = useStore()
  const qc = useQueryClient()
  const { fmt } = useMoney()
  const [addOpen, setAddOpen] = useState(false)
  const [syncAccount, setSyncAccount] = useState<Account | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [editingTypeId, setEditingTypeId] = useState<string | null>(null)
  const [editingColorId, setEditingColorId] = useState<string | null>(null)

  const { data: accs = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  })

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setEditingColorId(null)
    },
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      setEditingTypeId(null)
    },
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {accs.map(acc => {
          const isLive = !!acc.snaptrade_account_id
          return (
            <div
              key={acc.id}
              className="group relative bg-surface rounded-2xl shadow-md dark:shadow-none border border-transparent dark:border-border card-mobile-flush p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200"
              onClick={() => { if (editingColorId === acc.id) setEditingColorId(null) }}
            >
              {editingId !== acc.id && (
                <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {isLive && (
                    <button
                      onClick={e => { e.stopPropagation(); setSyncAccount(acc) }}
                      className="p-1 rounded hover:text-accent text-text-3"
                      title="Sync transactions from broker"
                    >
                      <ArrowDownToLine size={13} />
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
                    onClick={e => {
                      e.stopPropagation()
                      if (confirm(`Delete "${acc.name}"? This won't delete its transactions.`)) {
                        deleteMutation.mutate(acc.id)
                      }
                    }}
                    className="p-1 rounded hover:text-down text-text-3"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3 mb-3">
                <div className="relative flex-shrink-0">
                  <button
                    onClick={e => { e.stopPropagation(); setEditingColorId(editingColorId === acc.id ? null : acc.id) }}
                    title="Change color"
                    className="block"
                  >
                    <AccountTypeBadge type={acc.type} color={acc.color} />
                  </button>
                  {editingColorId === acc.id && (
                    <div
                      className="absolute top-full left-0 mt-1 z-20 bg-surface border border-border rounded-lg shadow-lg p-2"
                      style={{ width: 148 }}
                      onClick={e => e.stopPropagation()}
                    >
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                        {ACCENT_COLORS.map(c => (
                          <button
                            key={c}
                            onClick={() => updateColorMut.mutate({ id: acc.id, color: c })}
                            title={c}
                            style={{
                              width: 28, height: 28,
                              backgroundColor: c,
                              borderRadius: 6,
                              outline: c === acc.color ? `2px solid ${c}` : '2px solid transparent',
                              outlineOffset: 2,
                              flexShrink: 0,
                              transition: 'transform 0.1s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.15)')}
                            onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
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
                {editingTypeId === acc.id ? (
                  <select
                    autoFocus
                    defaultValue={ACCOUNT_TYPES.includes(acc.type as AccountType) ? acc.type : ''}
                    onChange={e => {
                      if (e.target.value) updateTypeMut.mutate({ id: acc.id, type: e.target.value as AccountType })
                    }}
                    onBlur={() => setEditingTypeId(null)}
                    className="text-[11px] px-2 py-0.5 rounded-full border-0 focus:outline-none cursor-pointer"
                    style={{ background: `${acc.color}20`, color: acc.color }}
                  >
                    {!ACCOUNT_TYPES.includes(acc.type as AccountType) && (
                      <option value="">{acc.type}</option>
                    )}
                    {ACCOUNT_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                ) : (
                  <button
                    onClick={() => setEditingTypeId(acc.id)}
                    className="text-[11px] px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
                    style={{ background: `${acc.color}20`, color: acc.color }}
                    title="Click to change account type"
                  >
                    {acc.type}
                  </button>
                )}
                <div className="flex items-center gap-1.5">
                  {isLive && (
                    <span className="flex items-center gap-0.5 text-[10px] text-up font-medium">
                      <Wifi size={10} />
                      Live
                    </span>
                  )}
                  <span className="text-[11px] text-text-3 tabular">{acc.number}</span>
                </div>
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
            </div>
          )
        })}

        {accs.length === 0 && (
          <div className="col-span-3 text-center py-12 text-text-3 text-small">
            No accounts yet. Click <strong>Add Account</strong> to get started.
          </div>
        )}
      </div>

      {selectedAccountId && (
        <p className="text-small text-text-3 mt-4">
          Filtering by <strong className="text-text">{accs.find(a => a.id === selectedAccountId)?.name}</strong>.{' '}
          <button className="text-accent underline" onClick={() => setSelectedAccountId(null)}>Clear filter</button>
        </p>
      )}

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} existingAccounts={accs} />
      {syncAccount && (
        <SyncModal account={syncAccount} open={true} onClose={() => setSyncAccount(null)} />
      )}
    </div>
  )
}
