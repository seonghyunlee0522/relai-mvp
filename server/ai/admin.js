/**
 * Operator view of AI usage and credits (Admin Console). Aggregates only — no prompt text, no project content.
 * Credit grants are ledger entries + admin_audit_logs in ONE transaction; the balance column is never edited directly.
 */
import { tx } from '../db.js';
import { AdminError, writeAudit } from '../admin.js';
import { FEATURES, FEATURE_LABEL, featureCreditCosts, publicConfig } from './config.js';
import { applyCredits, ensureAccount, listLedger } from './credits.js';

const FEATURE_SQL = `feature, COUNT(*) AS runs, COALESCE(SUM((status = 'SUCCEEDED')::int), 0) AS succeeded, COALESCE(SUM((status = 'FAILED')::int), 0) AS failed,
  ROUND(AVG(input_tokens)) AS avg_input_tokens, ROUND(AVG(output_tokens)) AS avg_output_tokens, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
  ROUND(AVG(provider_cost_amount)::numeric, 6) AS avg_provider_cost, ROUND(COALESCE(SUM(provider_cost_amount), 0)::numeric, 6) AS provider_cost,
  ROUND(AVG(CASE WHEN credit_status = 'CHARGED' THEN credit_cost END)) AS avg_credit, COALESCE(SUM(CASE WHEN credit_status = 'CHARGED' THEN credit_cost ELSE 0 END), 0) AS credits,
  ROUND(AVG(latency_ms)) AS avg_latency_ms`;
const shapeFeature = (r) => ({ ...r, label: FEATURE_LABEL[r.feature] || r.feature, success_rate: r.runs ? Math.round((r.succeeded / r.runs) * 100) : null });
const withAllFeatures = (rows) => FEATURES.map((f) => rows.find((r) => r.feature === f) || shapeFeature({ feature: f, runs: 0, succeeded: 0, failed: 0, avg_input_tokens: null, avg_output_tokens: null, input_tokens: 0, output_tokens: 0, avg_provider_cost: null, provider_cost: 0, avg_credit: null, credits: 0, avg_latency_ms: null }));

/** Global AI usage: today / 30 days, success rate, latency, per-feature table, top workspaces (30 days). */
export async function aiUsageOverview(db) {
  const k = await db.get(`SELECT
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS runs_today,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS runs_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED') AS succeeded_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'FAILED') AS failed_30d,
      ROUND(AVG(latency_ms) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED')) AS avg_latency_ms,
      COALESCE(SUM(credit_cost) FILTER (WHERE created_at >= now() - interval '30 days' AND credit_status = 'CHARGED'), 0) AS credits_30d,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::numeric, 4) AS provider_cost_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND error_code = 'AI_CREDIT_SETTLEMENT_CONFLICT') AS settlement_conflicts_30d
    FROM ai_runs`);
  const features = withAllFeatures((await db.all(`SELECT ${FEATURE_SQL} FROM ai_runs WHERE created_at >= now() - interval '30 days' GROUP BY feature`)).map(shapeFeature));
  const workspaces = await db.all(`SELECT w.id, w.name, COUNT(r.id) AS runs, COALESCE(SUM(CASE WHEN r.credit_status = 'CHARGED' THEN r.credit_cost ELSE 0 END), 0) AS credits, a.balance
    FROM ai_runs r JOIN workspaces w ON w.id = r.workspace_id LEFT JOIN workspace_credit_accounts a ON a.workspace_id = w.id
    WHERE r.created_at >= now() - interval '30 days' GROUP BY w.id, w.name, a.balance ORDER BY runs DESC LIMIT 10`);
  const recentFailures = await db.all(`SELECT r.id, r.feature, r.error_code, r.error_message, r.created_at, w.name AS workspace_name, w.id AS workspace_id FROM ai_runs r JOIN workspaces w ON w.id = r.workspace_id
    WHERE r.status = 'FAILED' OR r.error_code = 'AI_CREDIT_SETTLEMENT_CONFLICT' ORDER BY r.created_at DESC LIMIT 10`);
  return { config: publicConfig(), kpis: { ...k, success_rate_30d: k.runs_30d ? Math.round((k.succeeded_30d / k.runs_30d) * 100) : null }, features, workspaces, recent_failures: recentFailures, costs: featureCreditCosts() };
}

