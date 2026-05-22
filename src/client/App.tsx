import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Layout } from './components/Layout'
import { AddTxModal } from './components/AddTxModal'
import { Dashboard } from './pages/Dashboard'
import { Holdings } from './pages/Holdings'
import { HoldingDetail } from './pages/HoldingDetail'
import { Transactions } from './pages/Transactions'
import { Watchlist } from './pages/Watchlist'
import { Accounts } from './pages/Accounts'
import { Goals } from './pages/Goals'
import { Import } from './pages/Import'
import { Recurring } from './pages/Recurring'
import { useStore } from './lib/store'

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

function AppShell() {
  const { darkMode, accent } = useStore()

  // Sync persisted preferences to DOM on mount
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    if (accent !== 'emerald') {
      document.documentElement.dataset.accent = accent
    }
  }, [])

  return (
    <>
      <Routes>
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
        <AppShell />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
