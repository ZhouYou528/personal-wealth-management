import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, X, ChevronDown } from 'lucide-react'
import { creditCards as api, fx as fxApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import type { CreditCard } from '@shared/types'

// ── CPP (cents per point) valuation ──────────────────────────
const CPP: Record<string, number> = {
  MR: 0.018, UR: 0.02, C1: 0.017, TYP: 0.017,
  Aeroplan: 0.015, Avion: 0.012, ScenePlus: 0.01, Cash: 0.01,
}
const CPP_LABEL: Record<string, string> = {
  MR: 'Amex MR', UR: 'Chase UR', C1: 'Capital One', TYP: 'Citi TYP',
  Aeroplan: 'Aeroplan', Avion: 'RBC Avion', ScenePlus: 'Scene+', Cash: 'Cash Back',
}

const PALETTES: [string, string, string][] = [
  ['#2a4a8a', '#1a2f5e', 'Navy'],
  ['#b8860b', '#7a5b0a', 'Gold'],
  ['#5a6473', '#2c333d', 'Slate'],
  ['#1d6b4a', '#0f4530', 'Forest'],
  ['#0d4f63', '#06303d', 'Ocean'],
  ['#7c3a52', '#4a1f30', 'Burgundy'],
  ['#a33636', '#5e1d1d', 'Crimson'],
  ['#1f4ba0', '#0f2c63', 'Royal'],
  ['#1f2a37', '#0f1620', 'Onyx'],
]

// ── Enrichment ────────────────────────────────────────────────
interface EnrichedCard extends CreditCard {
  ageMonths:       number
  renewalDate:     string | null
  renewalDaysLeft: number | null
  bonusPotential:  number
  pointsValue:     number
  msPct:           number
  msRemaining:     number
  msDaysLeft:      number | null
  msActive:        boolean
}

function enrichCard(card: CreditCard): EnrichedCard {
  const today = new Date()
  const open  = new Date(card.open_date)
  const ageMonths = Math.floor((today.getTime() - open.getTime()) / (30.44 * 86400000))

  let renewalDate: string | null = null
  let renewalDaysLeft: number | null = null
  if (card.status === 'active') {
    const rDate = new Date(open)
    rDate.setFullYear(rDate.getFullYear() + (card.first_year_free ? 2 : 1))
    while (rDate <= today) rDate.setFullYear(rDate.getFullYear() + 1)
    renewalDate     = rDate.toISOString().slice(0, 10)
    renewalDaysLeft = Math.ceil((rDate.getTime() - today.getTime()) / 86400000)
  }

  const cpp = CPP[card.currency] ?? 0.01
  const msRemaining = Math.max(0, card.min_spend_req - card.min_spend_current)
  const msPct       = card.min_spend_req > 0
    ? Math.min(100, (card.min_spend_current / card.min_spend_req) * 100) : 0
  const msDaysLeft  = card.min_spend_deadline
    ? Math.ceil((new Date(card.min_spend_deadline).getTime() - today.getTime()) / 86400000)
    : null
  const msActive = !card.bonus_met && card.min_spend_req > 0 && card.min_spend_current < card.min_spend_req

  return {
    ...card, ageMonths, renewalDate, renewalDaysLeft,
    bonusPotential: card.bonus * cpp, pointsValue: card.points_balance * cpp,
    msPct, msRemaining, msDaysLeft, msActive,
  }
}

interface Analytics {
  activeCount:      number
  cancelledCount:   number
  totalAnnualFees:  number
  netReturn:        number
  fiveTwentyFour:   number
  unredeemedValue:  number
  openMinSpends:    EnrichedCard[]
  upcomingRenewals: EnrichedCard[]
  pointsByProgram:  Record<string, { label: string; pts: number; value: number }>
}

function analyzeCards(cards: EnrichedCard[]): Analytics {
  const today  = new Date()
  const cutoff = new Date(today); cutoff.setMonth(cutoff.getMonth() - 24)
  const active = cards.filter(c => c.status === 'active')

  const totalAnnualFees  = active.reduce((s, c) => s + c.annual_fee, 0)
  const totalPointsValue = active.reduce((s, c) => s + c.pointsValue, 0)
  const unredeemedValue  = cards.reduce((s, c) => s + c.pointsValue, 0)

  const openMinSpends    = active.filter(c => c.msActive).sort((a, b) => (a.msDaysLeft ?? 999) - (b.msDaysLeft ?? 999))
  const upcomingRenewals = active.filter(c => (c.renewalDaysLeft ?? 999) <= 60).sort((a, b) => (a.renewalDaysLeft ?? 999) - (b.renewalDaysLeft ?? 999))
  const fiveTwentyFour   = cards.filter(c => c.market === 'US' && new Date(c.open_date) >= cutoff).length

  const pointsByProgram: Record<string, { label: string; pts: number; value: number }> = {}
  for (const c of cards) {
    if (c.points_balance <= 0) continue
    if (!pointsByProgram[c.currency]) pointsByProgram[c.currency] = { label: CPP_LABEL[c.currency] ?? c.currency, pts: 0, value: 0 }
    pointsByProgram[c.currency].pts   += c.points_balance
    pointsByProgram[c.currency].value += c.pointsValue
  }

  return {
    activeCount: active.length, cancelledCount: cards.length - active.length,
    totalAnnualFees, netReturn: totalPointsValue - totalAnnualFees,
    fiveTwentyFour, unredeemedValue, openMinSpends, upcomingRenewals, pointsByProgram,
  }
}

// ── Formatters ────────────────────────────────────────────────
const fmt$ = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const fmtPts = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n)
const fmtDate = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