/** Per-workspace: credit balance, 30-day usage, per-feature table, recent runs + ledger. */
export async function workspaceAiUsage(db, wid) {
  const w = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [wid]);
  if (!w) return null;
  const account = await ensureAccount(db, wid);
  const k = await db.get(`SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS runs_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND status = 'SUCCEEDED') AS succeeded_30d,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS input_tokens_30d,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS output_tokens_30d,
      ROUND(COALESCE(SUM(provider_cost_amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::numeric, 4) AS provider_cost_30d,
      COALESCE(SUM(credit_cost) FILTER (WHERE created_at >= now() - interval '30 days' AND credit_status = 'CHARGED'), 0) AS credits_30d
    FROM ai_runs WHERE workspace_id = ?`, [wid]);
  const features = withAllFeatures((await db.all(`SELECT ${FEATURE_SQL} FROM ai_runs WHERE workspace_id = ? AND created_at >= now() - interval '30 days' GROUP BY feature`, [wid])).map(shapeFeature));
  const users = await db.all(`SELECT u.id, u.name, COUNT(*) AS runs, COALESCE(SUM(CASE WHEN r.credit_status = 'CHARGED' THEN r.credit_cost ELSE 0 END), 0) AS credits
    FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.workspace_id = ? AND r.created_at >= now() - interval '30 days' GROUP BY u.id, u.name ORDER BY runs DESC LIMIT 10`, [wid]);
  const runs = await db.all(`SELECT r.id, r.feature, r.status, r.credit_cost, r.credit_status, r.input_tokens, r.output_tokens, r.provider_cost_amount, r.latency_ms, r.error_code, r.created_at, u.name AS user_name, p.name AS project_name
    FROM ai_runs r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN projects p ON p.id = r.project_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC, r.seq DESC LIMIT 20`, [wid]);
  return { workspace: w, config: publicConfig(), account: { balance: account.balance, lifetime_granted: account.lifetime_granted, lifetime_used: account.lifetime_used },
    kpis: { ...k, success_rate_30d: k.runs_30d ? Math.round((k.succeeded_30d / k.runs_30d) * 100) : null }, features, users, runs, ledger: await listLedger(db, wid, { limit: 30 }), costs: featureCreditCosts() };
}

/** Manual grant / adjustment by SYSTEM_ADMIN: ledger entry + admin audit row in one transaction. Reason is required. */
export async function grantCredits(db, admin, wid, body = {}) {
  const amount = Number(body.amount);
  const reason = String(body.reason || '').trim();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new AdminError(400, 'validation_error', 'Credit 수량은 0이 아닌 정수(±1,000,000 이내)여야 합니다.');
  if (!reason || reason.length > 500) throw new AdminError(400, 'validation_error', '사유를 입력해 주세요. (500자 이내)');
  const w = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [wid]);
  if (!w) throw new AdminError(404, 'not_found', 'Workspace를 찾을 수 없습니다.');
  return tx(db, async (t) => {
    const auditId = await writeAudit(t, { adminUserId: admin.id, action: amount > 0 ? 'GRANT_AI_CREDITS' : 'ADJUST_AI_CREDITS', targetType: 'WORKSPACE', targetId: wid, metadata: { name: w.name, amount, reason } });
    let out;
    try { out = await applyCredits(t, { wid, amount, type: amount > 0 ? 'ADMIN_GRANT' : 'ADJUSTMENT', reason, createdBy: admin.id, referenceType: 'ADMIN_AUDIT', referenceId: auditId }); }
    catch (e) { if (e.code === 'AI_CREDIT_INSUFFICIENT') throw new AdminError(409, 'insufficient', e.message); throw e; }
    return { balance: out.balance, ledger_id: out.ledger_id };
  });
}
