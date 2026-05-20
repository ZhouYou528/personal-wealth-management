import type { Quote } from '@shared/types'

// ---------- Crypto symbol → CoinGecko ID ----------

const COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', ADA: 'cardano', AVAX: 'avalanche-2', DOGE: 'dogecoin',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink',
  UNI: 'uniswap', ATOM: 'cosmos', USDC: 'usd-coin', USDT: 'tether',
  LTC: 'litecoin', BCH: 'bitcoin-cash', SHIB: 'shiba-inu', TON: 'the-open-network',
}

const CRYPTO_SYMBOLS = new Set(Object.keys(COINGECKO_ID))

export function isCrypto(symbol: string): boolean {
  return CRYPTO_SYMBOLS.has(symbol.toUpperCase())
}

// ---------- Finnhub ----------

export async function fetchFinnhubQuote(symbol: string, apiKey: string): Promise<Quote | null> {
  if (!apiKey) return null
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const d = await res.json() as { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number }
    if (!d.c) return null
    return {
      symbol,
      price: d.c,
      change: d.d,
      changePct: d.dp,
      high: d.h,
      low: d.l,
      open: d.o,
      prevClose: d.pc,
      timestamp: d.t * 1000,
    }
  } catch {
    return null
  }
}

// ---------- CoinGecko Demo ----------

export async function fetchCoinGeckoQuote(symbol: string, apiKey: string): Promise<Quote | null> {
  if (!apiKey) return null
  const id = COINGECKO_ID[symbol.toUpperCase()]
  if (!id) return null
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const d = await res.json() as Record<string, { usd: number; usd_24h_change: number; last_updated_at: number }>
    const coin = d[id]
    if (!coin) return null
    const prevClose = coin.usd / (1 + coin.usd_24h_change / 100)
    return {
      symbol,
      price: coin.usd,
      change: coin.usd - prevClose,
      changePct: coin.usd_24h_change,
      high: coin.usd,
      low: coin.usd,
      open: prevClose,
      prevClose,
      timestamp: coin.last_updated_at * 1000,
    }
  } catch {
    return null
  }
}

// ---------- Static ticker list for search ----------

export const STATIC_TICKERS = [
  // US large caps
  { symbol: 'AAPL',  name: 'Apple Inc.',               kind: 'stock' as const },
  { symbol: 'MSFT',  name: 'Microsoft Corporation',    kind: 'stock' as const },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',             kind: 'stock' as const },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',           kind: 'stock' as const },
  { symbol: 'NVDA',  name: 'NVIDIA Corporation',        kind: 'stock' as const },
  { symbol: 'META',  name: 'Meta Platforms Inc.',       kind: 'stock' as const },
  { symbol: 'TSLA',  name: 'Tesla Inc.',                kind: 'stock' as const },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway B',     kind: 'stock' as const },
  { symbol: 'JPM',   name: 'JPMorgan Chase',            kind: 'stock' as const },
  { symbol: 'V',     name: 'Visa Inc.',                 kind: 'stock' as const },
  // US ETFs
  { symbol: 'SPY',   name: 'SPDR S&P 500 ETF',         kind: 'etf' as const },
  { symbol: 'QQQ',   name: 'Invesco QQQ ETF',           kind: 'etf' as const },
  { symbol: 'VTI',   name: 'Vanguard Total Market ETF', kind: 'etf' as const },
  { symbol: 'VXC',   name: 'Vanguard FTSE Global ex-CA',kind: 'etf' as const },
  { symbol: 'SCHD',  name: 'Schwab US Dividend ETF',   kind: 'etf' as const },
  // Canadian ETFs (Questrade / Wealthsimple favorites)
  { symbol: 'VEQT.TO', name: 'Vanguard All-Equity ETF', kind: 'etf' as const },
  { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF', kind: 'etf' as const },
  { symbol: 'ZGRO.TO', name: 'BMO Growth ETF',           kind: 'etf' as const },
  { symbol: 'ZSP.TO',  name: 'BMO S&P 500 ETF',          kind: 'etf' as const },
  { symbol: 'VFV.TO',  name: 'Vanguard S&P 500 (CAD)',   kind: 'etf' as const },
  { symbol: 'XIU.TO',  name: 'iShares S&P/TSX 60 ETF',   kind: 'etf' as const },
  // Crypto
  { symbol: 'BTC',  name: 'Bitcoin',   kind: 'crypto' as const },
  { symbol: 'ETH',  name: 'Ethereum',  kind: 'crypto' as const },
  { symbol: 'SOL',  name: 'Solana',    kind: 'crypto' as const },
  { symbol: 'BNB',  name: 'BNB',       kind: 'crypto' as const },
  { symbol: 'XRP',  name: 'XRP',       kind: 'crypto' as const },
  { symbol: 'ADA',  name: 'Cardano',   kind: 'crypto' as const },
  { symbol: 'AVAX', name: 'Avalanche', kind: 'crypto' as const },
  { symbol: 'DOGE', name: 'Dogecoin',  kind: 'crypto' as const },
]
