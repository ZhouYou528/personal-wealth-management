// Shared stale-time constants for React Query — matched to data volatility.
// gcTime is set globally in App.tsx (30 min keeps data alive across navigation).

export const STALE = {
  // Live prices + SnapTrade positions — refresh every 2 min when stale
  prices: 2 * 60_000,
  // NAV snapshots, intraday cron writes every 30 min
  history: 5 * 60_000,
  // Accounts, goals, watchlist, recurring, allocation — user-edited config-like data
  static: 10 * 60_000,
}
