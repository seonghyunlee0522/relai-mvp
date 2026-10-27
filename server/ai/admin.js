/**
 * Operator view of AI usage and provider cost (Admin Console). Aggregates only — no prompt text, no project content.
 * Costs are USD (ai_runs.provider_cost_amount, failed runs included); KRW columns are USD × the latest 한국수출입은행 rate (fx.js) and
 * are for display only. Limits and usage % per workspace come from ai/usage-limit.js — the same numbers the workspace sees.
 */
import { FEATURES, FEATURE_LABEL, adminAiConfig } from './config.js';
import { usageSummary, TZ } from './usage-limit.js';
import { aiLimitUsd } from '../plans.js';
import { latestFx } from '../fx.js';

const COST = 'COALESCE(SUM(provider_cost_amount), 0)';
const FEATURE_SQL = `feature, COUNT(*) AS runs, COALESCE(SUM((status = 'SUCCEEDED')::int), 0) AS succeeded, COALESCE(SUM((status = 'FAILED')::int), 0) AS failed,
  ROUND(AVG(input_tokens)) AS avg_input_tokens, ROUND(AVG(output_tokens)) AS avg_output_tokens, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
  ROUND(AVG(provider_cost_amount)::numeric, 6) AS avg_provider_cost, ROUND(${COST}::numeric, 6) AS provider_cost, ROUND(AVG(latency_ms)) AS avg_latency_ms`;
const num = (r, keys) => { for (const k of keys) if (r[k] !== null && r[k] !== undefined) r[k] = Number(r[k]); return r; };
const NUMS = ['runs', 'succeeded', 'failed', 'avg_input_tokens', 'avg_output_tokens', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'avg_provider_cost', 'provider_cost', 'avg_latency_ms'];
const shapeFeature = (r) => ({ ...num(r, NUMS), label: FEATURE_LABEL[r.feature] || r.feature, success_rate: r.runs ? Math.round((r.succeeded / r.runs) * 100) : null });
const withAllFeatures = (rows) => FEATURES.map((f) => rows.find((r) => r.feature === f) || shapeFeature({ feature: f, runs: 0, succeeded: 0, failed: 0, avg_input_tokens: null, avg_output_tokens: null, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, avg_provider_cost: null, provider_cost: 0, avg_latency_ms: null }));
const usd = (v) => Number(Number(v || 0).toFixed(6));

/** Days `from`..today (KST) as 'YYYY-MM-DD', filled from rows { d, cost, runs }. */
const fillDays = (rows, days) => {
  const by = new Map(rows.map((r) => [r.d, r])); const out = [];
  const today = new Date(Date.now() + 9 * 3600e3);
  for (let i = days - 1; i >= 0; i--) { const k = new Date(today.getTime() - i * 86400e3).toISOString().slice(0, 10); const r = by.get(k); out.push({ date: k, cost_usd: usd(r?.cost), runs: Number(r?.runs || 0) }); }
  return out;
};

