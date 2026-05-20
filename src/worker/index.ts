import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { accountsRoutes } from "./routes/accounts";
import { assetsRoutes } from "./routes/assets";
import { transactionsRoutes } from "./routes/transactions";
import { marketRoutes } from "./routes/market";
import { portfolioRoutes } from "./routes/portfolio";
import { runNightlySnapshot } from "./jobs/nightly-snapshot";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({ ok: true, ts: new Date().toISOString() }),
);

app.route("/api/accounts", accountsRoutes);
app.route("/api/assets", assetsRoutes);
app.route("/api/transactions", transactionsRoutes);
app.route("/api/market", marketRoutes);
app.route("/api/portfolio", portfolioRoutes);

// Anything else falls through to the static assets handler bound as ASSETS,
// which serves the React SPA (with single-page-application fallback).
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Errors -> JSON with status code
app.onError((err, c) => {
  console.error("[worker] error", err);
  // Zod validation errors carry .issues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const issues = (err as any).issues;
  if (issues) {
    return c.json({ error: "ValidationError", issues }, 400);
  }
  return c.json({ error: err.message ?? "Internal error" }, 500);
});

export default {
  fetch: app.fetch,

  // Cron trigger (configured in wrangler.jsonc) — nightly NAV snapshot.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runNightlySnapshot(env));
  },
};
