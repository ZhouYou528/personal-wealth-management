// IBKR Flex Web Service integration.
//
// Two-step pull:
//   1. POST /SendRequest?t=TOKEN&q=QUERYID → ReferenceCode + Url
//   2. GET  {Url}?t=TOKEN&q=ReferenceCode → XML statement
//
// Activity statements refresh once daily ~02:00 ET, so calling more often is
// wasted. The cron pulls once per day at 22:00 UTC.
//
// Each Flex Query yields a single XML containing multiple FlexStatement blocks
// (one per IBKR account). We persist parsed rows into the unified `transactions`
// + `broker_positions` + `broker_balances` tables with source='ibkr_flex'.

import { XMLParser } from 'fast-xml-parser'
import type { TxType } from '@shared/types'
import { isEtfSymbol } from '../../shared/etf-list'

const SUBMIT_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest'

export interface IbkrFlexConfig {
  token:    string
  queryId:  string
}

export interface IbkrSyncResult {
  trades_inserted:        number
  cash_inserted:          number
  positions_upserted:     number
  positions_culled:       number
  balances_upserted:      number
  accounts_synced:        string[]
  errors:                 string[]
}

// ── HTTP: submit + fetch ─────────────────────────────────────────

interface FlexSubmitResponse {
  Status: 'Success' | 'Fail' | string
  ReferenceCode?: string
  Url?: string
  ErrorCode?: string
  ErrorMessage?: string
}

// IBKR rejects requests without a User-Agent header (returns 403). Use a
// browser-ish UA — they're not picky about exact value, just non-empty.
const UA_HEADERS = { 'User-Agent': 'Meridian/1.0 (Cloudflare Workers)' }

export async function submitFlexRequest(cfg: IbkrFlexConfig): Promise<{ refCode: string; getUrl: string }> {
  const url = `${SUBMIT_URL}?t=${encodeURIComponent(cfg.token)}&q=${encodeURIComponent(cfg.queryId)}&v=3`
  const res = await fetch(url, { headers: UA_HEADERS })
  if (!res.ok) throw new Error(`Flex submit HTTP ${res.status}`)
  const xml = await res.text()
  const parser = new XMLParser({ ignoreAttributes: true })
  const parsed = parser.parse(xml) as { FlexStatementResponse?: FlexSubmitResponse }
  const r = parsed.FlexStatementResponse
  if (!r || r.Status !== 'Success' || !r.ReferenceCode || !r.Url) {
    throw new Error(`Flex submit failed: ${r?.ErrorCode ?? '?'} — ${r?.ErrorMessage ?? 'no reference code'}`)
  }
  return { refCode: r.ReferenceCode, getUrl: r.Url }
}

export async function fetchFlexStatement(cfg: IbkrFlexConfig, refCode: string, getUrl: string, maxAttempts = 6): Promise<string> {
  // IBKR returns a "statement in progress" error briefly after submit;
  // retry with backoff (1s, 2s, 4s, 8s, 16s, 32s).
  let lastErr = ''
  for (let i = 0; i < maxAttempts; i++) {
    const url = `${getUrl}?t=${encodeURIComponent(cfg.token)}&q=${encodeURIComponent(refCode)}&v=3`
    const res = await fetch(url, { headers: UA_HEADERS })
    if (!res.ok) throw new Error(`Flex fetch HTTP ${res.status}`)
    const body = await res.text()

    // Errors come back as <FlexStatementResponse><Status>Fail</Status>...
    if (body.includes('<Status>Fail</Status>')) {
      const code = body.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1] ?? '?'
      const msg  = body.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/)?.[1] ?? 'unknown'
      lastErr = `IBKR ${code}: ${msg}`
      // 1019 = statement still generating — retry
      if (code === '1019') {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
        continue
      }
      throw new Error(lastErr)
    }
    return body
  }
  throw new Error(`Flex fetch exhausted retries: ${lastErr}`)
}

// ── XML parsing ──────────────────────────────────────────────────

interface ParsedFlex {
  statements: ParsedStatement[]
}
interface ParsedStatement {
  accountId:   string
  fromDate:    string
  toDate:      string
  trades:           RawTrade[]
  cashTxs:          RawCashTx[]
  openPositions:    RawPosition[]
  optionEAEs:       RawOptionEAE[]
  cashBalances:     RawCashBalance[]
}

interface RawCashBalance {
  accountId:  string
  currency:   string         // 'USD', 'CAD', 'BASE_SUMMARY' (skip), etc.
  endingCash: number         // closing balance for the period
}

