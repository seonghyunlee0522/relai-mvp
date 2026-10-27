/**
 * Workspace AI allowance (2026-10-27 — replaces AI credits). The unit is the provider's real cost in USD:
 *   - every run stores its tokens and USD cost on ai_runs (provider_cost_amount), failed runs included — they were billed too;
 *   - a workspace's allowance is plans.js aiLimitUsd(plan): FREE $2 once, PRO $10 / TEAM $30 per monthly credit cycle, ENTERPRISE per contract;
 *   - usage = SUM(provider_cost_amount) of the metered runs in the current window; nothing is granted, stored as a balance or reset —
 *     a new cycle is simply a new window, so unused allowance never carries over and no reset job exists.
 * Users only ever see percentages (publicUsage). Amounts, tokens and prices stay server-side and on the Admin console.
 *
 * Window
 *   ONCE (Free)        all metered runs made while the workspace was on Free (ai_runs.plan_key FREE / EARLY); no reset date
 *   MONTHLY / CONTRACT the subscription's current monthly credit cycle (anchored on current_period_start, same SQL as the old monthly
 *                      grant), else the calendar month in Asia/Seoul
 * Runs from before metering (plan_key NULL) never count: the switch starts every workspace from 0 % (founder: 모두 초기화).
 *
 * Free once per owner (AI_FREE_CLAIM_SCOPE=owner, default): free_credit_claims holds the one workspace an owner account / e-mail got the
 * Free allowance for. Another workspace of the same owner — e.g. the empty one created after deleting the last workspace — gets 0 on Free.
 *
 * Concurrency: reserve() runs under a per-workspace advisory lock and counts open reservations (PENDING runs younger than the TTL, at their
 * worst-case cost), so parallel requests cannot pass the limit by more than one request's actual cost.
 */
import { randomUUID, createHash } from 'node:crypto';
import { tx } from '../db.js';
import { aiConfig, estimateProviderCost } from './config.js';
import { aiLimitUsd, AI_ALLOWANCE } from '../plans.js';
import { effectivePlan, GRANTS_PLAN_SQL } from '../billing/subscriptions.js';

export const RESERVATION_TTL = "interval '10 minutes'";
export const TZ = 'Asia/Seoul';
/** Thresholds of the in-app notices (사용률 80 % / 95 % / 100 %). */
export const TIERS = [[100, 'reached'], [95, 'critical'], [80, 'warn']];
const FREE_KEYS = ['FREE', 'EARLY'];

