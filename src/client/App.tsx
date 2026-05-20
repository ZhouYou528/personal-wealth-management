import { NavLink, Route, Routes } from "react-router-dom";
import { Wallet, ListChecks, TableProperties, BarChart3, Settings } from "lucide-react";
import { Dashboard } from "./pages/Dashboard";
import { Accounts } from "./pages/Accounts";
import { Transactions } from "./pages/Transactions";
import { Positions } from "./pages/Positions";
import { SettingsPage } from "./pages/Settings";
import { cn } from "./lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: BarChart3, exact: true },
  { to: "/positions", label: "Positions", icon: TableProperties },
  { to: "/transactions", label: "Transactions", icon: ListChecks },
  { to: "/accounts", label: "Accounts", icon: Wallet },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function App() {
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-border bg-surface px-3 py-6 hidden md:flex flex-col gap-1">
        <div className="px-3 pb-6">
          <div className="text-lg font-semibold">PWM</div>
          <div className="text-xs text-muted">Personal Wealth Management</div>
        </div>
        {NAV.map(({ to, label, icon: Icon, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent/10 text-accent"
                  : "text-text hover:bg-border/40",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </aside>
      <main className="flex-1 min-w-0">
        <div className="md:hidden flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="font-semibold">PWM</div>
        </div>
        <div className="p-4 md:p-8 max-w-7xl">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