interface RawTrade {
  accountId:        string
  tradeID:          string
  tradeDate:        string
  tradeTime?:       string
  symbol?:          string
  underlyingSymbol?: string
  assetCategory?:   string
  buySell?:         string
  quantity:         number
  tradePrice:       number
  tradeMoney?:      number
  ibCommission?:    number
  proceeds?:        number
  putCall?:         string
  strike?:          number
  expiry?:          string
  multiplier?:      number
  openCloseIndicator?: string
  notes?:           string
  currency?:        string
  fxRateToBase?:    number
}

interface RawCashTx {
  accountId:    string
  transactionID?: string
  dateTime?:    string
  settleDate?:  string
  symbol?:      string
  type:         string
  amount:       number
  currency?:    string
  description?: string
}

interface RawPosition {
  accountId:        string
  symbol?:          string
  underlyingSymbol?: string
  assetCategory?:   string
  position:         number
  markPrice?:       number
  costBasisPrice?:  number
  costBasisMoney?:  number
  currency?:        string
  putCall?:         string
  strike?:          number
  expiry?:          string
  multiplier?:      number
}

interface RawOptionEAE {
  accountId:        string
  date:             string
  symbol?:          string
  underlyingSymbol?: string
  putCall?:         string
  strike?:          number
  expiry?:          string
  transactionType:  string  // Assignment, Exercise, Expiration
  quantity:         number
  multiplier?:      number
  proceeds?:        number
  commisionsAndTax?: number
}

export function parseFlexXml(xml: string): ParsedFlex {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    parseAttributeValue: true,
  })
  const raw = parser.parse(xml) as any

  const fqr = raw?.FlexQueryResponse
  if (!fqr) throw new Error('Missing FlexQueryResponse root')
  const fsList = arr(fqr.FlexStatements?.FlexStatement)

  const statements: ParsedStatement[] = fsList.map((fs: any) => ({
    accountId: String(fs.accountId ?? ''),
    fromDate:  String(fs.fromDate  ?? ''),
    toDate:    String(fs.toDate    ?? ''),
    trades:        arr(fs.Trades?.Trade).map(normTrade).filter((t: RawTrade | null): t is RawTrade => t !== null),
    cashTxs:       arr(fs.CashTransactions?.CashTransaction).map(normCashTx).filter((t: RawCashTx | null): t is RawCashTx => t !== null),
    openPositions: arr(fs.OpenPositions?.OpenPosition).map(normPosition).filter((p: RawPosition | null): p is RawPosition => p !== null),
    optionEAEs:    arr(fs.OptionEAE?.OptionEAE).map(normEAE).filter((e: RawOptionEAE | null): e is RawOptionEAE => e !== null),
    cashBalances:  arr(fs.CashReport?.CashReportCurrency).map(normCashBalance).filter((b: RawCashBalance | null): b is RawCashBalance => b !== null),
  }))

  return { statements }
}

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function normTrade(t: any): RawTrade | null {
  if (!t?.tradeID) return null
  return {
    accountId:          String(t.accountId ?? ''),
    tradeID:            String(t.tradeID),
    tradeDate:          isoDate(t.tradeDate),
    tradeTime:          t.tradeTime ? String(t.tradeTime) : undefined,
    symbol:             t.symbol ? String(t.symbol) : undefined,
    underlyingSymbol:   t.underlyingSymbol ? String(t.underlyingSymbol) : undefined,
    assetCategory:      t.assetCategory ? String(t.assetCategory) : undefined,
    buySell:            t.buySell ? String(t.buySell) : undefined,
    quantity:           num(t.quantity),
    tradePrice:         num(t.tradePrice),
    tradeMoney:         t.tradeMoney != null ? num(t.tradeMoney) : undefined,
    ibCommission:       t.ibCommission != null ? num(t.ibCommission) : undefined,
    proceeds:           t.proceeds != null ? num(t.proceeds) : undefined,
    putCall:            t.putCall ? String(t.putCall) : undefined,
    strike:             t.strike != null ? num(t.strike) : undefined,
    expiry:             t.expiry ? isoDate(t.expiry) : undefined,
    multiplier:         t.multiplier != null ? num(t.multiplier) : undefined,
    openCloseIndicator: t.openCloseIndicator ? String(t.openCloseIndicator) : undefined,
    notes:              t.notes ? String(t.notes) : undefined,
    currency:           t.currency ? String(t.currency) : undefined,
    fxRateToBase:       t.fxRateToBase != null ? num(t.fxRateToBase) : undefined,
  }
}

