/**
 * Admin read-only views over Billing data (Phase 10). Billing is NOT implemented yet, so this module detects the
 * `subscriptions` / `payments` tables at runtime: when they are absent every function reports
 * `{ implemented: false }` and the console hides the Billing KPIs / menus instead of showing fake zeros.
 *
 * Contract the Billing phase has to meet for these views to light up unchanged (columns may be a superset):
 *   subscriptions(id, workspace_id, plan, status, current_period_start, current_period_end, next_billing_at,
 *                 cancel_at_period_end, grace_period_end, payment_method_summary, created_at, updated_at)
 *   subscription_events(id, subscription_id, event_type, metadata, created_at)                         -- optional
 *   payments(id, workspace_id, subscription_id, plan, amount, currency, status, provider, provider_result_code,
 *            provider_tid, moid, paid_at, failed_at, failure_code, failure_message, created_at)
 * Columns are whitelisted below — billing keys, card data, merchant keys, raw TIDs never leave this module.
 */
import { PLANS } from './plans.js';

const SUB_COLS = ['id', 'workspace_id', 'plan', 'status', 'current_period_start', 'current_period_end', 'next_billing_at', 'cancel_at_period_end', 'grace_period_end', 'payment_method_summary', 'created_at', 'updated_at'];
const PAY_COLS = ['id', 'workspace_id', 'subscription_id', 'plan', 'amount', 'currency', 'status', 'provider', 'provider_result_code', 'provider_tid', 'moid', 'paid_at', 'failed_at', 'failure_code', 'failure_message', 'created_at'];
const PAST_DUE = ['PAST_DUE', 'UNPAID'];
const FAILED = ['FAILED', 'DECLINED'];

/** Masked provider transaction id: keeps the last 4 characters only. */
export const maskTid = (tid) => (tid ? `${'*'.repeat(Math.max(0, String(tid).length - 4))}${String(tid).slice(-4)}` : null);

let cache = { at: 0, tables: null };
/** Which billing tables exist (cached 30 s; tests create them on the fly, so a `reset` is exported). */
export async function billingTables(db) {
  if (cache.tables && Date.now() - cache.at < 30_000 && cache.schema === db.schema) return cache.tables;
  const rows = await db.all(`SELECT table_name, (SELECT array_agg(column_name::text) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS cols
    FROM information_schema.tables t WHERE table_schema = current_schema() AND table_name IN ('subscriptions','payments','subscription_events')`);
  const tables = Object.fromEntries(rows.map((r) => [r.table_name, new Set(r.cols || [])]));
  cache = { at: Date.now(), tables, schema: db.schema };
  return tables;
}
export const resetBillingCache = () => { cache = { at: 0, tables: null }; };
export async function billingStatus(db) {
  const t = await billingTables(db);
  return { implemented: Boolean(t.subscriptions && t.payments), subscriptions: Boolean(t.subscriptions), payments: Boolean(t.payments), events: Boolean(t.subscription_events) };
}

/** Only whitelisted columns that actually exist. */
const pick = (cols, have, alias) => cols.filter((c) => have.has(c)).map((c) => `${alias}.${c}`).join(', ');
const subRow = (r) => ({ ...r, plan_label: (PLANS[r.plan] || {}).label || r.plan });
const payRow = (r) => ({ ...r, provider_tid_masked: maskTid(r.provider_tid), provider_tid: undefined });

