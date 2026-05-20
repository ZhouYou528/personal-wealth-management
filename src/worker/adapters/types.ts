export interface Quote {
  price: number;
  currency: string;
  as_of: string; // ISO timestamp
  source: string;
}

export interface MarketDataAdapter {
  name: string;
  /** Fetch a single quote. Throw on unrecoverable errors. */
  getQuote(symbol: string): Promise<Quote>;
}