// ── Shared components ─────────────────────────────────────────

function StatusBadge({ tone, children }: { tone: 'up' | 'down' | 'warn' | 'neutral'; children: React.ReactNode }) {
  const cls = {
    up:      'bg-up-soft text-up',
    down:    'bg-down-soft text-down',
    warn:    'bg-warn/10 text-warn',
    neutral: 'bg-surface-2 text-text-2',
  }[tone]
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-xs text-micro font-semibold', cls)}>
      {children}
    </span>
  )
}

function Bar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'warn' | 'down' }) {
  const fill = { accent: 'bg-accent', warn: 'bg-warn', down: 'bg-down' }[tone]
  return (
    <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden">
      <div className={cn('h-full rounded-full transition-all duration-300', fill)} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

// ── Card tile (gradient face) ─────────────────────────────────

interface CardFaceProps {
  name: string; issuer: string; network: string
  market: string; bureau: string
  c1: string; c2: string
  cancelled?: boolean; msActive?: boolean; bonus_met?: boolean
}

function CardFace({ name, issuer, network, market, bureau, c1, c2, cancelled, msActive, bonus_met }: CardFaceProps) {
  return (
    <div
      className={cn('relative w-full aspect-[1.586/1] rounded-md overflow-hidden', cancelled && 'opacity-50 grayscale')}
      style={{ background: `linear-gradient(150deg, ${c1}, ${c2})` }}
    >
      <div className="absolute inset-0 rounded-md bg-white/5" />
      <div className="absolute top-3 left-3 right-3 flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-white/55 text-[8px] sm:text-[10px] uppercase tracking-widest leading-none truncate">{issuer || 'Issuer'}</div>
          <div className="text-white font-bold text-[10px] sm:text-[14px] leading-snug mt-0.5 truncate">{name || 'Card name'}</div>
        </div>
        <span className="text-white/40 text-[8px] sm:text-[10px] font-bold uppercase bg-white/10 px-1 py-0.5 rounded-[3px] shrink-0 whitespace-nowrap">{network}</span>
      </div>
      <div className="absolute bottom-2.5 left-3 right-3 flex items-end justify-between gap-1">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[9px] sm:text-[11px] shrink-0">{market === 'US' ? '🇺🇸' : '🇨🇦'}</span>
          <span className="text-white/40 text-[8px] sm:text-[10px] font-mono truncate hidden sm:block">{bureau}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {msActive   && <span className="text-white/80 text-[8px] sm:text-[10px] bg-warn/50 px-1 py-0.5 rounded-[3px] font-medium whitespace-nowrap">Spend</span>}
          {cancelled  && <span className="text-white/60 text-[8px] sm:text-[10px] border border-white/25 px-1 py-0.5 rounded-[3px] font-semibold uppercase tracking-wide whitespace-nowrap">Closed</span>}
          {bonus_met && !cancelled && <span className="text-white/80 text-[8px] sm:text-[10px] bg-up/40 px-1 py-0.5 rounded-[3px] font-medium whitespace-nowrap">✓ SUB</span>}
        </div>
      </div>
    </div>
  )
}

function CardTile({ card, onClick }: { card: EnrichedCard; onClick: () => void }) {
  return (
    <button onClick={onClick} className="relative w-full transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
      <CardFace
        name={card.name} issuer={card.issuer} network={card.network}
        market={card.market} bureau={card.bureau} c1={card.c1} c2={card.c2}
        cancelled={card.status === 'cancelled'} msActive={card.msActive} bonus_met={!!card.bonus_met}
      />
    </button>
  )
}

// ── KPI stat card ─────────────────────────────────────────────

function KpiCard({ label, value, sub, tone = 'default', onClick }: {
  label: string; value: React.ReactNode; sub?: string
  tone?: 'default' | 'up' | 'warn' | 'down'; onClick?: () => void
}) {
  const valCls = { default: 'text-text', up: 'text-up', warn: 'text-warn', down: 'text-down' }[tone]
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'bg-surface border border-border rounded-md px-4 py-3 flex flex-col gap-0.5 min-w-0 text-left w-full',
        onClick && 'hover:border-border-strong hover:shadow-sm transition-all cursor-pointer'
      )}
    >
      <span className="text-micro text-text-3 uppercase tracking-wider">{label}</span>
      <span className={cn('font-display text-[22px] font-semibold tabular leading-tight', valCls)}>{value}</span>
      {sub && <span className={cn('text-micro', onClick ? 'text-accent' : 'text-text-3')}>{sub}</span>}
    </Comp>
  )
}

// ── Action center (right rail) ────────────────────────────────