function normCashTx(t: any): RawCashTx | null {
  if (!t?.type) return null
  return {
    accountId:     String(t.accountId ?? ''),
    transactionID: t.transactionID ? String(t.transactionID) : undefined,
    dateTime:      t.dateTime ? String(t.dateTime) : undefined,
    settleDate:    t.settleDate ? isoDate(t.settleDate) : undefined,
    symbol:        t.symbol ? String(t.symbol) : undefined,
    type:          String(t.type),
    amount:        num(t.amount),
    currency:      t.currency ? String(t.currency) : undefined,
    description:   t.description ? String(t.description) : undefined,
  }
}

function normPosition(p: any): RawPosition | null {
  if (p?.position == null) return null
  return {
    accountId:        String(p.accountId ?? ''),
    symbol:           p.symbol ? String(p.symbol) : undefined,
    underlyingSymbol: p.underlyingSymbol ? String(p.underlyingSymbol) : undefined,
    assetCategory:    p.assetCategory ? String(p.assetCategory) : undefined,
    position:         num(p.position),
    markPrice:        p.markPrice != null ? num(p.markPrice) : undefined,
    costBasisPrice:   p.costBasisPrice != null ? num(p.costBasisPrice) : undefined,
    costBasisMoney:   p.costBasisMoney != null ? num(p.costBasisMoney) : undefined,
    currency:         p.currency ? String(p.currency) : undefined,
    putCall:          p.putCall ? String(p.putCall) : undefined,
    strike:           p.strike != null ? num(p.strike) : undefined,
    expiry:           p.expiry ? isoDate(p.expiry) : undefined,
    multiplier:       p.multiplier != null ? num(p.multiplier) : undefined,
  }
}

function normEAE(e: any): RawOptionEAE | null {
  if (!e?.transactionType) return null
  return {
    accountId:        String(e.accountId ?? ''),
    date:             isoDate(e.date),
    symbol:           e.symbol ? String(e.symbol) : undefined,
    underlyingSymbol: e.underlyingSymbol ? String(e.underlyingSymbol) : undefined,
    putCall:          e.putCall ? String(e.putCall) : undefined,
    strike:           e.strike != null ? num(e.strike) : undefined,
    expiry:           e.expiry ? isoDate(e.expiry) : undefined,
    transactionType:  String(e.transactionType),
    quantity:         num(e.quantity),
    multiplier:       e.multiplier != null ? num(e.multiplier) : undefined,
    proceeds:         e.proceeds != null ? num(e.proceeds) : undefined,
    commisionsAndTax: e.commisionsAndTax != null ? num(e.commisionsAndTax) : undefined,
  }
}

function normCashBalance(b: any): RawCashBalance | null {
  if (!b?.currency) return null
  const currency = String(b.currency).toUpperCase()
  // BASE_SUMMARY rolls everything into the base currency — we want per-currency rows
  if (currency === 'BASE_SUMMARY' || currency === 'BASE') return null
  // Prefer endingCash; fall back to endingSettledCash if absent
  const ending = b.endingCash != null ? num(b.endingCash)
              : b.endingSettledCash != null ? num(b.endingSettledCash)
              : null
  if (ending == null) return null
  return {
    accountId:  String(b.accountId ?? ''),
    currency,
    endingCash: ending,
  }
}

function num(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const n = Number(String(v))
  return Number.isFinite(n) ? n : 0
}

