/**
 * Workspace AI credits: one account per workspace + an append-only ledger. The balance column is a cache for fast
 * reads; every change goes through the ledger (grant / usage / adjustment) inside a transaction that locks the
 * account row (SELECT … FOR UPDATE), so concurrent AI requests can never drive the balance negative.
 *
 * Flow per AI run:  reserve (lock, check available = balance − open reservations, insert ai_run RESERVED)
 *                   → provider call → settle: success = charge (balance −cost, ledger AI_USAGE, run CHARGED)
 *                                               failure = release (run RELEASED, nothing written to the ledger)
 * Open reservations are derived from ai_runs rows (credit_status = RESERVED, younger than RESERVATION_TTL) so a crash
 * between reserve and settle simply expires instead of leaking a counter.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { aiConfig } from './config.js';

export const LEDGER_TYPES = ['PLAN_GRANT', 'ADMIN_GRANT', 'AI_USAGE', 'REFUND', 'ADJUSTMENT', 'PROMOTION'];
const RESERVATION_TTL = "interval '10 minutes'";

export class CreditError extends Error {
  constructor(code, message, { status = 402, ...extra } = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

const lockAccount = (t, wid) => t.get('SELECT * FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [wid]);
const openReservations = async (t, wid) => (await t.get(`SELECT COALESCE(SUM(credit_cost), 0) AS n FROM ai_runs WHERE workspace_id = ? AND credit_status = 'RESERVED' AND created_at > now() - ${RESERVATION_TTL}`, [wid])).n;

async function writeLedger(t, { wid, runId = null, type, amount, balanceAfter, reason = '', referenceType = null, referenceId = null, createdBy = null }) {
  const id = randomUUID();
  await t.run(`INSERT INTO credit_ledger (id, workspace_id, ai_run_id, type, amount, balance_after, reason, reference_type, reference_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, wid, runId, type, amount, balanceAfter, reason, referenceType, referenceId, createdBy]);
  return id;
}

/**
 * Creates the account on first touch. In development/test (DEV_INITIAL_AI_CREDITS > 0) the first creation also grants
 * the configured starter credits through the ledger (type PLAN_GRANT, reason names the env var) so existing
 * workspaces work the moment the feature is turned on. Production (env unset) starts at 0 — pricing decides later.
 */
export async function ensureAccount(db, wid, { devInitial = aiConfig().devInitialCredits } = {}) {
  return tx(db, async (t) => {
    const existing = await lockAccount(t, wid);
    if (existing) return existing;
    const ins = await t.run('INSERT INTO workspace_credit_accounts (workspace_id) VALUES (?) ON CONFLICT (workspace_id) DO NOTHING', [wid]);
    if (ins.changes && devInitial > 0) {
      await t.run('UPDATE workspace_credit_accounts SET balance = ?, lifetime_granted = ?, updated_at = now() WHERE workspace_id = ?', [devInitial, devInitial, wid]);
      await writeLedger(t, { wid, type: 'PLAN_GRANT', amount: devInitial, balanceAfter: devInitial, reason: '개발 초기 지급 (DEV_INITIAL_AI_CREDITS)', referenceType: 'ENV', referenceId: 'DEV_INITIAL_AI_CREDITS' });
    }
    return lockAccount(t, wid);
  });
}

/** Balance view for the API: balance, open reservations, available. */
export async function getBalance(db, wid) {
  const acc = await ensureAccount(db, wid);
  const reserved = await openReservations(db, wid);
  return { balance: acc.balance, reserved, available: Math.max(0, acc.balance - reserved), lifetime_granted: acc.lifetime_granted, lifetime_used: acc.lifetime_used };
}

/**
 * Grant or adjust credits (admin / plan / promotion / refund). Positive = grant, negative = adjustment that may never
 * take the balance below zero. Must run inside the caller's transaction when it is paired with an audit row.
 */
