export interface Env {
  DB: D1Database;
  PRICE_CACHE: KVNamespace;
  ASSETS: Fetcher;
  DEFAULT_CURRENCY: string;
  // Secrets (set via `wrangler secret put`)
  FINNHUB_API_KEY?: string;
  COINGECKO_DEMO_API_KEY?: string;
  ALPHAVANTAGE_API_KEY?: string;
}
