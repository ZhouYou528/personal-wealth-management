export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="rounded-lg border border-border bg-surface p-4 space-y-3 text-sm">
        <div>
          <div className="font-medium mb-1">Market data providers</div>
          <p className="text-muted">
            API keys are stored as Cloudflare Worker Secrets. Set them with:
          </p>
          <pre className="bg-bg border border-border rounded p-2 text-xs mt-2 overflow-x-auto">{`wrangler secret put FINNHUB_API_KEY
wrangler secret put COINGECKO_DEMO_API_KEY
wrangler secret put ALPHAVANTAGE_API_KEY`}</pre>
          <p className="text-muted mt-2">
            For local dev, copy <code>.dev.vars.example</code> to{" "}
            <code>.dev.vars</code> and fill in the same keys.
          </p>
        </div>
        <div>
          <div className="font-medium mb-1">Free API key signup links</div>
          <ul className="text-muted list-disc pl-5 space-y-1">
            <li>
              Finnhub:{" "}
              <a className="text-accent" href="https://finnhub.io/" target="_blank" rel="noreferrer">
                finnhub.io
              </a>{" "}
              — 60 calls/min, real-time US equities
            </li>
            <li>
              CoinGecko Demo:{" "}
              <a className="text-accent" href="https://www.coingecko.com/en/api/pricing" target="_blank" rel="noreferrer">
                coingecko.com
              </a>{" "}
              — 30 calls/min, 10K/month
            </li>
            <li>
              Alpha Vantage:{" "}
              <a className="text-accent" href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noreferrer">
                alphavantage.co
              </a>{" "}
              — fallback / EOD history
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
