export interface Env {
  DB: D1Database
  PRICE_CACHE: KVNamespace
  ASSETS: Fetcher
  FINNHUB_KEY: string
  COINGECKO_KEY: string
  ENVIRONMENT?: string
}
