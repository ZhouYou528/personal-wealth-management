import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard, Layers, List, Eye, EyeOff, Target, Plus,
  RefreshCw, Menu, X, Wallet, BookOpen, Upload, Repeat, BarChart3, Scale,
  Moon, Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { Button } from './ui/button'
import { useQueryClient, useIsFetching } from '@tanstack/react-query'

const PRIMARY_NAV = [
  { to: '/',             label: 'Dashboard',    icon: LayoutDashboard },
  { to: '/holdings',     label: 'Holdings',     icon: Layers },
  { to: '/transactions', label: 'Transactions', icon: List },
  { to: '/watchlist',    label: 'Watchlist',    icon: BookOpen },
  { to: '/insights',     label: 'Insights',     icon: BarChart3 },
  { to: '/allocation',   label: 'Allocation',   icon: Scale },
]

const SECONDARY_NAV = [
  { to: '/accounts',  label: 'Accounts',  icon: Wallet },
  { to: '/goals',     label: 'Goals',     icon: Target },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/import',    label: 'Import',    icon: Upload },
]

type NavDef = { to: string; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }

function NavItem({ to, label, icon: Icon }: NavDef) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13.5px] font-medium transition-all duration-150',
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-text-2 hover:bg-surface-2 hover:text-text'
        )
      }
    >
      <Icon size={16} strokeWidth={1.75} />
      {label}
    </NavLink>
  )
}

function Sidebar({ onClose }: { onClose?: () => void }) {
  return (
    <aside className="flex flex-col h-full w-56 bg-surface border-r border-border px-3 py-4">
      {/* Logo */}
      <div className="flex items-center justify-between px-2 mb-5">
        <span className="font-display text-[19px] text-text italic tracking-tight">Meridian</span>
        {onClose && (
          <button onClick={onClose} className="text-text-3 hover:text-text p-0.5 transition-colors">
            <X size={18} />
          </button>
        )}
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 flex-1">
        {PRIMARY_NAV.map((item) => <NavItem key={item.to} {...item} />)}

        {/* Divider */}
        <div className="my-2 border-t border-border/60" />

        {/* Secondary nav */}
        {SECONDARY_NAV.map((item) => <NavItem key={item.to} {...item} />)}
      </nav>

      {/* Status indicator */}
      <StatusDot />
    </aside>
  )
}

function StatusDot() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="w-1.5 h-1.5 rounded-full bg-up pulse-dot" />
      <span className="text-[11px] text-text-3 uppercase tracking-wider">Live · Finnhub</span>
    </div>
  )
}

export function Layout() {
  const { privacyMode, togglePrivacy, mobileNavOpen, setMobileNavOpen, openAddTx,
          currency, setCurrency, darkMode, toggleDarkMode } = useStore()
  const qc = useQueryClient()
  const isFetching = useIsFetching()

  return (
    <div className={cn('flex h-screen overflow-hidden', privacyMode && 'private')}>
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <div className="relative z-10 modal-pop">
            <Sidebar onClose={() => setMobileNavOpen(false)} />
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between h-12 px-4 lg:px-6 border-b border-border bg-surface/80 backdrop-blur-sm flex-shrink-0">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={18} />
            </Button>
            <span className="font-display italic text-[17px] text-text lg:hidden tracking-tight">Meridian</span>
          </div>

          <div className="flex items-center gap-1">
            <div className="flex items-center gap-0.5 mr-1">
              <button
                onClick={() => setCurrency(currency === 'USD' ? 'CAD' : 'USD')}
                title={`Display currency: ${currency} · click to switch`}
                className="px-2.5 py-1.5 rounded-lg text-[11.5px] font-bold tabular tracking-wider text-text-2 hover:text-text hover:bg-surface-2 transition-all duration-150"
              >
                {currency}
              </button>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => qc.invalidateQueries()}
                title="Refresh"
              >
                <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={toggleDarkMode}
                title={darkMode ? 'Light mode' : 'Dark mode'}
              >
                {darkMode ? <Sun size={14} /> : <Moon size={14} />}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={togglePrivacy}
                title={privacyMode ? 'Show values' : 'Hide values'}
              >
                {privacyMode ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            </div>

            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => openAddTx()}
            >
              <Plus size={14} />
              <span className="hidden sm:inline">Add transaction</span>
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
