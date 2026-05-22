import type { D1Database } from '@cloudflare/workers-types'
import type { RecurringRule, RecurringFrequency, Transaction } from '@shared/types'
import * as q from '../db/queries'

/** "YYYY-MM-DD" in UTC. We treat firing dates as local dates but use UTC for math
 *  to avoid DST off-by-one. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextFireDate(prev: string, freq: RecurringFrequency): string {
  const [y, m, d] = prev.split('-').map(Number)
  // Construct in UTC so month arithmetic doesn't drift across DST boundaries.
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (freq === 'biweekly') {
    dt.setUTCDate(dt.getUTCDate() + 14)
  } else if (freq === 'monthly') {
    dt.setUTCMonth(dt.getUTCMonth() + 1)
  } else if (freq === 'quarterly') {
    dt.setUTCMonth(dt.getUTCMonth() + 3)
  }
  return dt.toISOString().slice(0, 10)
}

function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

/** Materialize all due firings for a single rule up to `asOf` (today). Returns
 *  the list of created transaction tx_dates. */
export async function fireRule(
  db: D1Database,
  rule: RecurringRule,
  asOf: string = todayUTC(),
): Promise<string[]> {
  if (!rule.active) return []
  const fired: string[] = []

  // First firing is start_date itself; subsequent ones are one interval after last_fired
  let next = rule.last_fired
    ? nextFireDate(rule.last_fired, rule.frequency)
    : rule.start_date

  while (next <= asOf && (!rule.end_date || next <= rule.end_date)) {
    const tx: Omit<Transaction, 'created_at'> = {
      id:           `tx_${uid()}`,
      tx_date:      next,
      account_id:   rule.account_id,
      type:         rule.tx_type,
      symbol:       rule.symbol,
      kind:         rule.kind,
      qty:          rule.qty,
      price:        rule.price,
      total:        rule.total,
      note:         rule.note ? `${rule.note} (recurring)` : 'Recurring',
    }
    await q.insertTransaction(db, tx)
    fired.push(next)
    next = nextFireDate(next, rule.frequency)
  }

  if (fired.length > 0) {
    await db.prepare('UPDATE recurring_rules SET last_fired = ? WHERE id = ?')
      .bind(fired[fired.length - 1], rule.id)
      .run()
  }
  return fired
}

/** Fire every active rule. Called by the daily cron + the admin route. */
export async function fireAllRules(db: D1Database): Promise<{ rule_id: string; fired: string[] }[]> {
  const { results } = await db.prepare(
    'SELECT * FROM recurring_rules WHERE active = 1'
  ).all<RecurringRule>()

  const out: { rule_id: string; fired: string[] }[] = []
  for (const rule of results) {
    const fired = await fireRule(db, rule)
    if (fired.length > 0) out.push({ rule_id: rule.id, fired })
  }
  return out
}
