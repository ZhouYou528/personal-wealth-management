import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ASSET_CLASSES } from "@shared/schemas";
import { formatCurrency, formatNumber, formatPercent, plClass, cn } from "../lib/utils";

export function Positions() {
  const positions = useApi(() => api.getPositions(), []);
  const [classFilter, setClassFilter] = useState<string>("");

  const filtered = useMemo(() => {
    if (!positions.data) return [];
    return positions.data.filter(
      (p) => !classFilter || p.asset_class === classFilter,
    );
  }, [positions.data, classFilter]);

  const totalMV = filtered.reduce((s, p) => s + (p.market_value ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold">Positions</h1>
        <div className="flex items-center gap-2">
          <select
            className="text-sm rounded border border-border bg-surface px-2 py-1.5"
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
          >
            <option value="">All asset classes</option>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              await api.refreshPrices();
              positions.reload();
            }}
            className="text-sm rounded-md border border-border px-3 py-1.5 hover:bg-border/40"
          >
            Refresh prices
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-x-auto">
        {positions.loading && (
          <div className="p-4 text-sm text-muted">Loading…</div>
        )}
        {positions.error && (
          <div className="p-4 text-sm text-negative">
            {positions.error.message}
          </div>
        )}
        {positions.data && filtered.length === 0 && (
          <div className="p-6 text-sm text-muted">
            No open positions.
          </div>
        )}
        {filtered.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Symbol</th>
                <th className="px-4 py-2 font-medium">Class</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium text-right">Qty</th>
                <th className="px-4 py-2 font-medium text-right">Avg cost</th>
                <th className="px-4 py-2 font-medium text-right">Price</th>
                <th className="px-4 py-2 font-medium text-right">Mkt value</th>
                <th className="px-4 py-2 font-medium text-right">Unreal. P/L</th>
                <th className="px-4 py-2 font-medium text-right">P/L %</th>
                <th className="px-4 py-2 font-medium text-right">% of total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.asset_id + "-" + p.account_id}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="px-4 py-2 font-medium">{p.symbol}</td>
                  <td className="px-4 py-2 text-muted">{p.asset_class}</td>
                  <td className="px-4 py-2">{p.account_name}</td>
                  <td className="px-4 py-2 text-right">
                    {formatNumber(p.quantity)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatCurrency(p.avg_cost)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatCurrency(p.current_price)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatCurrency(p.market_value)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 text-right",
                      plClass(p.unrealized_pl),
                    )}
                  >
                    {formatCurrency(p.unrealized_pl)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 text-right",
                      plClass(p.unrealized_pl),
                    )}
                  >
                    {formatPercent(p.unrealized_pl_pct)}
                  </td>
                  <td className="px-4 py-2 text-right text-muted">
                    {totalMV > 0 && p.market_value
                      ? formatPercent(p.market_value / totalMV)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
