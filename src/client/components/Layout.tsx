import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Layers, List, Eye, EyeOff, Target, Plus,
  RefreshCw, X, Wallet, BookOpen, Upload, Repeat, BarChart3, Scale,
  Moon, Sun, MoreHorizontal, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { Button } from './ui/button'
import { useQueryClient, useIsFetching } from '@tanstack/react-query'
import { useState } from 'react'

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

// Bottom tabs: first 4 + More
const BOTTOM_TABS = [
  { to: '/',             label: 'Home',         icon: LayoutDashboard },
  { to: '/holdings',     label: 'Holdings',     icon: Layers },
  { to: '/transactions', label: 'Tx',           icon: List },
  { to: '/watchlist',    label: 'Watchlist',    icon: BookOpen },
]

// "More" sheet items
const MORE_ITEMS = [
  { to: '/insights',   label: 'Insights',   icon: BarChart3 },
  { to: '/allocation', label: 'Allocation', icon: Scale },
  { to: '/accounts',   label: 'Accounts',   icon: Wallet },
  { to: '/goals',      label: 'Goals',      icon: Target },
  { to: '/recurring',  label: 'Recurring',  icon: Repeat },
  { to: '/import',     label: 'Import',     icon: Upload },
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

function Sidebar() {
  return (
    <aside className="flex flex-col h-full w-56 bg-surface border-r border-border px-3 py-4">
      {/* Logo */}
      <div className="flex items-center px-2 mb-5">
        <span className="font-display text-[19px] text-text italic tracking-tight">Meridian</span>
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

function BottomTabBar({ onMoreOpen }: { onMoreOpen: () => void }) {
  const location = useLocation()
  const moreActive = MORE_ITEMS.some(i => location.pathname === i.to)

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/90 backdrop-blur-md border-t border-border flex items-stretch h-[58px]">
      {BOTTOM_TABS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors duration-150',
              isActive ? 'text-accent' : 'text-text-3'
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon size={20} strokeWidth={isActive ? 2 : 1.75} />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
      {/* More tab */}
      <button
        onClick={onMoreOpen}
        className={cn(
          'flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors duration-150',
          moreActive ? 'text-accent' : 'text-text-3'
        )}
      >
        <MoreHorizontal size={20} strokeWidth={moreActive ? 2 : 1.75} />
        <span>More</span>
      </button>
    </nav>
  )
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()

  if (!open) return null

  function go(to: string) {
    navigate(to)
    onClose()
  }

  return (
    <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Sheet */}
      <div className="relative z-10 bg-surface rounded-t-2xl pb-safe slide-up">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border">
          <span className="text-[13.5px] font-semibold text-text">More</span>
          <button onClick={onClose} className="text-text-3 hover:text-text transition-colors p-1">
            <X size={18} />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-px bg-border">
          {MORE_ITEMS.map(({ to, label, icon: Icon }) => (
            <button
              key={to}
              onClick={() => go(to)}
              className="bg-surface flex flex-col items-center justify-center gap-2 py-5 hover:bg-surface-2 transition-colors active:bg-surface-2"
            >
              <Icon size={22} strokeWidth={1.75} className="text-accent" />
              <span className="text-[12px] font-medium text-text">{label}</span>
            </button>
          ))}
        </div>
        <div className="h-6" />
      </div>
    </div>
  )
}

export function Layout() {
  const { privacyMode, togglePrivacy, openAddTx,
          currency, setCurrency, darkMode, toggleDarkMode } = useStore()
  const qc = useQueryClient()
  const isFetching = useIsFetching()
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div className={cn('flex h-screen overflow-hidden', privacyMode && 'private')}>
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile More sheet */}
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />

      {/* Main */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between h-12 px-4 lg:px-6 border-b border-border bg-surface/80 backdrop-blur-sm flex-shrink-0">
          <div className="flex items-center gap-2">
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

        {/* Page content — bottom padding on mobile to clear tab bar */}
        <main className="flex-1 overflow-y-auto pb-[58px] lg:pb-0">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      <BottomTabBar onMoreOpen={() => setMoreOpen(true)} />
    </div>
  )
}
