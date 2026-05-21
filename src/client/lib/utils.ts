import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Formatting ────────────────────────────────────────────────

export function isCadSymbol(symbol: string): boolean {
  return symbol === 'CAD' || symbol === 'CASH' ||
    symbol.endsWith('.TO') || symbol.endsWith('.V')
}

/** Simple FX table (CAD base). Replace with live source for accuracy. */
export const FX: Record<string, number> = {
  CAD: 1,
  USD: 1.37,
  EUR: 1.47,
  GBP: 1.73,
  JPY: 0.0091,
}

export function toDisplayCurrency(valueCAD: number, currency: string): number {
  return valueCAD / (FX[currency] ?? 1)
}

export function fmtMoney(value: number, currency = 'USD', compact = false): string {
  const opts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }
  if (compact && Math.abs(value) >= 1_000_000) {
    return new Intl.NumberFormat('en-CA', { ...opts, notation: 'compact', maximumFractionDigits: 1 }).format(value)
  }
  return new Intl.NumberFormat('en-CA', opts).format(value)
}

export function fmtPct(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function fmtQty(value: number): string {
  if (value >= 1000) return new Intl.NumberFormat('en-CA').format(value)
  return value % 1 === 0 ? String(value) : value.toFixed(4).replace(/\.?0+$/, '')
}

// ISO date strings ("YYYY-MM-DD") are calendar dates — parse them as LOCAL dates,
// not as UTC midnight, otherwise users east of UTC see them shift by a day.
function parseISODateLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function fmtDate(iso: string): string {
  return parseISODateLocal(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateShort(iso: string): string {
  return parseISODateLocal(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

// ── Asset colours ────────────────────────────────────────────

export const KIND_COLOR: Record<string, string> = {
  stock:  '#10B981',
  etf:    '#06B6D4',
  option: '#F59E0B',
  crypto: '#F97316',
  cash:   '#A1A1AA',
}

export const KIND_LABEL: Record<string, string> = {
  stock: 'Stock', etf: 'ETF', option: 'Option', crypto: 'Crypto', cash: 'Cash',
}

// ── Misc ──────────────────────────────────────────────────────

export function nanoid(len = 10): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, len)
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "YYYY-MM-DD" in local time, N days before today. */
export function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Option helpers ─────────────────────────────────────────────

/** "AAPL 150C 3/15/24" — compact contract label */
export function fmtOptionLabel(o: {
  symbol: string
  option_type?: 'call' | 'put'
  strike?: number
  expiry?: string
}): string {
  const cp = o.option_type === 'put' ? 'P' : 'C'
  const strike = o.strike != null ? `${o.strike}${cp}` : cp
  if (!o.expiry) return `${o.symbol} ${strike}`
  const d = new Date(o.expiry)
  const date = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`
  return `${o.symbol} ${strike} ${date}`
}

/** Days to expiry. Negative = expired. Treats expiry as a local-date end-of-day. */
export function daysToExpiry(expiry?: string): number | null {
  if (!expiry) return null
  const [y, m, d] = expiry.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999)
  return Math.ceil((dt.getTime() - Date.now()) / 86400000)
}