function ActionCenter({ analytics }: { analytics: Analytics }) {
  const items: { key: string; tone: 'up' | 'down' | 'warn'; icon: string; title: string; body: string; meta: string; sub: string }[] = []

  analytics.openMinSpends.forEach(c => {
    const urgent = (c.msDaysLeft ?? 999) <= 30
    items.push({
      key: `ms-${c.id}`, tone: urgent ? 'warn' : 'up', icon: '🎯',
      title: `${c.issuer} ${c.name}`,
      body: `$${c.msRemaining.toFixed(0)} more to meet min spend`,
      meta: `${c.msDaysLeft ?? '?'}d`,
      sub: `Bonus ${fmtPts(c.bonus)} ${c.currency} ≈ ${fmt$(c.bonusPotential)}`,
    })
  })

  analytics.upcomingRenewals.forEach(c => {
    items.push({
      key: `rn-${c.id}`, tone: 'down', icon: '🔁',
      title: `${c.issuer} ${c.name}`,
      body: `${fmt$(c.annual_fee)} annual fee — cancel or downgrade?`,
      meta: `${c.renewalDaysLeft}d`,
      sub: `Opened ${fmtDate(c.open_date)} · ${c.ageMonths}mo old`,
    })
  })

  const over524 = analytics.fiveTwentyFour >= 5
  items.push({
    key: '524', tone: over524 ? 'down' : 'up', icon: '🚦',
    title: 'Chase 5/24',
    body: over524 ? 'Over limit — Chase likely to decline' : 'Under limit — Chase window open',
    meta: `${analytics.fiveTwentyFour}/5`,
    sub: `US cards opened in last 24 months`,
  })

  const borderCls = { up: 'border-l-up', warn: 'border-l-warn', down: 'border-l-down' }
  const metaCls   = { up: 'text-up',     warn: 'text-warn',     down: 'text-down'  }

  return (
    <div className="flex flex-col gap-2">
      {items.map(it => (
        <div key={it.key} className={cn('flex items-start gap-3 p-3 bg-surface border border-border rounded-md border-l-[3px]', borderCls[it.tone])}>
          <span className="text-base mt-0.5 shrink-0">{it.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="text-card-title text-text leading-tight">{it.title}</div>
            <div className="text-small text-text-2 mt-0.5">{it.body}</div>
            <div className="text-micro text-text-3 mt-0.5">{it.sub}</div>
          </div>
          <span className={cn('text-small font-bold tabular shrink-0', metaCls[it.tone])}>{it.meta}</span>
        </div>
      ))}
    </div>
  )
}

// ── Points breakdown ──────────────────────────────────────────

function PointsBreakdown({ analytics }: { analytics: Analytics }) {
  const entries = Object.entries(analytics.pointsByProgram).sort((a, b) => b[1].value - a[1].value)
  if (!entries.length) return <p className="text-small text-text-3">No unredeemed points tracked.</p>
  const maxVal = Math.max(...entries.map(e => e[1].value), 1)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[22px] font-semibold text-accent tabular leading-tight">{fmt$(analytics.unredeemedValue)}</span>
        <span className="text-micro text-text-3">unredeemed total</span>
      </div>
      {entries.map(([cur, b]) => (
        <div key={cur} className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center">
            <span className="text-small font-semibold text-text">{b.label}</span>
            <span className="text-micro text-text-2 tabular font-mono">
              {fmtPts(b.pts)} · <span className="text-accent">{fmt$(b.value)}</span>
            </span>
          </div>
          <Bar pct={(b.value / maxVal) * 100} tone="accent" />
        </div>
      ))}
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────

function Modal({ children, onClose, wide = false }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm overflow-y-auto py-12 px-4" onClick={onClose}>
      <div
        className={cn('modal-pop relative bg-surface border border-border-strong rounded-md shadow-lg w-full mt-4', wide ? 'max-w-2xl' : 'max-w-md')}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5">
          <button onClick={onClose} className="absolute top-4 right-4 w-7 h-7 rounded-xs bg-surface-2 border border-border text-text-3 hover:text-text flex items-center justify-center transition-colors">
            <X size={13} />
          </button>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Card detail modal ─────────────────────────────────────────

function CardDetailModal({ card, onClose, onEdit, onDelete, onToggleStatus }: {
  card: EnrichedCard; onClose: () => void
  onEdit: (c: EnrichedCard) => void; onDelete: (c: EnrichedCard) => void; onToggleStatus: (c: EnrichedCard) => void
}) {
  const isCancelled = card.status === 'cancelled'
  const rows: [string, string][] = [
    ['Issuer / Network',  `${card.issuer} · ${card.network}`],
    ['Market / Bureau',  `${card.market === 'US' ? '🇺🇸 US' : '🇨🇦 CA'} · ${card.bureau}`],
    ['Opened',           fmtDate(card.open_date)],
    ['Cancelled',        isCancelled ? fmtDate(card.cancel_date) : '—'],
    ['Card age',         `${card.ageMonths} months`],
    ['Annual fee',       card.annual_fee === 0 ? 'No fee' : `${fmt$(card.annual_fee)}${card.first_year_free ? ' · 1st yr free' : ''}`],
    ['Next renewal',     card.renewalDate ? `${fmtDate(card.renewalDate)} (${card.renewalDaysLeft}d)` : '—'],
    ['Hard pull',        card.hard_pull ? `Yes · ${card.bureau}` : 'No'],
    ['Sign-up bonus',    card.bonus > 0 ? `${fmtPts(card.bonus)} ${card.currency} ≈ ${fmt$(card.bonusPotential)}` : '—'],
    ['Bonus status',     card.bonus_met ? `✓ Met${card.bonus_met_date ? ` · ${fmtDate(card.bonus_met_date)}` : ''}` : 'Not yet met'],
    ['Points balance',   card.points_balance > 0 ? `${fmtPts(card.points_balance)} ${card.currency} ≈ ${fmt$(card.pointsValue)}` : 'Cleared / transferred'],
  ]

  return (
    <Modal onClose={onClose} wide>
      <div className="flex gap-6 flex-wrap">
        {/* Left: card visual */}
        <div className="w-56 shrink-0 flex flex-col gap-3">
          <CardTile card={card} onClick={() => {}} />
          {card.note && (
            <p className="text-small text-text-2 bg-surface-2 rounded-sm p-3 border border-border leading-relaxed">{card.note}</p>
          )}
        </div>

        {/* Right: detail */}
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <h2 className="text-section-h2 text-text">{card.name}</h2>
            <StatusBadge tone="neutral">{card.market}</StatusBadge>
            {isCancelled && <StatusBadge tone="down">Closed</StatusBadge>}
          </div>
          <p className="text-small text-text-3 mb-4">{card.issuer}</p>

          {card.msActive && (
            <div className="mb-4 p-3 bg-warn/[0.08] border border-warn/25 rounded-sm">
              <div className="flex justify-between mb-2">
                <span className="text-small font-semibold text-warn">🎯 Min Spend In Progress</span>
                <span className="text-small font-bold text-warn tabular">{card.msDaysLeft ?? '?'}d left</span>
              </div>
              <Bar pct={card.msPct} tone="warn" />
              <p className="text-micro text-text-2 mt-1.5">
                ${card.min_spend_current.toFixed(0)} / ${card.min_spend_req.toFixed(0)} · <b className="text-text">${card.msRemaining.toFixed(0)} remaining</b>
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-px bg-border rounded-sm overflow-hidden border border-border">
            {rows.map(([k, v], i) => (
              <div key={i} className="bg-surface px-3 py-2">
                <div className="text-micro text-text-3 mb-0.5">{k}</div>
                <div className="text-small font-mono text-text font-medium">{v}</div>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-5 flex-wrap">
            <Button size="sm" onClick={() => onEdit(card)}>Edit</Button>
            <Button size="sm" variant="outline" onClick={() => onToggleStatus(card)}>
              {isCancelled ? '↩ Mark Active' : '✕ Mark Cancelled'}
            </Button>
            <Button size="sm" variant="outline" className="text-down hover:bg-down-soft border-down/30"
              onClick={() => { if (confirm('Delete this card?')) onDelete(card) }}>
              Delete
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Annual fee breakdown modal ────────────────────────────────

function AnnualFeeModal({ cards, onClose, toDisplayCurrency, fmtDisplay, cadRate }: {
  cards: EnrichedCard[]
  onClose: () => void
  toDisplayCurrency: (usd: number) => string
  fmtDisplay: (usd: number) => string
  cadRate: number   // how many CAD per 1 USD
}) {
  const active = cards.filter(c => c.status === 'active')

  // Convert a card's fee to USD regardless of origin currency
  const feeUsd = (c: EnrichedCard) => c.market === 'CA' ? c.annual_fee / cadRate : c.annual_fee
  const inFreeYear = (c: EnrichedCard) => !!c.first_year_free && c.ageMonths < 12

  const feeRows = active.filter(c => c.annual_fee > 0)
  const freeRows = active.filter(c => c.annual_fee === 0 || (c.annual_fee > 0 && inFreeYear(c)))
  const totalUsd = feeRows.filter(c => !inFreeYear(c)).reduce((s, c) => s + feeUsd(c), 0)

  const nativeFmt = (c: EnrichedCard) =>
    new Intl.NumberFormat('en-CA', { style: 'currency', currency: c.market === 'CA' ? 'CAD' : 'USD', maximumFractionDigits: 0 }).format(c.annual_fee)

  return (
    <Modal onClose={onClose}>
      <h2 className="text-section-h2 text-text mb-0.5">Annual Fee Breakdown</h2>
      <p className="text-small text-text-3 mb-4">Active cards only. CA fees converted from CAD.</p>

      {feeRows.length === 0 ? (
        <p className="text-small text-text-3 py-4 text-center">No annual fees on active cards.</p>
      ) : (
        <div className="flex flex-col gap-1.5 mb-4">
          {feeRows.map(c => {
            const free = inFreeYear(c)
            return (
              <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
                {/* Card colour swatch */}
                <div className="w-8 h-5 rounded-[3px] shrink-0" style={{ background: `linear-gradient(150deg, ${c.c1}, ${c.c2})` }} />
                {/* Name */}
                <div className="flex-1 min-w-0">
                  <div className="text-small font-medium text-text truncate">{c.issuer} {c.name}</div>
                  <div className="text-micro text-text-3 mt-0.5 flex items-center gap-1.5">
                    <span>{c.market === 'CA' ? '🇨🇦' : '🇺🇸'}</span>
                    <span>{c.market === 'CA' ? 'CAD' : 'USD'} · {nativeFmt(c)}</span>
                    {c.market === 'CA' && <span className="text-text-3">→ {fmtDisplay(feeUsd(c))}</span>}
                  </div>
                </div>
                {/* Amount */}
                {free ? (
                  <div className="text-right shrink-0">
                    <span className="text-micro bg-up-soft text-up px-2 py-0.5 rounded-xs font-semibold">Free yr 1</span>
                    <div className="text-micro text-text-3 mt-0.5 line-through">{fmtDisplay(feeUsd(c))}</div>
                  </div>
                ) : (
                  <span className="text-small font-semibold text-text tabular shrink-0">{fmtDisplay(feeUsd(c))}</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Free / no-fee cards note */}
      {freeRows.length > 0 && (
        <div className="mb-4 p-3 bg-surface-2 border border-border rounded-xs">
          <p className="text-micro text-text-3 font-semibold mb-1.5">No fee / waived</p>
          <div className="flex flex-col gap-1">
            {freeRows.map(c => (
              <div key={c.id} className="flex items-center gap-2 text-micro text-text-2">
                <div className="w-5 h-3 rounded-[2px] shrink-0" style={{ background: `linear-gradient(150deg, ${c.c1}, ${c.c2})` }} />
                <span className="truncate">{c.issuer} {c.name}</span>
                {inFreeYear(c) && c.annual_fee > 0 && <span className="text-text-3 ml-auto shrink-0">Free yr 1</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Total */}
      <div className="flex items-center justify-between pt-3 border-t border-border">
        <span className="text-small font-semibold text-text">Total billed this year</span>
        <span className="font-display text-[20px] font-semibold text-text tabular">{fmtDisplay(totalUsd)}</span>
      </div>
    </Modal>
  )
}

// ── Card form modal ───────────────────────────────────────────

const BLANK: Omit<CreditCard, 'id' | 'created_at'> = {
  name: '', issuer: '', network: 'Visa', market: 'US', status: 'active',
  open_date: new Date().toISOString().slice(0, 10), cancel_date: null,
  annual_fee: 0, first_year_free: 0, bureau: 'Experian', hard_pull: 1,
  bonus: 0, currency: 'UR', bonus_met: 0, bonus_met_date: null,
  min_spend_req: 0, min_spend_deadline: null, min_spend_current: 0,
  points_balance: 0, note: null, c1: '#2a4a8a', c2: '#1a2f5e',
}

function Field({ label, children, span2 = false }: { label: string; children: React.ReactNode; span2?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1.5', span2 && 'col-span-2')}>
      <label className="text-micro text-text-2 font-semibold">{label}</label>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-surface-2 border border-border rounded-xs px-3 py-2 text-body text-text outline-none focus:border-accent transition-colors'

function CardFormModal({ initial, onClose, onSave }: {
  initial?: EnrichedCard | null; onClose: () => void
  onSave: (data: Omit<CreditCard, 'id' | 'created_at'>) => void
}) {
  const isEdit = !!initial
  const [f, setF] = useState<Omit<CreditCard, 'id' | 'created_at'>>(() => initial ? {
    name: initial.name, issuer: initial.issuer, network: initial.network,
    market: initial.market, status: initial.status, open_date: initial.open_date,
    cancel_date: initial.cancel_date, annual_fee: initial.annual_fee,
    first_year_free: initial.first_year_free, bureau: initial.bureau,
    hard_pull: initial.hard_pull, bonus: initial.bonus, currency: initial.currency,
    bonus_met: initial.bonus_met, bonus_met_date: initial.bonus_met_date,
    min_spend_req: initial.min_spend_req, min_spend_deadline: initial.min_spend_deadline,
    min_spend_current: initial.min_spend_current, points_balance: initial.points_balance,
    note: initial.note, c1: initial.c1, c2: initial.c2,
  } : { ...BLANK })

  const set = <K extends keyof typeof f>(k: K, v: typeof f[K]) => setF(p => ({ ...p, [k]: v }))

  const save = () => {
    if (!f.name.trim() || !f.issuer.trim()) { alert('Name and issuer are required'); return }
    onSave({
      ...f,
      cancel_date:        f.status === 'cancelled' ? (f.cancel_date || new Date().toISOString().slice(0, 10)) : null,
      bonus_met_date:     f.bonus_met ? f.bonus_met_date : null,
      min_spend_deadline: f.min_spend_req > 0 ? f.min_spend_deadline : null,
    })
  }

  return (
    <Modal onClose={onClose} wide>
      <h2 className="text-section-h2 text-text mb-0.5">{isEdit ? 'Edit Card' : 'Add Card'}</h2>
      <p className="text-small text-text-3 mb-5">5/24, renewal dates, and min spend countdowns update automatically.</p>

      {/* ── Card appearance (live preview + color picker) ── */}
      <div className="flex gap-4 mb-5 p-4 bg-surface-2 border border-border rounded-sm">
        {/* Live preview */}
        <div className="w-48 shrink-0">
          <CardFace
            name={f.name} issuer={f.issuer} network={f.network}
            market={f.market} bureau={f.bureau} c1={f.c1} c2={f.c2}
          />
        </div>
        {/* Palette + custom */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <p className="text-micro text-text-2 font-semibold">Card colour</p>
          <div className="grid grid-cols-3 gap-2">
            {PALETTES.map(([c1, c2, label]) => (
              <button
                key={c1} type="button"
                onClick={() => { set('c1', c1); set('c2', c2) }}
                title={label}
                className={cn(
                  'relative h-10 rounded-xs transition-all overflow-hidden',
                  f.c1 === c1 ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface-2' : 'opacity-80 hover:opacity-100'
                )}
                style={{ background: `linear-gradient(150deg, ${c1}, ${c2})` }}
              >
                <span className="absolute inset-0 flex items-end px-1.5 pb-1">
                  <span className="text-white/70 text-[10px] font-medium leading-none">{label}</span>
                </span>
                {f.c1 === c1 && (
                  <span className="absolute top-1 right-1 w-3.5 h-3.5 bg-white/90 rounded-full flex items-center justify-center">
                    <span className="text-[8px] font-bold text-gray-800">✓</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* Custom hex inputs */}
          <div className="flex gap-2 items-center">
            <span className="text-micro text-text-3 shrink-0">Custom:</span>
            <label className="flex items-center gap-1.5 flex-1">
              <span className="text-micro text-text-3 shrink-0">From</span>
              <div className="flex items-center gap-1 flex-1 bg-surface border border-border rounded-xs px-2 py-1">
                <input type="color" value={f.c1} onChange={e => set('c1', e.target.value)}
                  className="w-5 h-5 rounded-[2px] cursor-pointer border-0 bg-transparent p-0" />
                <input type="text" value={f.c1} onChange={e => set('c1', e.target.value)}
                  className="flex-1 min-w-0 bg-transparent text-micro text-text font-mono outline-none w-16" maxLength={7} />
              </div>
            </label>
            <label className="flex items-center gap-1.5 flex-1">
              <span className="text-micro text-text-3 shrink-0">To</span>
              <div className="flex items-center gap-1 flex-1 bg-surface border border-border rounded-xs px-2 py-1">
                <input type="color" value={f.c2} onChange={e => set('c2', e.target.value)}
                  className="w-5 h-5 rounded-[2px] cursor-pointer border-0 bg-transparent p-0" />
                <input type="text" value={f.c2} onChange={e => set('c2', e.target.value)}
                  className="flex-1 min-w-0 bg-transparent text-micro text-text font-mono outline-none w-16" maxLength={7} />
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Card name" span2>
          <input className={inputCls} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Sapphire Preferred" />
        </Field>
        <Field label="Issuer">
          <input className={inputCls} value={f.issuer} onChange={e => set('issuer', e.target.value)} placeholder="Chase / Amex / RBC…" />
        </Field>
        <Field label="Network">
          <select className={inputCls} value={f.network} onChange={e => set('network', e.target.value as CreditCard['network'])}>
            {(['Visa', 'Mastercard', 'Amex'] as const).map(n => <option key={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Market">
          <select className={inputCls} value={f.market} onChange={e => {
            const m = e.target.value as CreditCard['market']
            set('market', m); set('bureau', m === 'US' ? 'Experian' : 'Equifax')
          }}>
            <option value="US">🇺🇸 US</option>
            <option value="CA">🇨🇦 Canada</option>
          </select>
        </Field>
        <Field label="Credit bureau">
          <select className={inputCls} value={f.bureau} onChange={e => set('bureau', e.target.value as CreditCard['bureau'])}>
            {(f.market === 'US' ? ['Experian', 'Equifax', 'TransUnion'] : ['Equifax', 'TransUnion']).map(b => <option key={b}>{b}</option>)}
          </select>
        </Field>
        <Field label="Open date">
          <input type="date" className={inputCls} value={f.open_date} onChange={e => set('open_date', e.target.value)} />
        </Field>
        <Field label="Status">
          <select className={inputCls} value={f.status} onChange={e => set('status', e.target.value as CreditCard['status'])}>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
        {f.status === 'cancelled' && (
          <Field label="Cancel date">
            <input type="date" className={inputCls} value={f.cancel_date ?? ''} onChange={e => set('cancel_date', e.target.value || null)} />
          </Field>
        )}
        <Field label="Annual fee ($)">
          <input type="number" min={0} className={inputCls} value={f.annual_fee} onChange={e => set('annual_fee', +e.target.value)} />
        </Field>
        <Field label="First year free">
          <select className={inputCls} value={f.first_year_free} onChange={e => set('first_year_free', +e.target.value as 0|1)}>
            <option value={0}>No</option><option value={1}>Yes</option>
          </select>
        </Field>
        <Field label="Sign-up bonus (pts)">
          <input type="number" min={0} className={inputCls} value={f.bonus} onChange={e => set('bonus', +e.target.value)} />
        </Field>
        <Field label="Points program">
          <select className={inputCls} value={f.currency} onChange={e => set('currency', e.target.value as CreditCard['currency'])}>
            {Object.entries(CPP_LABEL).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}
          </select>
        </Field>
        <Field label="Bonus met">
          <select className={inputCls} value={f.bonus_met} onChange={e => set('bonus_met', +e.target.value as 0|1)}>
            <option value={0}>Not yet</option><option value={1}>Yes</option>
          </select>
        </Field>
        {!!f.bonus_met && (
          <Field label="Met on">
            <input type="date" className={inputCls} value={f.bonus_met_date ?? ''} onChange={e => set('bonus_met_date', e.target.value || null)} />
          </Field>
        )}
        <Field label="Min spend req ($)">
          <input type="number" min={0} className={inputCls} value={f.min_spend_req} onChange={e => set('min_spend_req', +e.target.value)} />
        </Field>
        <Field label="Spent so far ($)">
          <input type="number" min={0} className={inputCls} value={f.min_spend_current} onChange={e => set('min_spend_current', +e.target.value)} />
        </Field>
        {f.min_spend_req > 0 && (
          <Field label="Min spend deadline">
            <input type="date" className={inputCls} value={f.min_spend_deadline ?? ''} onChange={e => set('min_spend_deadline', e.target.value || null)} />
          </Field>
        )}
        <Field label="Points balance">
          <input type="number" min={0} className={inputCls} value={f.points_balance} onChange={e => set('points_balance', +e.target.value)} />
        </Field>
        <Field label="Hard pull">
          <select className={inputCls} value={f.hard_pull} onChange={e => set('hard_pull', +e.target.value as 0|1)}>
            <option value={1}>Yes</option><option value={0}>No</option>
          </select>
        </Field>

        <Field label="Note" span2>
          <input className={inputCls} value={f.note ?? ''} onChange={e => set('note', e.target.value || null)} placeholder="e.g. Long-term hold / cancel year 2" />
        </Field>
      </div>

      <div className="flex gap-2 justify-end mt-6">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save}>{isEdit ? 'Save changes' : 'Add card'}</Button>
      </div>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────

type MarketFilter = 'all' | 'US' | 'CA'
type StatusFilter = 'active' | 'cancelled' | 'all'
type SortKey      = 'open_date' | 'annual_fee' | 'bonus' | 'renewal'

export function CreditCards() {
  const qc = useQueryClient()
  const [market,       setMarket]       = useState<MarketFilter>('all')
  const [status,       setStatus]       = useState<StatusFilter>('active')
  const [search,       setSearch]       = useState('')
  const [sort,         setSort]         = useState<SortKey>('open_date')
  const [detail,       setDetail]       = useState<EnrichedCard | null>(null)
  const [formCard,     setFormCard]     = useState<EnrichedCard | null | undefined>(undefined)
  const [feeModalOpen, setFeeModalOpen] = useState(false)

  const { fmt: fmtMoney, rate: usdToDisplay } = useMoney()
  const { data: fxData } = useQuery({ queryKey: ['fx', 'USD'], queryFn: () => fxApi.rates('USD'), staleTime: 3_600_000 })
  // cadRate: how many CAD per 1 USD (e.g. 1.37). Default to 1.37 if not loaded yet.
  const cadRate = fxData?.rates?.['CAD'] ?? 1.37

  // Convert a CA card fee (CAD) → USD → then fmt handles display currency
  const feeUsd = (c: EnrichedCard) => c.market === 'CA' ? c.annual_fee / cadRate : c.annual_fee

  const { data: rawCards = [], isLoading } = useQuery({ queryKey: ['credit-cards'], queryFn: api.list })
  const cards     = useMemo(() => rawCards.map(enrichCard), [rawCards])
  const analytics = useMemo(() => analyzeCards(cards), [cards])

  const visible = useMemo(() => {
    let list = cards
    if (market !== 'all') list = list.filter(c => c.market === market)
    if (status !== 'all') list = list.filter(c => c.status === status)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.issuer.toLowerCase().includes(q))
    }
    return [...list].sort((a, b) => {
      if (sort === 'open_date')  return b.open_date.localeCompare(a.open_date)
      if (sort === 'annual_fee') return b.annual_fee - a.annual_fee
      if (sort === 'bonus')      return b.bonus - a.bonus
      if (sort === 'renewal')    return (a.renewalDaysLeft ?? 999) - (b.renewalDaysLeft ?? 999)
      return 0
    })
  }, [cards, market, status, search, sort])

  const createMut = useMutation({
    mutationFn: (body: Omit<CreditCard, 'id' | 'created_at'>) => api.create(body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credit-cards'] }); setFormCard(undefined) },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreditCard> }) => api.update(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credit-cards'] }); setFormCard(undefined); setDetail(null) },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credit-cards'] }); setDetail(null) },
  })

  // Recompute fee total + net return with proper CAD→USD conversion (analyzeCards uses raw amounts)
  const totalFeesUsd = useMemo(() =>
    cards.filter(c => c.status === 'active').reduce((s, c) => s + feeUsd(c), 0)
  , [cards, cadRate])

  const netReturnUsd = useMemo(() => {
    const active = cards.filter(c => c.status === 'active')
    const rewardUsd = active.reduce((s, c) => s + c.pointsValue, 0)   // CPP already in USD
    return rewardUsd - totalFeesUsd
  }, [cards, totalFeesUsd])

  const over524 = analytics.fiveTwentyFour >= 5
  const hasRail = analytics.openMinSpends.length > 0 || analytics.upcomingRenewals.length > 0 || Object.keys(analytics.pointsByProgram).length > 0

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-page-title text-text">Cards</h1>
          <p className="text-small text-text-3 mt-0.5">Track sign-up bonuses, min spend, and churn rules</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Market filter */}
          <div className="hidden sm:flex bg-surface-2 border border-border rounded-xs p-0.5">
            {(['all', 'US', 'CA'] as MarketFilter[]).map(m => (
              <button key={m} onClick={() => setMarket(m)}
                className={cn('px-3 py-1 rounded-xs text-small font-medium transition-all', market === m ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text')}>
                {m === 'all' ? 'All' : m === 'US' ? '🇺🇸 US' : '🇨🇦 CA'}
              </button>
            ))}
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setFormCard(null)}>
            <Plus size={14} /> Add card
          </Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <KpiCard label="Active"       value={analytics.activeCount} sub={`${analytics.cancelledCount} cancelled`} />
        <KpiCard label="Annual fees"  value={fmtMoney(totalFeesUsd)} sub="click for breakdown"
          tone={totalFeesUsd > 0 ? 'warn' : 'default'}
          onClick={() => setFeeModalOpen(true)} />
        <KpiCard label="Net return"   value={fmtMoney(netReturnUsd)} sub="rewards − fees" tone={netReturnUsd >= 0 ? 'up' : 'down'} />
        <KpiCard label="Chase 5/24"   value={`${analytics.fiveTwentyFour}/5`} sub="US cards in 24mo" tone={over524 ? 'down' : 'up'} />
        <KpiCard label="Points value" value={fmtMoney(analytics.unredeemedValue)} sub="unredeemed" tone="up" />
      </div>

      {/* Main: grid + right rail */}
      <div className="flex gap-5 items-start">
        {/* Left: toolbar + card grid */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {/* Status tabs */}
            <div className="flex bg-surface-2 border border-border rounded-xs p-0.5">
              {(['active', 'cancelled', 'all'] as StatusFilter[]).map(s => (
                <button key={s} onClick={() => setStatus(s)}
                  className={cn('px-3 py-1 rounded-xs text-small font-medium transition-all capitalize', status === s ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text')}>
                  {s === 'all' ? 'All' : s}
                </button>
              ))}
            </div>
            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                className="w-full pl-7 pr-3 py-1.5 bg-surface border border-border rounded-xs text-small text-text outline-none focus:border-accent transition-colors" />
            </div>
            {/* Sort */}
            <div className="relative">
              <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
                className="appearance-none pl-3 pr-6 py-1.5 bg-surface border border-border rounded-xs text-small text-text-2 outline-none focus:border-accent cursor-pointer">
                <option value="open_date">Newest first</option>
                <option value="annual_fee">Annual fee</option>
                <option value="bonus">Bonus size</option>
                <option value="renewal">Renewal soon</option>
              </select>
              <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" />
            </div>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[...Array(6)].map((_, i) => <div key={i} className="aspect-[1.586/1] rounded-md bg-surface-2 animate-pulse" />)}
            </div>
          ) : visible.length === 0 ? (
            <div className="border border-dashed border-border rounded-md p-12 text-center">
              <span className="text-4xl block mb-3">💳</span>
              <p className="text-small text-text-2 font-medium">No cards found</p>
              <p className="text-micro text-text-3 mt-1">Add your first card to start tracking</p>
              <Button size="sm" className="mt-4 gap-1.5" onClick={() => setFormCard(null)}>
                <Plus size={14} /> Add card
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {visible.map(card => <CardTile key={card.id} card={card} onClick={() => setDetail(card)} />)}
            </div>
          )}
        </div>

        {/* Right rail: only on xl+ */}
        {hasRail && (
          <div className="hidden xl:flex flex-col gap-5 w-72 shrink-0">
            <div>
              <p className="text-micro text-text-3 uppercase tracking-wider font-semibold mb-2">Action Required</p>
              <ActionCenter analytics={analytics} />
            </div>
            {Object.keys(analytics.pointsByProgram).length > 0 && (
              <div>
                <p className="text-micro text-text-3 uppercase tracking-wider font-semibold mb-2">Points Balance</p>
                <div className="bg-surface border border-border rounded-md p-4">
                  <PointsBreakdown analytics={analytics} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {feeModalOpen && (
        <AnnualFeeModal
          cards={cards}
          onClose={() => setFeeModalOpen(false)}
          toDisplayCurrency={fmtMoney}
          fmtDisplay={fmtMoney}
          cadRate={cadRate}
        />
      )}
      {detail && (
        <CardDetailModal card={detail} onClose={() => setDetail(null)}
          onEdit={c => { setDetail(null); setFormCard(c) }}
          onDelete={c => deleteMut.mutate(c.id)}
          onToggleStatus={c => updateMut.mutate({ id: c.id, body: {
            status: c.status === 'active' ? 'cancelled' : 'active',
            cancel_date: c.status === 'active' ? new Date().toISOString().slice(0, 10) : null,
          }})}
        />
      )}
      {formCard !== undefined && (
        <CardFormModal initial={formCard} onClose={() => setFormCard(undefined)}
          onSave={body => {
            if (formCard?.id) updateMut.mutate({ id: formCard.id, body: body as Partial<CreditCard> })
            else createMut.mutate(body)
          }}
        />
      )}
    </div>
  )
}