/** Global AI usage: KPIs, daily (30 days) and monthly (12 months) cost, per feature, per model, top workspaces, recent failures, FX. */
export async function aiUsageOverview(db, { days = 30 } = {}) {
  const d = Math.min(90, Math.max(7, Number(days) || 30));
  const k = num(await db.get(`SELECT
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS runs_today,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS runs_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED') AS succeeded_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'FAILED') AS failed_30d,
      ROUND(AVG(latency_ms) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED')) AS avg_latency_ms,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::numeric, 6) AS provider_cost_30d,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'), 0)::numeric, 6) AS provider_cost_month,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'FAILED'), 0)::numeric, 6) AS failed_cost_30d,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS input_tokens_30d,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS output_tokens_30d,
      COALESCE(SUM(cached_input_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS cached_input_tokens_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND cost_estimated) AS estimated_runs_30d
    FROM ai_runs`), ['runs_today', 'runs_30d', 'succeeded_30d', 'failed_30d', 'avg_latency_ms', 'provider_cost_30d', 'provider_cost_month', 'failed_cost_30d', 'input_tokens_30d', 'output_tokens_30d', 'cached_input_tokens_30d', 'estimated_runs_30d']);
  const daily = fillDays(await db.all(`SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d, ${COST} AS cost, COUNT(*) AS runs
    FROM ai_runs WHERE created_at >= now() - make_interval(days => ?) GROUP BY 1`, [d]), d);
  const monthly = (await db.all(`SELECT to_char(date_trunc('month', created_at AT TIME ZONE '${TZ}'), 'YYYY-MM') AS m, ${COST} AS cost, COUNT(*) AS runs,
      COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens
    FROM ai_runs WHERE created_at >= date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' - interval '11 months' GROUP BY 1 ORDER BY 1`))
    .map((r) => ({ month: r.m, cost_usd: usd(r.cost), runs: Number(r.runs), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cached_input_tokens: Number(r.cached_input_tokens) }));
  const features = withAllFeatures((await db.all(`SELECT ${FEATURE_SQL} FROM ai_runs WHERE created_at >= now() - interval '30 days' GROUP BY feature`)).map(shapeFeature));
  const models = (await db.all(`SELECT provider, model, COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens, ROUND(${COST}::numeric, 6) AS provider_cost
    FROM ai_runs WHERE created_at >= now() - interval '30 days' GROUP BY provider, model ORDER BY provider_cost DESC, runs DESC`)).map((r) => num(r, ['runs', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'provider_cost']));
  const workspaces = await Promise.all((await db.all(`SELECT w.id, w.name, COUNT(r.id) AS runs, ROUND(COALESCE(SUM(r.provider_cost_amount), 0)::numeric, 6) AS provider_cost
    FROM ai_runs r JOIN workspaces w ON w.id = r.workspace_id WHERE r.created_at >= now() - interval '30 days' GROUP BY w.id, w.name ORDER BY provider_cost DESC, runs DESC LIMIT 10`))
    .map(async (r) => { const s = await usageSummary(db, r.id); return { ...num(r, ['runs', 'provider_cost']), plan: s.plan, limit_usd: s.limit_usd, used_usd: s.used_usd, used_pct: s.used_pct, remaining_pct: s.remaining_pct }; }));
  const recentFailures = await db.all(`SELECT r.id, r.feature, r.error_code, r.error_message, r.provider_cost_amount, r.cost_estimated, r.created_at, w.name AS workspace_name, w.id AS workspace_id
    FROM ai_runs r JOIN workspaces w ON w.id = r.workspace_id WHERE r.status = 'FAILED' ORDER BY r.created_at DESC LIMIT 10`);
  return { config: adminAiConfig(), fx: await latestFx(db), limits: { FREE: aiLimitUsd('FREE'), PRO: aiLimitUsd('PRO'), TEAM: aiLimitUsd('TEAM'), ENTERPRISE: aiLimitUsd('ENTERPRISE') },
    kpis: { ...k, success_rate_30d: k.runs_30d ? Math.round((k.succeeded_30d / k.runs_30d) * 100) : null }, daily, monthly, features, models, workspaces, recent_failures: recentFailures };
}

/** Per-workspace: allowance (limit / used / %), 30-day cost, daily cost, per feature, per user, per model, recent runs. */
export async function workspaceAiUsage(db, wid) {
  const w = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [wid]);
  if (!w) return null;
  const usage = await usageSummary(db, wid);
  const k = num(await db.get(`SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS runs_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED') AS succeeded_30d,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS input_tokens_30d,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS output_tokens_30d,
      COALESCE(SUM(cached_input_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS cached_input_tokens_30d,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::numeric, 6) AS provider_cost_30d
    FROM ai_runs WHERE workspace_id = ?`, [wid]), ['runs_30d', 'succeeded_30d', 'input_tokens_30d', 'output_tokens_30d', 'cached_input_tokens_30d', 'provider_cost_30d']);
  const daily = fillDays(await db.all(`SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d, ${COST} AS cost, COUNT(*) AS runs
    FROM ai_runs WHERE workspace_id = ? AND created_at >= now() - interval '30 days' GROUP BY 1`, [wid]), 30);
  const features = withAllFeatures((await db.all(`SELECT ${FEATURE_SQL} FROM ai_runs WHERE workspace_id = ? AND created_at >= now() - interval '30 days' GROUP BY feature`, [wid])).map(shapeFeature));
  const users = (await db.all(`SELECT u.id, u.name, COUNT(*) AS runs, COALESCE(SUM(r.input_tokens), 0) AS input_tokens, COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
      ROUND(COALESCE(SUM(r.provider_cost_amount), 0)::numeric, 6) AS provider_cost
    FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.workspace_id = ? AND r.created_at >= now() - interval '30 days' GROUP BY u.id, u.name ORDER BY provider_cost DESC, runs DESC LIMIT 20`, [wid]))
    .map((r) => num(r, ['runs', 'input_tokens', 'output_tokens', 'provider_cost']));
  const models = (await db.all(`SELECT model, COUNT(*) AS runs, ROUND(${COST}::numeric, 6) AS provider_cost FROM ai_runs WHERE workspace_id = ? AND created_at >= now() - interval '30 days' GROUP BY model ORDER BY provider_cost DESC`, [wid]))
    .map((r) => num(r, ['runs', 'provider_cost']));
  const runs = await db.all(`SELECT r.id, r.feature, r.status, r.model, r.plan_key, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.provider_cost_amount, r.cost_estimated, r.latency_ms, r.error_code, r.created_at,
      u.name AS user_name, p.name AS project_name
    FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN projects p ON p.id = r.project_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC, r.seq DESC LIMIT 20`, [wid]);
  return { workspace: w, config: adminAiConfig(), fx: await latestFx(db), usage, kpis: { ...k, success_rate_30d: k.runs_30d ? Math.round((k.succeeded_30d / k.runs_30d) * 100) : null },
    daily, features, users, models, runs };
}
