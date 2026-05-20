import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { formatCurrency, formatPercent, plClass, cn } from "../lib/utils";

const COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#94a3b8",
];

export function Dashboard() {
  const netWorth = useApi(() => api.getNetWorth(), []);
  const positions = useApi(() => api.getPositions(), []);
  const navHistory = useApi(() => api.getNavHistory("3M"), []);

  const positionPieData = useMemo(() => {
    if (!positions.data) return [];
    return positions.data
      .filter((p) => p.market_value && p.market_value > 0)
      .map((p) => ({ name: p.symbol, value: p.market_value! }));
  }, [positions.data]);

  const classPieData = useMemo(() => {
    if (!netWorth.data) return [];
    return Object.entries(netWorth.data.by_class).map(([name, value]) => ({
      name,
      value,
    }));
  }, [netWorth.data]);

  const topMovers = useMemo(() => {
    if (!positions.data) return [];
    return [...positions.data]
      .filter((p) => p.unrealized_pl !== null)
      .sort(
        (a, b) =>
          Math.abs(b.unrealized_pl_pct ?? 0) -
          Math.abs(a.unrealized_pl_pct ?? 0),
      )
      .slice(0, 5);
  }, [positions.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <button
          onClick={async () => {
            await api.refreshPrices();
            netWorth.reload();
            positions.reload();
          }}
          className="text-sm rounded-md border border-border px-3 py-1.5 hover:bg-border/40"
        >
          Refresh prices
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Total net worth"
          value={
            netWorth.data ? formatCurrency(netWorth.data.total) : "Loading…"
          }
        />
        <Tile label="Positions" value={String(positions.data?.length ?? "—")} />
        <Tile
          label="As of"
          value={
            netWorth.data
              ? new Date(netWorth.data.as_of).toLocaleString()
              : "—"
          }
        />
        <Tile
          label="Stale prices"
          value={String(netWorth.data?.stale_assets.length ?? 0)}
          tone={
            netWorth.data && netWorth.data.stale_assets.length > 0
              ? "warn"
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Composition by asset class">
          <ChartHeight>
            {classPieData.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={classPieData}
                    dataKey="value"
                    nameKey="name"
                    outerRadius="80%"
                    label={(entry) => entry.name}
                  >
                    {classPieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => formatCurrency(v)}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartHeight>
        </Card>

        <Card title="Composition by position">
          <ChartHeight>
            {positionPieData.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={positionPieData}
                    dataKey="value"
                    nameKey="name"
                    outerRadius="80%"
                  >
                    {positionPieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number) => formatCurrency(v)}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartHeight>
        </Card>
      </div>

      <Card title="Net worth — last 3 months">
        <ChartHeight>
          {!navHistory.data || navHistory.data.length === 0 ? (
            <Empty hint="Snapshots are written nightly. Once you've used the app for a few days they'll appear here." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={navHistory.data}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
                <XAxis dataKey="date" />
                <YAxis tickFormatter={(v) => formatCurrency(v)} width={90} />
                <Tooltip
                  formatter={(v: number) => formatCurrency(v)}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke={COLORS[0]}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartHeight>
      </Card>

      <Card title="Top movers">
        {topMovers.length === 0 ? (
          <Empty />
        ) : (
          <div className="divide-y divide-border">
            {topMovers.map((p) => (
              <div
                key={p.asset_id + "-" + p.account_id}
                className="py-2 flex items-center justify-between"
              >
                <div>
                  <div className="font-medium">{p.symbol}</div>
                  <div className="text-xs text-muted">{p.account_name}</div>
                </div>
                <div className={cn("text-right", plClass(p.unrealized_pl))}>
                  <div className="font-medium">
                    {formatCurrency(p.unrealized_pl)}
                  </div>
                  <div className="text-xs">
                    {formatPercent(p.unrealized_pl_pct)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cn(
          "text-2xl font-semibold mt-1",
          tone === "warn" ? "text-amber-500" : "",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-sm font-medium mb-3">{title}</div>
      {children}
    </div>
  );
}

function ChartHeight({ children }: { children: React.ReactNode }) {
  return <div className="h-72">{children}</div>;
}

function Empty({ hint }: { hint?: string }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted">
      <div className="text-center">
        <div>No data yet.</div>
        {hint && <div className="mt-1 text-xs">{hint}</div>}
      </div>
    </div>
  );
}
