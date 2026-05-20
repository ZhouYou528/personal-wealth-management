// CoinGecko Demo API for crypto spot prices.
// Docs: https://docs.coingecko.com/v3.0.1/reference/simple-price
// Free Demo plan: 30 calls/min, 10K calls/month.
//
// Endpoint: /api/v3/simple/price?ids=bitcoin&vs_currencies=usd
//
// We accept either a coin id (e.g. "bitcoin") OR a ticker (e.g. "BTC") and
// resolve tickers to ids via a small built-in map. For anything not in the map,
// the user can store the CoinGecko id in the asset's `symbol` field.

import type { MarketDataAdapter, Quote } from "./types";

const TICKER_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  USDT: "tether",
  USDC: "usd-coin",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  LINK: "chainlink",
  MATIC: "matic-network",
  LTC: "litecoin",
};

export class CoinGeckoAdapter implements MarketDataAdapter {
  name = "coingecko";
  constructor(private apiKey?: string) {}

  async getQuote(symbol: string): Promise<Quote> {
    const id = TICKER_TO_ID[symbol.toUpperCase()] ?? symbol.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-cg-demo-api-key"] = this.apiKey;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const body = (await res.json()) as Record<
      string,
      { usd: number; last_updated_at: number }
    >;
    const row = body[id];
    if (!row || row.usd === undefined) {
      throw new Error(`CoinGecko: no price for ${symbol} (id=${id})`);
    }
    return {
      price: row.usd,
      currency: "USD",
      as_of: new Date(
        (row.last_updated_at || Date.now() / 1000) * 1000,
      ).toISOString(),
      source: "coingecko",
    };
  }
}