function isoDate(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  // Accept yyyyMMdd or yyyy-MM-dd
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`
  return s
}

// ── Cash transaction type → our TxType ───────────────────────────

const CASH_TO_TX: Record<string, TxType> = {
  'Dividends':                'dividend',
  'Payment In Lieu Of Dividends': 'dividend',
  'Withholding Tax':          'withdraw',  // negative-amount → fee against dividend
  'Broker Interest Received': 'interest',
  'Broker Interest Paid':     'withdraw',
  'Broker Fees':              'withdraw',
  'Other Fees':               'withdraw',
  'Other Income':             'deposit',
  'Deposits/Withdrawals':     'deposit',   // sign of amount determines actual direction
  'Bond Interest Received':   'interest',
  'Bond Interest Paid':       'withdraw',
}

// ── DB writes ────────────────────────────────────────────────────

export async function persistFlexResults(
  db: D1Database,
  parsed: ParsedFlex,
  accountMap: Record<string, string>,  // ibkr account id (U...) → d1 account id
): Promise<IbkrSyncResult> {
  const result: IbkrSyncResult = {
    trades_inserted: 0, cash_inserted: 0,
    positions_upserted: 0, positions_culled: 0,
    balances_upserted: 0,
    accounts_synced: [], errors: [],
  }
  const nowISO = new Date().toISOString()

  for (const fs of parsed.statements) {
    const d1Id = accountMap[fs.accountId]
    if (!d1Id) {
      result.errors.push(`No D1 mapping for IBKR account ${fs.accountId}`)
      continue
    }
    result.accounts_synced.push(fs.accountId)

    // ── Trades → transactions ────────────────────────────────────
    if (fs.trades.length > 0) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO transactions (
          id, tx_date, account_id, type, symbol, kind, qty, price, total, note,
          option_type, strike, expiry, underlying,
          source, external_id, synced_at, created_at
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ibkr_flex',?,?,?)
      `)
      const batch: D1PreparedStatement[] = []
      for (const t of fs.trades) {
        const isOption = (t.assetCategory ?? '').toUpperCase().includes('OPT')
        const isSell = (t.buySell ?? '').toUpperCase().startsWith('SELL') || t.quantity < 0
        const baseType: TxType = isOption
          ? (isSell ? 'sell_option' : 'buy_option')
          : (isSell ? 'sell' : 'buy')
        const sym = isOption
          ? (t.underlyingSymbol ?? t.symbol ?? null)
          : (t.symbol ?? null)
        const total = Math.abs(t.proceeds ?? (t.quantity * t.tradePrice * (t.multiplier ?? 1)))
        const txId = `ibkr_${t.tradeID}`
        const opt = t.putCall ? (t.putCall.toUpperCase().startsWith('P') ? 'put' : 'call') : null

        batch.push(stmt.bind(
          txId,
          t.tradeDate,
          d1Id,
          baseType,
          sym,
          isOption ? 'option' : assetKindOf(t.assetCategory, sym),
          Math.abs(t.quantity) || null,
          t.tradePrice || null,
          total,
          t.notes || null,
          opt,
          t.strike ?? null,
          t.expiry ?? null,
          isOption ? (t.underlyingSymbol ?? null) : null,
          t.tradeID,         // external_id
          nowISO,            // synced_at
          t.tradeDate,
        ))
      }
      const r = await db.batch(batch)
      result.trades_inserted += r.reduce((s, x) => s + (x.meta?.changes ?? 0), 0)
    }

    // ── Cash transactions → transactions ─────────────────────────
    if (fs.cashTxs.length > 0) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO transactions (
          id, tx_date, account_id, type, symbol, kind, total, note,
          source, external_id, synced_at, created_at
        )
        VALUES (?,?,?,?,?,?,?,?,'ibkr_flex',?,?,?)
      `)
      const batch: D1PreparedStatement[] = []
      let i = 0
      for (const c of fs.cashTxs) {
        const txDate = (c.dateTime ?? c.settleDate ?? '').slice(0, 10).replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')
        if (!txDate) continue
        const baseType = CASH_TO_TX[c.type] ?? 'deposit'
        // Deposits/Withdrawals: distinguish by sign
        const type: TxType = c.type === 'Deposits/Withdrawals'
          ? (c.amount < 0 ? 'withdraw' : 'deposit')
          : baseType
        // External id falls back to a stable composite when transactionID is missing
        const extId = c.transactionID ?? `${c.accountId}|${txDate}|${c.type}|${c.symbol ?? ''}|${c.amount.toFixed(4)}|${i++}`
        const txId = `ibkr_cash_${extId}`
        batch.push(stmt.bind(
          txId,
          txDate,
          d1Id,
          type,
          c.symbol ?? null,
          c.symbol ? 'cash' : null,
          Math.abs(c.amount),
          c.description ?? c.type,
          extId,
          nowISO,
          txDate,
        ))
      }
      if (batch.length > 0) {
        const r = await db.batch(batch)
        result.cash_inserted += r.reduce((s, x) => s + (x.meta?.changes ?? 0), 0)
      }
    }

    // ── Open positions → broker_positions (table name kept for unified read path) ─
    if (fs.openPositions.length > 0) {
      const upsert = db.prepare(`
        INSERT INTO broker_positions (
          account_id, symbol, option_type, strike, expiry, kind, qty, avg_cost,
          market_price, currency, underlying, multiplier, synced_at
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, symbol, option_type, strike, expiry) DO UPDATE SET
          kind         = excluded.kind,
          qty          = excluded.qty,
          avg_cost     = excluded.avg_cost,
          market_price = excluded.market_price,
          currency     = excluded.currency,
          underlying   = excluded.underlying,
          multiplier   = excluded.multiplier,
          synced_at    = excluded.synced_at
      `)
      const batch: D1PreparedStatement[] = []
      for (const p of fs.openPositions) {
        const isOption = (p.assetCategory ?? '').toUpperCase().includes('OPT')
        const sym = isOption ? (p.underlyingSymbol ?? p.symbol ?? '') : (p.symbol ?? '')
        if (!sym) continue
        const optType = isOption ? (p.putCall?.toUpperCase().startsWith('P') ? 'put' : 'call') : ''
        const avgCost = p.costBasisPrice ?? (p.costBasisMoney != null && p.position
          ? p.costBasisMoney / p.position / (p.multiplier ?? 1) : null)
        batch.push(upsert.bind(
          d1Id,
          sym,
          optType,
          isOption ? (p.strike ?? 0) : 0,
          isOption ? (p.expiry ?? '') : '',
          isOption ? 'option' : assetKindOf(p.assetCategory, sym),
          p.position,
          avgCost,
          p.markPrice ?? null,
          p.currency ?? 'USD',
          isOption ? (p.underlyingSymbol ?? null) : null,
          p.multiplier ?? (isOption ? 100 : 1),
          nowISO,
        ))
      }
      if (batch.length > 0) {
        const r = await db.batch(batch)
        result.positions_upserted += r.length
      }
    }

    // Cull stale positions for the accounts we just synced
    const culled = await db
      .prepare('DELETE FROM broker_positions WHERE account_id = ? AND synced_at < ?')
      .bind(d1Id, nowISO).run()
    result.positions_culled += culled.meta.changes ?? 0

    // ── Cash balances → broker_balances (per currency) ───────────
    // Upsert per (account, currency); cull stale currencies the user no
    // longer holds (e.g. they converted all CAD → USD).
    if (fs.cashBalances.length > 0) {
      const upsert = db.prepare(`
        INSERT INTO broker_balances (account_id, currency, cash, buying_power, synced_at)
        VALUES (?,?,?,NULL,?)
        ON CONFLICT(account_id, currency) DO UPDATE SET
          cash      = excluded.cash,
          synced_at = excluded.synced_at
      `)
      const batch: D1PreparedStatement[] = []
      for (const b of fs.cashBalances) {
        batch.push(upsert.bind(d1Id, b.currency, b.endingCash, nowISO))
      }
      const r = await db.batch(batch)
      result.balances_upserted += r.length
    }
    // Cull stale balance rows for currencies not in this sync's report
    await db
      .prepare('DELETE FROM broker_balances WHERE account_id = ? AND synced_at < ?')
      .bind(d1Id, nowISO).run()
  }

  return result
}

function assetKindOf(cat: string | undefined, symbol?: string | null): string {
  const c = (cat ?? '').toUpperCase()
  if (c.includes('OPT')) return 'option'
  if (c.includes('FUND')) return 'mutual_fund'
  if (c.includes('CRYPTO')) return 'crypto'
  // IBKR's "CASH" asset class means forex / currency conversions
  // (e.g. USD.CAD pairs), NOT crypto.
  if (c.includes('CASH')) return 'cash'
  // IBKR lumps ETFs under STK in assetCategory — fall back to the symbol
  // whitelist to distinguish ETFs from individual stocks.
  if (c.includes('ETF') || isEtfSymbol(symbol)) return 'etf'
  return 'stock'
}

// ── Public sync orchestrator ─────────────────────────────────────

export async function syncIbkrFlex(
  db: D1Database,
  cfg: IbkrFlexConfig,
): Promise<IbkrSyncResult> {
  const { results = [] } = await db
    .prepare("SELECT id, number FROM accounts WHERE institution = 'Interactive Brokers'")
    .all<{ id: string; number: string }>()
  const accountMap: Record<string, string> = {}
  for (const a of results) {
    if (a.number) accountMap[a.number] = a.id
  }
  if (Object.keys(accountMap).length === 0) {
    return {
      trades_inserted: 0, cash_inserted: 0, positions_upserted: 0,
      positions_culled: 0, balances_upserted: 0, accounts_synced: [],
      errors: ['No IBKR accounts in D1 (expected accounts.institution = "Interactive Brokers" with number = U...)'],
    }
  }

  const { refCode, getUrl } = await submitFlexRequest(cfg)
  const xml = await fetchFlexStatement(cfg, refCode, getUrl)
  const parsed = parseFlexXml(xml)
  const result = await persistFlexResults(db, parsed, accountMap)

  // Stamp last_synced_at on all touched accounts
  const nowISO = new Date().toISOString()
  await db.batch(result.accounts_synced.map(ibkrId =>
    db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?')
      .bind(nowISO, accountMap[ibkrId])
  ))

  return result
}
