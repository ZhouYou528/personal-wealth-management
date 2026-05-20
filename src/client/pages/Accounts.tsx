import { useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ACCOUNT_TYPES, type AccountType, type AccountCreate } from "@shared/schemas";

export function Accounts() {
  const accounts = useApi(() => api.listAccounts(), []);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="text-sm rounded-md bg-accent text-white px-3 py-1.5 hover:opacity-90"
        >
          New account
        </button>
      </div>

      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        {accounts.loading && <div className="p-4 text-sm text-muted">Loading…</div>}
        {accounts.error && (
          <div className="p-4 text-sm text-negative">
            {accounts.error.message}
          </div>
        )}
        {accounts.data && accounts.data.length === 0 && (
          <div className="p-6 text-sm text-muted">
            No accounts yet. Click <b>New account</b> to add your first one
            (e.g. "Schwab Brokerage" or "Chase Checking").
          </div>
        )}
        {accounts.data && accounts.data.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Currency</th>
                <th className="px-4 py-2 font-medium">Institution</th>
                <th className="px-4 py-2 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.data.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2">{a.name}</td>
                  <td className="px-4 py-2">{a.type}</td>
                  <td className="px-4 py-2">{a.currency}</td>
                  <td className="px-4 py-2">{a.institution ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete "${a.name}"?`)) return;
                        await api.deleteAccount(a.id);
                        accounts.reload();
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
        <AccountForm
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            accounts.reload();
          }}
        />
      )}
    </div>
  );
}

function AccountForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<AccountCreate>({
    name: "",
    type: "brokerage",
    currency: "USD",
    institution: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-surface rounded-lg border border-border w-full max-w-md p-5 space-y-4">
        <div className="text-lg font-semibold">New account</div>
        <div className="space-y-3">
          <label className="block">
            <div className="text-xs text-muted mb-1">Name</div>
            <input
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Schwab Brokerage"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Type</div>
            <select
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as AccountType })
              }
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Currency</div>
            <input
              className="w-full rounded border border-border bg-bg px-2 py-1.5 uppercase"
              value={form.currency}
              maxLength={3}
              onChange={(e) =>
                setForm({ ...form, currency: e.target.value.toUpperCase() })
              }
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Institution (optional)</div>
            <input
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.institution ?? ""}
              onChange={(e) =>
                setForm({ ...form, institution: e.target.value })
              }
            />
          </label>
        </div>
        {err && <div className="text-xs text-negative">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="text-sm rounded-md border border-border px-3 py-1.5 hover:bg-border/40"
          >
            Cancel
          </button>
          <button
            disabled={saving || !form.name.trim()}
            onClick={async () => {
              setSaving(true);
              setErr(null);
              try {
                await api.createAccount(form);
                onSaved();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
            className="text-sm rounded-md bg-accent text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