export class AiUsageError extends Error {
  constructor(code, message, { status = 402, ...extra } = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

/* ---------- Free once per owner ---------- */
/** Normalized e-mail for the Free claim: trimmed, lower case, "+tag" dropped from the local part. */
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase().replace(/\+[^@]*(?=@)/, '');
/** sha256 of the normalized e-mail (free_credit_claims.email_hash) — the address itself is never stored there. Same salt as before. */
export const emailHash = (email) => createHash('sha256').update(`relai-free-credit:${normalizeEmail(email)}`).digest('hex');

/**
 * Does this workspace get the Free allowance? scope 'workspace' → always. scope 'owner' → only the workspace the owner's claim points to;
 * the first workspace that asks claims it (ON CONFLICT on owner and e-mail hash decides a race). No owner e-mail → yes (operator rows).
 */
export async function freeEligible(db, wid, { scope = aiConfig().freeClaimScope } = {}) {
  if (scope === 'workspace') return true;
  const o = await db.get('SELECT u.id, u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?', [wid]);
  if (!o?.email) return true;
  const hash = emailHash(o.email);
  const find = () => db.get('SELECT workspace_id FROM free_credit_claims WHERE owner_user_id = ? OR email_hash = ? ORDER BY granted_at LIMIT 1', [o.id, hash]);
  let c = await find();
  if (!c) { await db.run('INSERT INTO free_credit_claims (owner_user_id, email_hash, workspace_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', [o.id, hash, wid]); c = await find(); }
  return !c || c.workspace_id === wid;
}

/* ---------- window ---------- */
const CYCLE_START_SQL = `COALESCE(s.current_period_start, s.created_at) + make_interval(months => (
  EXTRACT(YEAR FROM age(now(), COALESCE(s.current_period_start, s.created_at))) * 12 + EXTRACT(MONTH FROM age(now(), COALESCE(s.current_period_start, s.created_at))))::int)`;
const CYCLE_END_SQL = `CASE WHEN (s.cancel_at_period_end OR NOT s.auto_renew) AND s.current_period_end IS NOT NULL
  THEN LEAST(${CYCLE_START_SQL} + interval '1 month', s.current_period_end) ELSE ${CYCLE_START_SQL} + interval '1 month' END`;

/** { allowance, start, end } — start/end null for ONCE (Free). */
export async function currentWindow(db, wid, plan) {
  const allowance = AI_ALLOWANCE[plan] || 'ONCE';
  if (allowance === 'ONCE') return { allowance, start: null, end: null };
  const s = await db.get(`SELECT ${CYCLE_START_SQL} AS start, ${CYCLE_END_SQL} AS "end" FROM subscriptions s WHERE s.workspace_id = ? AND ${GRANTS_PLAN_SQL}`, [wid]);
  if (s?.start) return { allowance, start: new Date(s.start), end: new Date(s.end) };
  const m = await db.get(`SELECT date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS start, (date_trunc('month', now() AT TIME ZONE '${TZ}') + interval '1 month') AT TIME ZONE '${TZ}' AS "end"`);
  return { allowance, start: new Date(m.start), end: new Date(m.end) };
}
/** SQL condition (alias r) + params selecting the metered runs of a window. */
const windowWhere = (win) => (win.allowance === 'ONCE'
  ? { sql: `r.plan_key IN ('FREE','EARLY')`, params: [] }
  : { sql: 'r.plan_key IS NOT NULL AND r.created_at >= ?', params: [win.start.toISOString()] });

/* ---------- summary ---------- */
const round1 = (v) => Math.round(v * 10) / 10;
export const tierOfPct = (pct) => (pct === null ? 'ok' : (TIERS.find(([t]) => pct >= t) || [0, 'ok'])[1]);

/**
 * Full (operator / server) view: { plan, allowance, limit_usd, used_usd, reserved_usd, used_pct, remaining_pct, tier, resets_at,
 * window_start, free_eligible }. limit_usd null = no limit (used_pct null).
 */
export async function usageSummary(db, wid, { plan = null } = {}) {
  const p = plan || await effectivePlan(db, wid);
  const win = await currentWindow(db, wid, p);
  const eligible = FREE_KEYS.includes(p) ? await freeEligible(db, wid) : true;
  const limit = FREE_KEYS.includes(p) && !eligible ? 0 : aiLimitUsd(p);
  const w = windowWhere(win);
  const r = await db.get(`SELECT COALESCE(SUM(r.provider_cost_amount) FILTER (WHERE r.status <> 'PENDING'), 0) AS used,
      COALESCE(SUM(r.reserved_usd) FILTER (WHERE r.status = 'PENDING' AND r.created_at > now() - ${RESERVATION_TTL}), 0) AS reserved
    FROM ai_runs r WHERE r.workspace_id = ? AND ${w.sql}`, [wid, ...w.params]);
  const used = Number(r.used); const reserved = Number(r.reserved);
  const usedPct = limit === null ? null : limit <= 0 ? 100 : Math.min(100, round1((used / limit) * 100));
  return { plan: p, allowance: win.allowance, limit_usd: limit, used_usd: Number(used.toFixed(6)), reserved_usd: Number(reserved.toFixed(6)),
    used_pct: usedPct, remaining_pct: usedPct === null ? null : round1(100 - usedPct), tier: tierOfPct(usedPct),
    resets_at: win.end ? win.end.toISOString() : null, window_start: win.start ? win.start.toISOString() : null, free_eligible: eligible };
}
/** What a member's browser may see: percentages, tier and the reset date — never amounts. */
export const publicUsage = (s) => ({ plan: s.plan, allowance: s.allowance, unlimited: s.limit_usd === null, used_pct: s.used_pct, remaining_pct: s.remaining_pct,
  tier: s.tier, resets_at: s.resets_at, blocked: s.limit_usd !== null && (s.limit_usd <= 0 || s.used_usd + s.reserved_usd >= s.limit_usd) });

/**
 * Daily series of the current window for the usage chart: [{ date 'YYYY-MM-DD' (Asia/Seoul), day_pct, cum_pct }].
 * MONTHLY: every day from the cycle start to today. ONCE: the last `days` days, cumulative from all earlier Free usage.
 */
export async function dailyUsage(db, wid, { days = 30 } = {}) {
  const s = await usageSummary(db, wid);
  const win = { allowance: s.allowance, start: s.window_start ? new Date(s.window_start) : null };
  const w = windowWhere(win);
  const rows = await db.all(`SELECT to_char((r.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d, SUM(r.provider_cost_amount) AS cost
    FROM ai_runs r WHERE r.workspace_id = ? AND r.status <> 'PENDING' AND ${w.sql} GROUP BY 1 ORDER BY 1`, [wid, ...w.params]);
  const today = (await db.get(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).d;
  const first = win.start ? (await db.get(`SELECT to_char((?::timestamptz AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`, [win.start.toISOString()])).d
    : (await db.get(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date - ?::int, 'YYYY-MM-DD') AS d`, [days - 1])).d;
  const byDay = new Map(rows.map((x) => [x.d, Number(x.cost || 0)]));
  const pct = (usd) => (s.limit_usd === null ? null : s.limit_usd <= 0 ? 100 : round1((usd / s.limit_usd) * 100));
  let cum = rows.filter((x) => x.d < first).reduce((a, x) => a + Number(x.cost || 0), 0);
  const out = [];
  for (let d = new Date(`${first}T00:00:00Z`); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10); const day = byDay.get(k) || 0; cum += day;
    out.push({ date: k, day_pct: pct(day), cum_pct: s.limit_usd === null ? null : Math.min(100, pct(cum)) });
  }
  return { usage: publicUsage(s), days: out };
}

/* ---------- per run ---------- */
/**
 * Lock the workspace, refuse when the allowance is used up (AI_USAGE_LIMIT_REACHED) or the same request is still running
 * (AI_RUN_IN_PROGRESS), then insert the PENDING ai_run with its worst-case reservation. Returns { id, usage }.
 */
export async function reserveRun(db, { wid, projectId, userId, feature, provider, model, inputSummary, reserveUsd = 0, requestHash = null }) {
  return tx(db, async (t) => {
    await t.get('SELECT pg_advisory_xact_lock(hashtext(?))', [`relai-ai-usage:${wid}`]);
    if (requestHash && await t.get(`SELECT 1 FROM ai_runs WHERE workspace_id = ? AND user_id IS NOT DISTINCT FROM ? AND request_hash = ? AND status = 'PENDING' AND created_at > now() - ${RESERVATION_TTL} LIMIT 1`, [wid, userId, requestHash]))
      throw new AiUsageError('AI_RUN_IN_PROGRESS', '같은 AI 요청을 이미 처리하고 있습니다. 잠시 후 결과를 확인해 주세요.', { status: 409, feature });
    const s = await usageSummary(t, wid);
    if (s.limit_usd !== null && (s.limit_usd <= 0 || s.used_usd + s.reserved_usd >= s.limit_usd)) {
      throw new AiUsageError('AI_USAGE_LIMIT_REACHED', s.allowance === 'ONCE'
        ? '무료 AI 이용량을 모두 사용했습니다. Pro 플랜에서 매월 AI 이용량이 제공됩니다.'
        : 'AI 이용량을 모두 사용했습니다. 다음 이용량 초기화일 이후 다시 사용할 수 있습니다.', { feature, usage: publicUsage(s) });
    }
    const id = randomUUID();
    await t.run(`INSERT INTO ai_runs (id, workspace_id, project_id, user_id, feature, provider, model, status, input_summary, credit_cost, credit_status, request_hash, plan_key, reserved_usd)
      VALUES (?,?,?,?,?,?,?,'PENDING',?,0,'NONE',?,?,?)`, [id, wid, projectId, userId, feature, provider, model, inputSummary, requestHash, s.plan, reserveUsd ?? 0]);
    return { id, usage: publicUsage(s) };
  });
}

/**
 * Finish a run (idempotent: a run no longer PENDING is left alone). Cost = the reported tokens at the model's price; a run that reported
 * nothing (timeout, network) is charged `fallbackUsd` (its worst case) with cost_estimated = true, because the vendor may still bill it.
 */
export async function settleRun(db, runId, { success, usage = {}, model = null, fallbackUsd = null, latencyMs = null, errorCode = null, errorMessage = null }) {
  const run = await db.get('SELECT model, status FROM ai_runs WHERE id = ?', [runId]);
  if (!run || run.status !== 'PENDING') return null;
  let cost = estimateProviderCost(model || run.model, usage.input_tokens ?? null, usage.output_tokens ?? null, usage.cached_input_tokens ?? 0);
  let estimated = false;
  if (cost === null && !success && fallbackUsd !== null && fallbackUsd !== undefined && usage.input_tokens == null) { cost = Number(fallbackUsd); estimated = true; }
  const r = await db.get(`UPDATE ai_runs SET status = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, provider_cost_amount = ?, cost_estimated = ?,
      latency_ms = ?, error_code = ?, error_message = ?, completed_at = now() WHERE id = ? AND status = 'PENDING' RETURNING id`,
  [success ? 'SUCCEEDED' : 'FAILED', usage.input_tokens ?? null, usage.output_tokens ?? null, usage.cached_input_tokens ?? null, cost, estimated,
    latencyMs, errorCode, errorMessage ? String(errorMessage).slice(0, 300) : null, runId]);
  return r ? { cost_usd: cost, estimated } : null;
}
/** Safety net for the orchestrator: whatever happened, a PENDING run is never left behind. */
export const releaseIfPending = (db, runId, { errorCode = 'AI_INTERNAL_ERROR', errorMessage = null, latencyMs = null, usage = {}, model = null } = {}) =>
  settleRun(db, runId, { success: false, usage, model, errorCode, errorMessage, latencyMs });

/**
 * GET /api/workspaces/:wid/ai-usage — any member: { usage (percentages, tier, reset date), days [{ date, day_pct, cum_pct }] }.
 * GET /api/workspaces/:wid/credits/* answered 410 so an old tab learns the page moved.
 */
export function mountUsageRoutes({ app, db, guard, wrap, fail }) {
  app.get('/api/workspaces/:wid/ai-usage', guard, wrap(async (req, res) => res.json(await dailyUsage(db, req.params.wid, { days: Math.min(90, Math.max(7, Number(req.query.days) || 30)) }))));
  app.all('/api/workspaces/:wid/credits/*', guard, (req, res) => fail(res, 410, 'credits_retired', 'AI 크레딧은 AI 이용량으로 바뀌었습니다. 설정 › AI 이용 현황에서 확인해 주세요.'));
}
