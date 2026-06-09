import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Layout } from './components/Layout'
import { AddTxModal } from './components/AddTxModal'
import { Flashbar } from './components/Flashbar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginGate } from './components/LoginGate'
import { useErrorStore } from './lib/errors'
import { Dashboard } from './pages/Dashboard'
import { Holdings } from './pages/Holdings'
import { HoldingDetail } from './pages/HoldingDetail'
import { Transactions } from './pages/Transactions'
import { Watchlist } from './pages/Watchlist'
import { Accounts } from './pages/Accounts'
import { Goals } from './pages/Goals'
import { Import } from './pages/Import'
import { Recurring } from './pages/Recurring'
import { Insights } from './pages/Insights'
import { Allocation } from './pages/Allocation'
import { CreditCards } from './pages/CreditCards'
import { useStore } from './lib/store'
import { STALE } from './lib/cache'

function SnapTradeCallback() {
  useEffect(() => {
    window.opener?.postMessage({ type: 'snaptrade-connected' }, window.location.origin)
    window.close()
  }, [])
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center', paddingTop: '20vh', color: '#10B981' }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto 16px' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <h2 style={{ margin: 0, fontSize: '1.25rem', color: '#111' }}>Connected!</h2>
      <p style={{ color: '#6b7280', marginTop: '8px' }}>You can close this window and return to the app.</p>
    </div>
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

const qc = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => useErrorStore.getState().pushError(errorMessage(err)),
  }),
  mutationCache: new MutationCache({
    onError: (err) => useErrorStore.getState().pushError(errorMessage(err)),
  }),
  defaultOptions: {
    queries: {
      staleTime: STALE.prices, // 2 min default — good for live prices; overridden per query below
      gcTime: 30 * 60_000,     // keep data in memory 30 min so navigating back is instant
      retry: 1,
    },
  },
})

function AppShell() {
  const { darkMode, accent, apiSecret } = useStore()

  // Sync persisted preferences to DOM on mount
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    if (accent !== 'emerald') {
      document.documentElement.dataset.accent = accent
    }
  }, [])

  if (!apiSecret) return <LoginGate />

  return (
    <>
      <Routes>
        <Route path="snaptrade/callback" element={<SnapTradeCallback />} />
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="holdings" element={<Holdings />} />
          <Route path="holdings/:id" element={<HoldingDetail />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="goals" element={<Goals />} />
          <Route path="import" element={<Import />} />
          <Route path="recurring" element={<Recurring />} />
          <Route path="insights"   element={<Insights />} />
          <Route path="allocation" element={<Allocation />} />
          <Route path="credit-cards" element={<CreditCards />} />
        </Route>
      </Routes>
      <AddTxModal />
    </>
  )
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
        <Flashbar />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