export async function listSubscriptions(db, { q = '', plan = '', status = '', page = 1, size = 50 } = {}) {
  const t = await billingTables(db); if (!t.subscriptions) return { implemented: false, items: [], total: 0 };
  const where = []; const params = [];
  if (q) { where.push('w.name ILIKE ?'); params.push(`%${q}%`); }
  if (plan) { where.push('s.plan = ?'); params.push(plan); }
  if (status) { where.push('s.status = ?'); params.push(status); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) AS n FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id ${w}`, params)).n;
  const rows = await db.all(`SELECT ${pick(SUB_COLS, t.subscriptions, 's')}, w.name AS workspace_name FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id ${w}
    ORDER BY s.updated_at DESC NULLS LAST, s.id LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  return { implemented: true, total, items: rows.map(subRow) };
}
export async function getSubscription(db, id) {
  const t = await billingTables(db); if (!t.subscriptions) return null;
  const s = await db.get(`SELECT ${pick(SUB_COLS, t.subscriptions, 's')}, w.name AS workspace_name, w.status AS workspace_status FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`, [id]);
  if (!s) return null;
  const payments = t.payments ? (await db.all(`SELECT ${pick(PAY_COLS, t.payments, 'p')} FROM payments p WHERE p.subscription_id = ? ORDER BY p.created_at DESC LIMIT 10`, [id])).map(payRow) : [];
  const events = t.subscription_events ? await db.all('SELECT id, event_type, metadata, created_at FROM subscription_events WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 50', [id]) : [];
  return { subscription: subRow(s), payments, events };
}
/** Subscription of one workspace (null when none / billing absent) — used by the workspace detail. */
export async function workspaceSubscription(db, workspaceId) {
  const t = await billingTables(db); if (!t.subscriptions) return null;
  const s = await db.get(`SELECT ${pick(SUB_COLS, t.subscriptions, 's')} FROM subscriptions s WHERE s.workspace_id = ? ORDER BY s.updated_at DESC NULLS LAST LIMIT 1`, [workspaceId]);
  return s ? subRow(s) : null;
}
export async function listPayments(db, { q = '', status = '', provider = '', from = '', to = '', page = 1, size = 50 } = {}) {
  const t = await billingTables(db); if (!t.payments) return { implemented: false, items: [], total: 0 };
  const where = []; const params = [];
  if (q) { where.push('(w.name ILIKE ? OR p.moid ILIKE ? OR RIGHT(p.provider_tid, 4) = ?)'); params.push(`%${q}%`, `%${q}%`, q.slice(-4)); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (provider) { where.push('p.provider = ?'); params.push(provider); }
  if (from) { where.push('p.created_at >= ?'); params.push(from); }
  if (to) { where.push('p.created_at < (?::date + 1)'); params.push(to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) AS n FROM payments p JOIN workspaces w ON w.id = p.workspace_id ${w}`, params)).n;
  const rows = await db.all(`SELECT ${pick(PAY_COLS, t.payments, 'p')}, w.name AS workspace_name FROM payments p JOIN workspaces w ON w.id = p.workspace_id ${w}
    ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  return { implemented: true, total, items: rows.map(payRow) };
}
export async function getPayment(db, id) {
  const t = await billingTables(db); if (!t.payments) return null;
  const p = await db.get(`SELECT ${pick(PAY_COLS, t.payments, 'p')}, w.name AS workspace_name FROM payments p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?`, [id]);
  return p ? payRow(p) : null;
}
/** Billing KPIs + attention rows for the dashboard. Returns null when billing is absent (the console then hides them). */
export async function billingDashboard(db) {
  const t = await billingTables(db); if (!(t.subscriptions && t.payments)) return null;
  const subs = await db.get(`SELECT COALESCE(SUM((status = 'ACTIVE' AND plan <> 'FREE')::int), 0) AS team_workspaces, COALESCE(SUM((status = ANY(?))::int), 0) AS past_due FROM subscriptions`, [PAST_DUE]);
  const pays = await db.get(`SELECT COALESCE(SUM((status = ANY(?) AND created_at >= now() - interval '7 days')::int), 0) AS failed_7d FROM payments`, [FAILED]);
  const priced = Object.values(PLANS).filter((p) => p.price_monthly !== null);
  let mrr = null;
  if (priced.length) { const r = await db.all(`SELECT plan, COUNT(*) AS n FROM subscriptions WHERE status = 'ACTIVE' GROUP BY plan`); mrr = r.reduce((s, x) => s + (PLANS[x.plan]?.price_monthly || 0) * x.n, 0); }
  const failed = (await db.all(`SELECT ${pick(PAY_COLS, t.payments, 'p')}, w.name AS workspace_name FROM payments p JOIN workspaces w ON w.id = p.workspace_id WHERE p.status = ANY(?) AND p.created_at >= now() - interval '7 days' ORDER BY p.created_at DESC LIMIT 10`, [FAILED])).map(payRow);
  const pastDue = (await db.all(`SELECT ${pick(SUB_COLS, t.subscriptions, 's')}, w.name AS workspace_name FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.status = ANY(?) ORDER BY s.updated_at DESC NULLS LAST LIMIT 10`, [PAST_DUE])).map(subRow);
  return { kpis: { team_workspaces: subs.team_workspaces, past_due: subs.past_due, payment_failed_7d: pays.failed_7d, mrr }, attention: { payment_failed: failed, past_due: pastDue } };
}
