import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { TX_TYPES } from "@shared/schemas";
import { formatCurrency, formatNumber } from "../lib/utils";
import { TransactionForm } from "../components/TransactionForm";

export function Transactions() {
  const accounts = useApi(() => api.listAccounts(), []);
  const [filter, setFilter] = useState<{
    account_id?: number;
    type?: string;
    limit: number;
  }>({ limit: 200 });
  const txs = useApi(
    () => api.listTransactions(filter),
    [filter.account_id, filter.type, filter.limit],
  );
  const [showAdd, setShowAdd] = useState(false);

  const assetIds = useMemo(
    () => Array.from(new Set((txs.data ?? []).map((t) => t.asset_id).filter(Boolean) as number[])),
    [txs.data],
  );
  const assets = useApi(() => api.listAssets(), [assetIds.length]);
  const assetById = useMemo(() => {
    const m = new Map<number, string>();
    (assets.data ?? []).forEach((a) => m.set(a.id, a.symbol));
    return m;
  }, [assets.data]);
  const accountById = useMemo(() => {
    const m = new Map<number, string>();
    (accounts.data ?? []).forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accounts.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="text-sm rounded-md bg-accent text-white px-3 py-1.5 hover:opacity-90"
        >
          Add transaction
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          className="text-sm rounded border border-border bg-surface px-2 py-1.5"
          value={filter.account_id ?? ""}
          onChange={(e) =>
            setFilter({
              ...filter,
              account_id: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        >
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className="text-sm rounded border border-border bg-surface px-2 py-1.5"
          value={filter.type ?? ""}
          onChange={(e) =>
            setFilter({ ...filter, type: e.target.value || undefined })
          }
        >
          <option value="">All types</option>
          {TX_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-x-auto">
        {txs.loading && <div className="p-4 text-sm text-muted">Loading…</div>}
        {txs.error && (
          <div className="p-4 text-sm text-negative">{txs.error.message}</div>
        )}
        {txs.data && txs.data.length === 0 && (
          <div className="p-6 text-sm text-muted">
            No transactions yet. Click <b>Add transaction</b> to log your first
            one.
          </div>
        )}
        {txs.data && txs.data.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Symbol</th>
                <th className="px-4 py-2 font-medium text-right">Qty</th>
                <th className="px-4 py-2 font-medium text-right">Price</th>
                <th className="px-4 py-2 font-medium text-right">Amount</th>
                <th className="px-4 py-2 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {txs.data.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 whitespace-nowrap">{t.trade_date}</td>
                  <td className="px-4 py-2">
                    {accountById.get(t.account_id) ?? `#${t.account_id}`}
                  </td>
                  <td className="px-4 py-2">{t.type}</td>
                  <td className="px-4 py-2">
                    {t.asset_id ? assetById.get(t.asset_id) ?? `#${t.asset_id}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.quantity ? formatNumber(t.quantity) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.price ? formatCurrency(t.price) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-medium">
                    {formatCurrency(t.amount)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={async () => {
                        if (!confirm("Delete this transaction?")) return;
                        await api.deleteTransaction(t.id);
                        txs.reload();
                      }}
                      className="text-xs text-negative hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <TransactionForm
          accounts={accounts.data ?? []}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            txs.reload();
          }}
        />
      )}
    </div>
  );
}
