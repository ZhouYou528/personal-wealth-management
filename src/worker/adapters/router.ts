// Routes a quote lookup to the right adapter based on asset class.
// Caches results in KV for 60s to spare API rate limits.

import type { Env } from "../types";
import { FinnhubAdapter } from "./finnhub";
import { CoinGeckoAdapter } from "./coingecko";
import { AlphaVantageAdapter } from "./alpha-vantage";
import type { Quote } from "./types";

export type AssetClassLite =
  | "stock"
  | "etf"
  | "crypto"
  | "option"
  | "cash"
  | "bond"
  | "other";

const CACHE_TTL_SECONDS = 60;

export async function getQuote(
  env: Env,
  symbol: string,
  assetClass: AssetClassLite,
): Promise<Quote> {
  const cacheKey = `quote:${assetClass}:${symbol.toUpperCase()}`;
  const cached = await env.PRICE_CACHE.get(cacheKey, "json");
  if (cached) return cached as Quote;

  let q: Quote;
  if (assetClass === "crypto") {
    q = await new CoinGeckoAdapter(env.COINGECKO_DEMO_API_KEY).getQuote(symbol);
  } else if (assetClass === "stock" || assetClass === "etf") {
    try {
      q = await new FinnhubAdapter(env.FINNHUB_API_KEY ?? "").getQuote(symbol);
    } catch (e) {
      if (!env.ALPHAVANTAGE_API_KEY) throw e;
      q = await new AlphaVantageAdapter(env.ALPHAVANTAGE_API_KEY).getQuote(symbol);
    }
  } else if (assetClass === "cash") {
    // Cash always priced at 1.0 in its own currency.
    q = {
      price: 1,
      currency: "USD",
      as_of: new Date().toISOString(),
      source: "internal",
    };
  } else if (assetClass === "option") {
    // Free options data is unreliable on most providers. Best-effort: try
    // Finnhub options endpoint if you upgrade; otherwise let the user enter a
    // manual mark via the transaction price field, and we'll fall back to the
    // last known transaction price for valuation.
    throw new Error(
      "Live option pricing unavailable on free tier — falling back to last manual price",
    );
  } else {
    throw new Error(`Unsupported asset class: ${assetClass}`);
  }

  await env.PRICE_CACHE.put(cacheKey, JSON.stringify(q), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return q;
}
