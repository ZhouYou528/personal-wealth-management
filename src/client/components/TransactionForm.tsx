import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  ASSET_CLASSES,
  TX_TYPES,
  OPTION_TYPES,
  defaultAmount,
  type Account,
  type Asset,
  type AssetClass,
  type OptionType,
  type TransactionCreate,
  type TransactionType,
} from "@shared/schemas";
import { useApi } from "../lib/useApi";

// Type-aware transaction form.
// - For position-affecting types (buy/sell/dividend/option_*), shows asset autocomplete + qty/price.
// - For pure-cash types (deposit/withdrawal/interest/fee/tax), shows only the amount field.
// - For options, the asset autocomplete is replaced by an inline option contract definition.

const POSITION_TYPES = new Set<TransactionType>([
  "buy",
  "sell",
  "dividend",
  "option_exercise",
  "option_assignment",
  "option_expiry",
  "staking_reward",
  "airdrop",
  "split",
  "gift_in",
  "gift_out",
]);
const CASH_ONLY_TYPES = new Set<TransactionType>([
  "deposit",
  "withdrawal",
  "interest",
  "fee",
  "tax",
  "adjustment",
  "transfer_in",
  "transfer_out",
]);

export function TransactionForm({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TransactionCreate>({
    account_id: accounts[0]?.id ?? 0,
    asset_id: null,
    type: "buy",
    trade_date: new Date().toISOString().slice(0, 10),
    quantity: 0,
    price: 0,
    fee: 0,
    amount: 0,
    notes: "",
  });

  const [assetClass, setAssetClass] = useState<AssetClass>("stock");
  const [symbol, setSymbol] = useState("");
  const [optionType, setOptionType] = useState<OptionType>("call");
  const [strike, setStrike] = useState<number>(0);
  const [expiry, setExpiry] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const showAsset = POSITION_TYPES.has(form.type);
  const showOptionFields =
    showAsset && assetClass === "option" && form.type !== "option_expiry";

  // Auto-fill amount when qty/price/fee/type change, unless user has manually edited.
  const [amountTouched, setAmountTouched] = useState(false);
  useEffect(() => {
    if (amountTouched) return;
    const next = defaultAmount({
      type: form.type,
      quantity: form.quantity ?? 0,
      price: form.price ?? 0,
      fee: form.fee ?? 0,
    });
    setForm((f) => ({ ...f, amount: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.type, form.quantity, form.price, form.fee]);

  // Symbol search (Phase 3 will hit external API; for now we just hit our own /assets/search).
  const search = useApi(
    () => (symbol.length >= 1 ? api.searchAssets(symbol) : Promise.resolve([])),
    [symbol],
  );

  const accountCurrency =
    accounts.find((a) => a.id === form.account_id)?.currency ?? "USD";

  const canSave = useMemo(() => {
    if (!form.account_id) return false;
    if (!form.trade_date) return false;
    if (showAsset && !form.asset_id && !symbol.trim()) return false;
    return true;
  }, [form, showAsset, symbol]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      let assetId = form.asset_id ?? null;
      if (showAsset && !assetId && symbol.trim()) {
        // Create the asset on the fly so the user doesn't need a separate step.
        const created = await api.createAsset({
          symbol: symbol.trim().toUpperCase(),
          asset_class: assetClass,
          currency: accountCurrency,
          ...(showOptionFields && {
            option_type: optionType,
            strike,
            expiry,
            multiplier: 100,
            underlying: symbol.trim().toUpperCase().split(" ")[0],
          }),
        });
        assetId = created.id;
      }
      await api.createTransaction({ ...form, asset_id: assetId });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-surface rounded-lg border border-border w-full max-w-xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="text-lg font-semibold">Add transaction</div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-xs text-muted mb-1">Type</div>
            <select
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.type}
              onChange={(e) => {
                setForm({ ...form, type: e.target.value as TransactionType });
                setAmountTouched(false);
              }}
            >
              {TX_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Account</div>
            <select
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.account_id}
              onChange={(e) =>
                setForm({ ...form, account_id: Number(e.target.value) })
              }
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Trade date</div>
            <input
              type="date"
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.trade_date}
              onChange={(e) => setForm({ ...form, trade_date: e.target.value })}
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Settle date (optional)</div>
            <input
              type="date"
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.settle_date ?? ""}
              onChange={(e) => setForm({ ...form, settle_date: e.target.value })}
            />
          </label>
        </div>

        {showAsset && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-xs text-muted mb-1">Asset class</div>
                <select
                  className="w-full rounded border border-border bg-bg px-2 py-1.5"
                  value={assetClass}
                  onChange={(e) =>
                    setAssetClass(e.target.value as AssetClass)
                  }
                >
                  {ASSET_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">
                  Symbol
                  <span className="text-muted/70">
                    {" "}
                    (e.g. AAPL, BTC, VOO)
                  </span>
                </div>
                <input
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 uppercase"
                  value={symbol}
                  onChange={(e) => {
                    setSymbol(e.target.value);
                    setForm({ ...form, asset_id: null });
                  }}
                />
                {symbol && search.data && search.data.length > 0 && (
                  <div className="mt-1 max-h-32 overflow-y-auto rounded border border-border bg-surface text-xs">
                    {search.data.map((a: Asset) => (
                      <button
                        key={a.id}
                        type="button"
                        className="block w-full text-left px-2 py-1 hover:bg-border/40"
                        onClick={() => {
                          setSymbol(a.symbol);
                          setAssetClass(a.asset_class);
                          setForm({ ...form, asset_id: a.id });
                        }}
                      >
                        <span className="font-medium">{a.symbol}</span>{" "}
                        <span className="text-muted">
                          {a.name ?? a.asset_class}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </label>
            </div>

            {showOptionFields && (
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <div className="text-xs text-muted mb-1">Call/Put</div>
                  <select
                    className="w-full rounded border border-border bg-bg px-2 py-1.5"
                    value={optionType}
                    onChange={(e) =>
                      setOptionType(e.target.value as OptionType)
                    }
                  >
                    {OPTION_TYPES.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Strike</div>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full rounded border border-border bg-bg px-2 py-1.5"
                    value={strike || ""}
                    onChange={(e) => setStrike(Number(e.target.value))}
                  />
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Expiry</div>
                  <input
                    type="date"
                    className="w-full rounded border border-border bg-bg px-2 py-1.5"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <div className="text-xs text-muted mb-1">
                  Quantity
                  {assetClass === "option" && (
                    <span className="text-muted/70"> (contracts)</span>
                  )}
                </div>
                <input
                  type="number"
                  step="any"
                  className="w-full rounded border border-border bg-bg px-2 py-1.5"
                  value={form.quantity ?? 0}
                  onChange={(e) =>
                    setForm({ ...form, quantity: Number(e.target.value) })
                  }
                />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Price / unit</div>
                <input
                  type="number"
                  step="any"
                  className="w-full rounded border border-border bg-bg px-2 py-1.5"
                  value={form.price ?? 0}
                  onChange={(e) =>
                    setForm({ ...form, price: Number(e.target.value) })
                  }
                />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Fee</div>
                <input
                  type="number"
                  step="any"
                  className="w-full rounded border border-border bg-bg px-2 py-1.5"
                  value={form.fee ?? 0}
                  onChange={(e) =>
                    setForm({ ...form, fee: Number(e.target.value) })
                  }
                />
              </label>
            </div>
          </>
        )}

        {CASH_ONLY_TYPES.has(form.type) && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-muted mb-1">Amount</div>
              <input
                type="number"
                step="any"
                className="w-full rounded border border-border bg-bg px-2 py-1.5"
                value={Math.abs(form.amount)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const sign =
                    form.type === "withdrawal" ||
                    form.type === "fee" ||
                    form.type === "tax" ||
                    form.type === "transfer_out"
                      ? -1
                      : 1;
                  setForm({ ...form, amount: sign * Math.abs(v) });
                  setAmountTouched(true);
                }}
              />
            </label>
          </div>
        )}

        {showAsset && (
          <label className="block">
            <div className="text-xs text-muted mb-1">
              Cash impact (auto-computed; edit if needed)
            </div>
            <input
              type="number"
              step="any"
              className="w-full rounded border border-border bg-bg px-2 py-1.5"
              value={form.amount}
              onChange={(e) => {
                setForm({ ...form, amount: Number(e.target.value) });
                setAmountTouched(true);
              }}
            />
          </label>
        )}

        <label className="block">
          <div className="text-xs text-muted mb-1">Notes (optional)</div>
          <input
            className="w-full rounded border border-border bg-bg px-2 py-1.5"
            value={form.notes ?? ""}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>

        {err && <div className="text-xs text-negative">{err}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="text-sm rounded-md border border-border px-3 py-1.5 hover:bg-border/40"
          >
            Cancel
          </button>
          <button
            disabled={!canSave || saving}
            onClick={save}
            className="text-sm rounded-md bg-accent text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
