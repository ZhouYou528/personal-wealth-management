import { z } from "zod";

// Shared between client and Worker. Single source of truth.

// -------- Enums --------

export const ASSET_CLASSES = [
  "stock",
  "etf",
  "option",
  "crypto",
  "cash",
  "bond",
  "other",
] as const;
export const AssetClass = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof AssetClass>;

export const ACCOUNT_TYPES = [
  "brokerage",
  "bank",
  "crypto_exchange",
  "wallet",
  "retirement",
  "other",
] as const;
export const AccountType = z.enum(ACCOUNT_TYPES);
export type AccountType = z.infer<typeof AccountType>;

export const TX_TYPES = [
  "buy",
  "sell",
  "deposit",
  "withdrawal",
  "transfer_in",
  "transfer_out",
  "dividend",
  "interest",
  "fee",
  "tax",
  "split",
  "option_exercise",
  "option_assignment",
  "option_expiry",
  "staking_reward",
  "airdrop",
  "gift_in",
  "gift_out",
  "adjustment",
] as const;
export const TransactionType = z.enum(TX_TYPES);
export type TransactionType = z.infer<typeof TransactionType>;

export const OPTION_TYPES = ["call", "put"] as const;
export const OptionType = z.enum(OPTION_TYPES);
export type OptionType = z.infer<typeof OptionType>;

// -------- Accounts --------

export const AccountCreate = z.object({
  name: z.string().min(1).max(120),
  type: AccountType,
  currency: z.string().length(3).default("USD"),
  institution: z.string().max(120).optional().nullable(),
});
export type AccountCreate = z.infer<typeof AccountCreate>;

export const Account = AccountCreate.extend({
  id: z.number().int().positive(),
  created_at: z.string(),
});
export type Account = z.infer<typeof Account>;

// -------- Assets --------

export const AssetCreate = z.object({
  symbol: z.string().min(1).max(64),
  name: z.string().max(200).optional().nullable(),
  asset_class: AssetClass,
  currency: z.string().length(3).default("USD"),
  underlying: z.string().max(32).optional().nullable(),
  option_type: OptionType.optional().nullable(),
  strike: z.number().positive().optional().nullable(),
  expiry: z.string().optional().nullable(), // ISO yyyy-mm-dd
  multiplier: z.number().int().positive().optional().nullable(),
});
export type AssetCreate = z.infer<typeof AssetCreate>;

export const Asset = AssetCreate.extend({
  id: z.number().int().positive(),
});
export type Asset = z.infer<typeof Asset>;

// -------- Transactions --------

export const TransactionCreate = z.object({
  account_id: z.number().int().positive(),
  asset_id: z.number().int().positive().nullable().optional(),
  type: TransactionType,
  trade_date: z.string(), // ISO yyyy-mm-dd
  settle_date: z.string().nullable().optional(),
  quantity: z.number().default(0),
  price: z.number().default(0),
  fee: z.number().default(0),
  amount: z.number(), // signed cash impact
  fx_rate: z.number().positive().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  external_ref: z.string().max(200).nullable().optional(),
});
export type TransactionCreate = z.infer<typeof TransactionCreate>;

export const Transaction = TransactionCreate.extend({
  id: z.number().int().positive(),
  created_at: z.string(),
});
export type Transaction = z.infer<typeof Transaction>;

// -------- Prices --------

export const Price = z.object({
  asset_id: z.number().int().positive(),
  price: z.number(),
  currency: z.string().length(3),
  as_of: z.string(),
  source: z.string(),
});
export type Price = z.infer<typeof Price>;

// -------- Positions (computed, not persisted) --------

export const Position = z.object({
  asset_id: z.number().int().positive(),
  symbol: z.string(),
  name: z.string().nullable(),
  asset_class: AssetClass,
  account_id: z.number().int().positive(),
  account_name: z.string(),
  quantity: z.number(),
  avg_cost: z.number(),
  cost_basis: z.number(),
  current_price: z.number().nullable(),
  market_value: z.number().nullable(),
  unrealized_pl: z.number().nullable(),
  unrealized_pl_pct: z.number().nullable(),
  price_as_of: z.string().nullable(),
});
export type Position = z.infer<typeof Position>;

// -------- Helpers --------

/**
 * Compute a sensible default `amount` (signed cash impact) for a transaction
 * given its type, quantity, price, and fee. Used by the UI to pre-fill the
 * amount field; the user can override.
 */
export function defaultAmount(input: {
  type: TransactionType;
  quantity: number;
  price: number;
  fee: number;
}): number {
  const { type, quantity, price, fee } = input;
  const gross = quantity * price;
  switch (type) {
    case "buy":
    case "transfer_in": // treat as cash-out of the destination account
      return -(gross + fee);
    case "sell":
    case "transfer_out":
      return gross - fee;
    case "deposit":
    case "dividend":
    case "interest":
    case "staking_reward":
      return Math.abs(price || gross || 0);
    case "withdrawal":
    case "fee":
    case "tax":
      return -Math.abs(price || gross || 0);
    case "option_exercise":
    case "option_assignment":
      return -(gross + fee);
    case "option_expiry":
    case "split":
    case "airdrop":
    case "gift_in":
    case "gift_out":
      return 0;
    case "adjustment":
    default:
      return 0;
  }
}
