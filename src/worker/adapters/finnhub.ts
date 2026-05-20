// Finnhub stock/ETF quotes.
// Docs: https://finnhub.io/docs/api/quote
// Free tier: 60 calls/min, real-time US equities.
//
// Response shape:
// { c: 219.16, d: 1.32, dp: 0.6, h: 220, l: 218, o: 219.5, pc: 217.84, t: 1717691400 }

import type { MarketDataAdapter, Quote } from "./types";

export class FinnhubAdapter implements MarketDataAdapter {
  name = "finnhub";
  constructor(private apiKey: string) {}

  async getQuote(symbol: string): Promise<Quote> {
    if (!this.apiKey) throw new Error("FINNHUB_API_KEY not configured");
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const body = (await res.json()) as {
      c: number;
      t: number;
    };
    if (!body.c) throw new Error(`Finnhub: no price for ${symbol}`);
    return {
      price: body.c,
      currency: "USD",
      as_of: new Date((body.t || Date.now() / 1000) * 1000).toISOString(),
      source: "finnhub",
    };
  }
}
