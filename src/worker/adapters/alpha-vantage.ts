// Alpha Vantage — used as a fallback for stocks if Finnhub fails or hits rate limits.
// Docs: https://www.alphavantage.co/documentation/#latestprice
// Free tier: 25 requests/day. Use sparingly.

import type { MarketDataAdapter, Quote } from "./types";

export class AlphaVantageAdapter implements MarketDataAdapter {
  name = "alphavantage";
  constructor(private apiKey: string) {}

  async getQuote(symbol: string): Promise<Quote> {
    if (!this.apiKey) throw new Error("ALPHAVANTAGE_API_KEY not configured");
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AlphaVantage HTTP ${res.status}`);
    const body = (await res.json()) as {
      "Global Quote"?: {
        "05. price"?: string;
        "07. latest trading day"?: string;
      };
      Note?: string;
    };
    if (body.Note) throw new Error(`AlphaVantage rate limit: ${body.Note}`);
    const q = body["Global Quote"];
    const priceStr = q?.["05. price"];
    if (!q || !priceStr) {
      throw new Error(`AlphaVantage: no price for ${symbol}`);
    }
    return {
      price: Number(priceStr),
      currency: "USD",
      as_of: q["07. latest trading day"]
        ? `${q["07. latest trading day"]}T20:00:00Z`
        : new Date().toISOString(),
      source: "alphavantage",
    };
  }
}