export async function applyCredits(db, { wid, amount, type, reason, createdBy = null, referenceType = null, referenceId = null }) {
  if (!LEDGER_TYPES.includes(type)) throw new CreditError('bad_type', '원장 유형이 올바르지 않습니다.', { status: 400 });
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new CreditError('bad_amount', 'Credit 수량은 0이 아닌 정수여야 합니다.', { status: 400 });
  return tx(db, async (t) => {
    await ensureAccount(t, wid);
    const acc = await lockAccount(t, wid);
    const next = acc.balance + amount;
    if (next < 0) throw new CreditError('AI_CREDIT_INSUFFICIENT', `차감할 Credit이 부족합니다. (현재 ${acc.balance}, 요청 ${amount})`, { status: 409, balance: acc.balance, required: -amount });
    await t.run(`UPDATE workspace_credit_accounts SET balance = ?, lifetime_granted = lifetime_granted + ?, lifetime_used = lifetime_used + ?, updated_at = now() WHERE workspace_id = ?`,
      [next, amount > 0 ? amount : 0, amount < 0 ? -amount : 0, wid]);
    const ledgerId = await writeLedger(t, { wid, type, amount, balanceAfter: next, reason, referenceType, referenceId, createdBy });
    return { ledger_id: ledgerId, balance: next };
  });
}

/** Insert the PENDING ai_run and reserve its credits atomically. Throws CreditError AI_CREDIT_INSUFFICIENT. */
export async function reserveRun(db, { wid, projectId, userId, feature, provider, model, inputSummary, cost }) {
  return tx(db, async (t) => {
    await ensureAccount(t, wid);
    const acc = await lockAccount(t, wid);
    const reserved = await openReservations(t, wid);
    const available = acc.balance - reserved;
    if (cost > 0 && available < cost) throw new CreditError('AI_CREDIT_INSUFFICIENT', 'AI Credit이 부족합니다. 관리자에게 문의하세요.', { balance: Math.max(0, available), required: cost, feature });
    const id = randomUUID();
    await t.run(`INSERT INTO ai_runs (id, workspace_id, project_id, user_id, feature, provider, model, status, input_summary, credit_cost, credit_status)
      VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?)`, [id, wid, projectId, userId, feature, provider, model, inputSummary, cost, cost > 0 ? 'RESERVED' : 'NONE']);
    return { id, balance_before: acc.balance, available };
  });
}

/** Finish a run. success → charge through the ledger; failure → release the reservation. One transaction either way. */
export async function settleRun(db, runId, { success, usage = {}, providerCost = null, latencyMs = null, errorCode = null, errorMessage = null }) {
  return tx(db, async (t) => {
    const run = await t.get('SELECT * FROM ai_runs WHERE id = ? FOR UPDATE', [runId]);
    if (!run || run.status !== 'PENDING') return null;
    let balance = null;
    if (success && run.credit_cost > 0) {
      const acc = await lockAccount(t, run.workspace_id);
      balance = Math.max(0, acc.balance - run.credit_cost);
      await t.run('UPDATE workspace_credit_accounts SET balance = ?, lifetime_used = lifetime_used + ?, updated_at = now() WHERE workspace_id = ?', [balance, run.credit_cost, run.workspace_id]);
      await writeLedger(t, { wid: run.workspace_id, runId, type: 'AI_USAGE', amount: -run.credit_cost, balanceAfter: balance, reason: run.feature, referenceType: 'AI_RUN', referenceId: runId, createdBy: run.user_id });
    }
    const creditStatus = run.credit_cost > 0 ? (success ? 'CHARGED' : 'RELEASED') : 'NONE';
    await t.run(`UPDATE ai_runs SET status = ?, credit_status = ?, input_tokens = ?, output_tokens = ?, provider_cost_amount = ?, latency_ms = ?, error_code = ?, error_message = ?, completed_at = now() WHERE id = ?`,
      [success ? 'SUCCEEDED' : 'FAILED', creditStatus, usage.input_tokens ?? null, usage.output_tokens ?? null, providerCost, latencyMs, errorCode, errorMessage ? String(errorMessage).slice(0, 300) : null, runId]);
    return { balance };
  });
}

export async function listLedger(db, wid, { limit = 50 } = {}) {
  return db.all(`SELECT l.id, l.type, l.amount, l.balance_after, l.reason, l.reference_type, l.reference_id, l.ai_run_id, l.created_at, u.name AS created_by_name, r.feature
    FROM credit_ledger l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN ai_runs r ON r.id = l.ai_run_id
    WHERE l.workspace_id = ? ORDER BY l.created_at DESC, l.seq DESC LIMIT ?`, [wid, Math.min(200, Math.max(1, Number(limit) || 50))]);
}
