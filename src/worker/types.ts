export interface Env {
  DB: D1Database
  PRICE_CACHE: KVNamespace
  ASSETS: Fetcher
  FINNHUB_KEY: string
  COINGECKO_KEY: string
  SNAPTRADE_CLIENT_ID: string
  SNAPTRADE_CONSUMER_KEY: string
  IBKR_FLEX_TOKEN: string
  IBKR_FLEX_QUERY_ID: string
  ENVIRONMENT?: string
  APP_SECRET?: string
}
