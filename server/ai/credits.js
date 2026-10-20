/**
 * Workspace AI credits: one account per workspace + an append-only ledger. The balance column is a cache for fast
 * reads; every change goes through the ledger (grant / usage / adjustment / expiry) inside a transaction that locks the
 * account row (SELECT … FOR UPDATE), so concurrent AI requests can never drive the balance negative.
 *
 * Buckets (pricing v3 T2, migration 62, design.md §4) — `balance` = plan + promo + purchased:
 *   PLAN       monthly base credits of a paid plan (billing/ai-grants.js); expire at plan_expires_at (end of the credit cycle)
 *   PROMO      Free 100 (once per owner / e-mail / workspace, D7), operator and promotion grants; no expiry
 *   PURCHASED  top-ups (유상, billing/credit-packs.js); valid PURCHASED_VALID_YEARS, the only refundable bucket
 * Spend order PLAN → PROMO → PURCHASED (refundable money last). Every ledger row carries its split in d_plan / d_promo / d_purchased.
 * Locking the account (lockAccount) also (1) folds drift written by pre-62 code (balance changed, buckets not) back into the
 * buckets and (2) expires a PLAN bucket whose plan_expires_at has passed (EXPIRY row) — so a reservation that outlives the
 * cycle settles against what is really left, never below zero.
 *
 * Flow per AI run:  reserve (lock, check available = balance − open reservations, insert ai_run RESERVED)
 *                   → provider call → settle: success = charge (balance −cost split by bucket, ledger AI_USAGE, run CHARGED)
 *                                               failure = release (run RELEASED, nothing written to the ledger)
 * Open reservations are derived from ai_runs rows (credit_status = RESERVED, younger than RESERVATION_TTL) so a crash
 * between reserve and settle simply expires instead of leaking a counter.
 */
import { randomUUID, createHash } from 'node:crypto';
import { tx } from '../db.js';
import { aiConfig } from './config.js';
import { LOW_BALANCE_CREDITS, PLANS_URL } from '../plans.js';

export const LEDGER_TYPES = ['PLAN_GRANT', 'ADMIN_GRANT', 'AI_USAGE', 'REFUND', 'ADJUSTMENT', 'PROMOTION', 'PURCHASE', 'EXPIRY'];
/** Ledger reference of the one-time starter grant (new workspaces) and of the v41 top-up of existing workspaces to the same amount. */
export const STARTER_REFS = ['AI_INITIAL_TRIAL_CREDITS', 'STARTER_TOPUP', 'STARTER_WORKSPACE_52'];
export const BUCKETS = ['plan', 'promo', 'purchased'];
/** Spend order (design.md §4): base credits first, refundable purchased credits last. */
export const SPEND_ORDER = ['plan', 'promo', 'purchased'];
const COL = { plan: 'plan_balance', promo: 'promo_balance', purchased: 'purchased_balance' };
export const EXPIRY_REF = 'PLAN_EXPIRY';
const RESERVATION_TTL = "interval '10 minutes'";

export class CreditError extends Error {
  constructor(code, message, { status = 402, ...extra } = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

const bucketsOf = (acc) => ({ plan: Number(acc.plan_balance || 0), promo: Number(acc.promo_balance || 0), purchased: Number(acc.purchased_balance || 0) });
const sumOf = (b) => b.plan + b.promo + b.purchased;
/** Pure: take `n` from the buckets in `order` → the per-bucket split (negative numbers), or null when they hold less than n. */
export function splitDebit(b, n, order = SPEND_ORDER) {
  const d = { plan: 0, promo: 0, purchased: 0 };
  let left = n;
  for (const k of order) { const take = Math.min(left, b[k]); d[k] = take ? -take : 0; left -= take; }
  return left > 0 ? null : d;
}

/**
 * Lock the account row and bring its buckets in line: drift from pre-62 writers (balance moved, buckets did not) is folded in
 * (more → PROMO, less → spend order), and a PLAN bucket past plan_expires_at is expired with an EXPIRY ledger row.
 */
async function lockAccount(t, wid) {
  const acc = await t.get('SELECT * FROM workspace_credit_accounts WHERE workspace_id = ? FOR UPDATE', [wid]);
  if (!acc) return acc;
  const b = bucketsOf(acc); const balance = Number(acc.balance);
  const drift = balance - sumOf(b);
  if (drift !== 0) {
    if (drift > 0) b.promo += drift;
    else { const d = splitDebit(b, -drift); for (const k of BUCKETS) b[k] += d[k]; }
    await t.run('UPDATE workspace_credit_accounts SET plan_balance = ?, promo_balance = ?, purchased_balance = ? WHERE workspace_id = ?', [b.plan, b.promo, b.purchased, wid]);
  }
  let row = { ...acc, plan_balance: b.plan, promo_balance: b.promo, purchased_balance: b.purchased };
  if (b.plan > 0 && acc.plan_expires_at && new Date(acc.plan_expires_at) <= new Date()) {
    row = await expireLocked(t, row, { reason: '기본 크레딧 소멸 (지급 주기 종료)', referenceId: new Date(acc.plan_expires_at).toISOString() });
  }
  return row;
}

/** Expire the whole PLAN bucket of a locked row (EXPIRY −plan). Returns the updated row. */
async function expireLocked(t, acc, { reason, referenceType = EXPIRY_REF, referenceId = null, createdBy = null }) {
  const n = Number(acc.plan_balance || 0);
  if (n <= 0) return acc;
  const balance = Number(acc.balance) - n;
  await t.run('UPDATE workspace_credit_accounts SET balance = ?, plan_balance = 0, plan_expires_at = NULL, updated_at = now() WHERE workspace_id = ?', [balance, acc.workspace_id]);
  await writeLedger(t, { wid: acc.workspace_id, type: 'EXPIRY', amount: -n, balanceAfter: balance, reason, referenceType, referenceId, createdBy, d: { plan: -n, promo: 0, purchased: 0 } });
  return { ...acc, balance, plan_balance: 0, plan_expires_at: null };
}

const openReservations = async (t, wid) => (await t.get(`SELECT COALESCE(SUM(credit_cost), 0) AS n FROM ai_runs WHERE workspace_id = ? AND credit_status = 'RESERVED' AND created_at > now() - ${RESERVATION_TTL}`, [wid])).n;

async function writeLedger(t, { wid, runId = null, type, amount, balanceAfter, reason = '', referenceType = null, referenceId = null, createdBy = null, d = null }) {
  const id = randomUUID();
  // created_at = clock_timestamp(): the time of the write under the account lock, so ordering by created_at matches balance_after even
  // when a transaction that started earlier waited for the lock (now() would be its start time).
  await t.run(`INSERT INTO credit_ledger (id, workspace_id, ai_run_id, type, amount, balance_after, reason, reference_type, reference_id, created_by, d_plan, d_promo, d_purchased, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, clock_timestamp())`, [id, wid, runId, type, amount, balanceAfter, reason, referenceType, referenceId, createdBy, d ? d.plan : null, d ? d.promo : null, d ? d.purchased : null]);
  return id;
}

/** Normalized e-mail for the Free-100 claim: trimmed, lower case, "+tag" dropped from the local part. */
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase().replace(/\+[^@]*(?=@)/, '');
/** sha256 of the normalized e-mail (free_credit_claims.email_hash) — the address itself is never stored there. */
export const emailHash = (email) => createHash('sha256').update(`relai-free-credit:${normalizeEmail(email)}`).digest('hex');

/**
 * Free 100 claim (D7). scope 'owner' (default): one grant per owner account AND per normalized e-mail, recorded in free_credit_claims
 * in the caller's transaction (ON CONFLICT DO NOTHING decides a race) — a second workspace of the same owner, or the same e-mail after
 * withdrawal and re-signup, gets nothing. scope 'workspace': once per workspace only (the account INSERT already guarantees that).
 */
async function claimFree(t, wid, scope) {
  if (scope === 'workspace') return true;
  const o = await t.get('SELECT u.id, u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?', [wid]);
  if (!o?.email) return false;
  return Boolean(await t.get('INSERT INTO free_credit_claims (owner_user_id, email_hash, workspace_id) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING owner_user_id', [o.id, emailHash(o.email), wid]));
}

/**
 * Creates the account on first touch and applies the ONE-TIME initial grant policy, exactly once per workspace:
 *   - DEV_INITIAL_AI_CREDITS > 0  (development / test)  → PLAN_GRANT of that amount (PROMO bucket), and the trial grant is skipped
 *   - otherwise AI_INITIAL_TRIAL_CREDITS (production, default 100 = Free 최초 100) → PROMOTION "무료 시작 크레딧", only when the
 *     owner's Free claim is still open (claimFree, D7)
 * The grant is tied to the INSERT (ON CONFLICT DO NOTHING + changes = 1) under the row lock, so an existing account —
 * or two concurrent first calls — can never be granted twice. An existing account is returned normalized (lockAccount).
 */
export async function ensureAccount(db, wid, opts = {}) {
  const cfg = aiConfig();
  const devInitial = opts.devInitial ?? cfg.devInitialCredits;
  const trial = opts.trial ?? cfg.trialCredits;
  return tx(db, async (t) => {
    const existing = await lockAccount(t, wid);
    if (existing) return existing;
    const ins = await t.run('INSERT INTO workspace_credit_accounts (workspace_id) VALUES (?) ON CONFLICT (workspace_id) DO NOTHING', [wid]);
    if (ins.changes) {
      const grant = devInitial > 0 ? { amount: devInitial, type: 'PLAN_GRANT', reason: '개발 초기 지급 (DEV_INITIAL_AI_CREDITS)', referenceType: 'ENV', referenceId: 'DEV_INITIAL_AI_CREDITS' }
        : trial > 0 && await claimFree(t, wid, opts.claimScope ?? cfg.freeClaimScope) ? { amount: trial, type: 'PROMOTION', reason: '무료 시작 크레딧', referenceType: 'ENV', referenceId: 'AI_INITIAL_TRIAL_CREDITS' } : null;
      if (grant) {
        await t.run('UPDATE workspace_credit_accounts SET balance = ?, promo_balance = ?, lifetime_granted = ?, updated_at = now() WHERE workspace_id = ?', [grant.amount, grant.amount, grant.amount, wid]);
        await writeLedger(t, { wid, type: grant.type, amount: grant.amount, balanceAfter: grant.amount, reason: grant.reason, referenceType: grant.referenceType, referenceId: grant.referenceId, d: { plan: 0, promo: grant.amount, purchased: 0 } });
      }
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
 * Bucket view (T4 screens, GET …/billing credits): { total, plan, plan_expires_at, promo, purchased, reserved, available }.
 * Reading normalizes the account first, so an expired PLAN bucket shows as 0 (with its EXPIRY row written).
 */
export async function bucketBalances(db, wid) {
  const acc = await ensureAccount(db, wid);
  const reserved = Number(await openReservations(db, wid));
  const b = bucketsOf(acc); const total = Number(acc.balance);
  return { total, plan: b.plan, plan_expires_at: b.plan > 0 && acc.plan_expires_at ? new Date(acc.plan_expires_at).toISOString() : null, promo: b.promo, purchased: b.purchased,
    reserved, available: Math.max(0, total - reserved) };
}

/** Default bucket of a grant (positive) by ledger type; the plan bucket is only ever filled on request (ai-grants.js). */
const creditBucket = (type) => (type === 'PURCHASE' || type === 'REFUND' ? 'purchased' : 'promo');
/** Debit buckets by ledger type: a refund takes purchased credits only, an expiry the plan bucket only; the rest spend in order. */
const debitOrder = (type) => (type === 'REFUND' ? ['purchased'] : type === 'EXPIRY' ? ['plan'] : SPEND_ORDER);

/**
 * Grant or adjust credits (admin / plan / promotion / purchase / refund). Positive = grant into `bucket` (default by type: PURCHASE and
 * a restoring REFUND → purchased, anything else → promo; 'plan' with `expiresAt` = the cycle's base credits). Negative = adjustment
 * from `bucket` or, by default, in spend order (REFUND: purchased only) — never below zero. Must run inside the caller's
 * transaction when it is paired with an audit row.
 */
export async function applyCredits(db, { wid, amount, type, reason, createdBy = null, referenceType = null, referenceId = null, bucket = null, expiresAt = null }) {
  if (!LEDGER_TYPES.includes(type)) throw new CreditError('bad_type', '원장 유형이 올바르지 않습니다.', { status: 400 });
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new CreditError('bad_amount', '크레딧 수량은 0이 아닌 정수여야 합니다.', { status: 400 });
  if (bucket && !BUCKETS.includes(bucket)) throw new CreditError('bad_bucket', '크레딧 구분이 올바르지 않습니다.', { status: 400 });
  return tx(db, async (t) => {
    await ensureAccount(t, wid);
    const acc = await lockAccount(t, wid);
    const b = bucketsOf(acc);
    const next = Number(acc.balance) + amount;
    let d;
    if (amount > 0) { d = { plan: 0, promo: 0, purchased: 0 }; d[bucket || creditBucket(type)] = amount; }
    else {
      d = next < 0 ? null : splitDebit(b, -amount, bucket ? [bucket] : debitOrder(type));
      if (!d) {
        const avail = bucket ? b[bucket] : debitOrder(type).reduce((s, k) => s + b[k], 0);
        throw new CreditError('AI_CREDIT_INSUFFICIENT', `차감할 크레딧이 부족합니다. (현재 ${avail}, 요청 ${amount})`, { status: 409, balance: avail, required: -amount });
      }
    }
    const nb = { plan: b.plan + d.plan, promo: b.promo + d.promo, purchased: b.purchased + d.purchased };
    // A grant that lifts the balance back to the warning threshold re-arms the one low-balance e-mail (a purchase, typically).
    await t.run(`UPDATE workspace_credit_accounts SET balance = ?, plan_balance = ?, promo_balance = ?, purchased_balance = ?,
      plan_expires_at = COALESCE(?::timestamptz, plan_expires_at),
      lifetime_granted = lifetime_granted + ?, lifetime_used = lifetime_used + ?, updated_at = now(),
      low_balance_notified_at = CASE WHEN ?::bigint >= ?::bigint THEN NULL ELSE low_balance_notified_at END WHERE workspace_id = ?`,
    [next, nb.plan, nb.promo, nb.purchased, expiresAt, amount > 0 ? amount : 0, amount < 0 ? -amount : 0, next, LOW_BALANCE_CREDITS, wid]);
    const ledgerId = await writeLedger(t, { wid, type, amount, balanceAfter: next, reason, referenceType, referenceId, createdBy, d });
    return { ledger_id: ledgerId, balance: next, buckets: nb };
  });
}

/**
 * Expire the whole PLAN bucket now (T3: subscription ended / immediate cancel / grace over / refund; the daily sweep). Idempotent:
 * an empty bucket writes nothing. Returns { expired } (credits removed).
 */
export async function expirePlanCredits(db, wid, { reason = '기본 크레딧 소멸 (구독 종료)', referenceType = EXPIRY_REF, referenceId = null, createdBy = null } = {}) {
  return tx(db, async (t) => {
    await ensureAccount(t, wid);
    const acc = await lockAccount(t, wid);
    const n = Number(acc.plan_balance || 0);
    if (n > 0) await expireLocked(t, acc, { reason, referenceType, referenceId, createdBy });
    return { expired: n };
  });
}

/** Insert the PENDING ai_run and reserve its credits atomically. Throws CreditError AI_CREDIT_INSUFFICIENT. */
export async function reserveRun(db, { wid, projectId, userId, feature, provider, model, inputSummary, cost }) {
  return tx(db, async (t) => {
    await ensureAccount(t, wid);
    const acc = await lockAccount(t, wid);
    const reserved = await openReservations(t, wid);
    const available = acc.balance - reserved;
    if (cost > 0 && available < cost) throw new CreditError('AI_CREDIT_INSUFFICIENT', 'AI 크레딧이 부족합니다.', { balance: Math.max(0, available), required: cost, feature, upgrade: { url: PLANS_URL } });
    const id = randomUUID();
    await t.run(`INSERT INTO ai_runs (id, workspace_id, project_id, user_id, feature, provider, model, status, input_summary, credit_cost, credit_status)
      VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?)`, [id, wid, projectId, userId, feature, provider, model, inputSummary, cost, cost > 0 ? 'RESERVED' : 'NONE']);
    return { id, balance_before: acc.balance, available };
  });
}

export const SETTLEMENT_CONFLICT = 'AI_CREDIT_SETTLEMENT_CONFLICT';
/**
 * Finish a run — one transaction, account row locked, idempotent (a run that is no longer PENDING is left untouched).
 *   success + enough balance → charge: balance −cost split PLAN → PROMO → PURCHASED, ledger AI_USAGE, run SUCCEEDED/CHARGED
 *   success + balance < cost → settlement conflict: the result was already delivered but the reservation had expired (or the
 *                              PLAN bucket expired meanwhile) and other runs spent the credits. Nothing is charged (no ledger row,
 *                              balance untouched), run SUCCEEDED/RELEASED with error_code AI_CREDIT_SETTLEMENT_CONFLICT so Admin can see it.
 *   failure                 → release: run FAILED/RELEASED, nothing written to the ledger.
 * Invariant: workspace_credit_accounts.balance always equals the last ledger balance_after, and never goes negative.
 */
export async function settleRun(db, runId, opts) {
  const out = await settle(db, runId, opts);
  // Low-balance e-mail: claimed inside the charge transaction, sent after it (never holds the account lock on a mail provider).
  if (!out) return out;
  const { workspace_id: wid, low_balance_crossed: low, ...result } = out;
  if (low && !db.isTx) await notifyLowBalance(db, wid, out.balance).catch((e) => console.error('[credits] low-balance e-mail failed', e.message));
  return result;
}
async function settle(db, runId, { success, usage = {}, providerCost = null, latencyMs = null, errorCode = null, errorMessage = null }) {
  return tx(db, async (t) => {
    const run = await t.get('SELECT * FROM ai_runs WHERE id = ? FOR UPDATE', [runId]);
    if (!run || run.status !== 'PENDING') return null;
    let balance = null; let creditStatus = run.credit_cost > 0 ? 'RELEASED' : 'NONE'; let conflict = false; let lowCrossed = false;
    if (success && run.credit_cost > 0) {
      const acc = await lockAccount(t, run.workspace_id);
      const cost = Number(run.credit_cost);
      const d = Number(acc.balance) >= cost ? splitDebit(bucketsOf(acc), cost) : null;
      if (d) {
        balance = Number(acc.balance) - cost;
        await t.run(`UPDATE workspace_credit_accounts SET balance = ?, plan_balance = plan_balance + ?, promo_balance = promo_balance + ?, purchased_balance = purchased_balance + ?,
          lifetime_used = lifetime_used + ?, updated_at = now() WHERE workspace_id = ?`, [balance, d.plan, d.promo, d.purchased, cost, run.workspace_id]);
        await writeLedger(t, { wid: run.workspace_id, runId, type: 'AI_USAGE', amount: -cost, balanceAfter: balance, reason: run.feature, referenceType: 'AI_RUN', referenceId: runId, createdBy: run.user_id, d });
        creditStatus = 'CHARGED';
        if (balance < LOW_BALANCE_CREDITS && !acc.low_balance_notified_at) {
          lowCrossed = Boolean(await t.get('UPDATE workspace_credit_accounts SET low_balance_notified_at = now() WHERE workspace_id = ? AND low_balance_notified_at IS NULL RETURNING workspace_id', [run.workspace_id]));
        }
      } else {
        conflict = true; balance = Number(acc.balance);
        errorCode = SETTLEMENT_CONFLICT; errorMessage = `정산 시점 잔액(${acc.balance})이 비용(${run.credit_cost})보다 적어 차감하지 않았습니다. (예약 만료 또는 기본 크레딧 소멸 후 다른 요청이 크레딧을 사용)`;
      }
    }
    await t.run(`UPDATE ai_runs SET status = ?, credit_status = ?, input_tokens = ?, output_tokens = ?, provider_cost_amount = ?, latency_ms = ?, error_code = ?, error_message = ?, completed_at = now() WHERE id = ?`,
      [success ? 'SUCCEEDED' : 'FAILED', creditStatus, usage.input_tokens ?? null, usage.output_tokens ?? null, providerCost, latencyMs, errorCode, errorMessage ? String(errorMessage).slice(0, 300) : null, runId]);
    return { balance, credit_status: creditStatus, conflict, workspace_id: run.workspace_id, low_balance_crossed: lowCrossed };
  });
}

/** One e-mail to each active OWNER when the balance first drops below LOW_BALANCE_CREDITS (re-armed by applyCredits). */
export async function notifyLowBalance(db, wid, balance) {
  const [{ sendEmail }, { emailConfig }, { lowBalanceEmail }] = await Promise.all([import('../email/service.js'), import('../email/config.js'), import('../email/templates.js')]);
  const w = await db.get('SELECT name FROM workspaces WHERE id = ?', [wid]);
  const owners = await db.all(`SELECT u.id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'OWNER' AND u.status = 'ACTIVE'`, [wid]);
  const cfg = emailConfig();
  const mail = lowBalanceEmail({ workspaceName: w?.name || '', balance, threshold: LOW_BALANCE_CREDITS, link: cfg.appBaseUrl ? `${cfg.appBaseUrl}/app/settings/credits` : '', support: cfg.supportEmail });
  let sent = 0;
  for (const o of owners) if ((await sendEmail(db, { type: 'AI_CREDIT_LOW_BALANCE', to: o.email, ...mail, relatedUserId: o.id, workspaceId: wid })).status === 'SENT') sent += 1;
  return { sent };
}

/**
 * Balance split for the customer page. Free credits are spent first, so the purchased credits still unused are
 * min(balance, purchased − refunded) — no buckets needed (AI-credits-only billing §3.3).

/**
 * Balance split for the customer page (kept for older readers): purchased_remaining = the PURCHASED bucket, free_remaining = the
 * rest (PLAN + PROMO). purchased / refunded = ledger totals of paid top-ups and their refunds.
 */
export async function balanceSplit(db, wid) {
  const acc = await ensureAccount(db, wid);
  const r = await db.get(`SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'PURCHASE'), 0) AS purchased,
      COALESCE(-SUM(amount) FILTER (WHERE type = 'REFUND' AND reference_type = 'ORDER'), 0) AS refunded FROM credit_ledger WHERE workspace_id = ?`, [wid]);
  const balance = Number(acc.balance); const purchasedLeft = Number(acc.purchased_balance || 0);
  return { balance, purchased: Number(r.purchased), refunded: Number(r.refunded), purchased_remaining: purchasedLeft, free_remaining: balance - purchasedLeft,
    plan_remaining: Number(acc.plan_balance || 0), promo_remaining: Number(acc.promo_balance || 0), low_balance_notified_at: acc.low_balance_notified_at };
}

/**
 * Migration 62 backfill (idempotent, additive — nobody loses a credit): accounts not split yet get
 *   purchased_balance = min(balance, purchased − refunded)  (the old balanceSplit rule), promo_balance = the rest, plan_balance = 0;
 * any later drift (balance ≠ sum of buckets) is folded into PROMO. Owners whose workspace already received a starter grant get a
 * free_credit_claims row (old starter grants count as the Free claim — design.md §11), so no second 100 is granted.
 */
export async function backfillCreditBuckets(db) {
  const split = await db.run(`UPDATE workspace_credit_accounts a SET purchased_balance = LEAST(a.balance, GREATEST(0, COALESCE((SELECT SUM(l.amount) FROM credit_ledger l
      WHERE l.workspace_id = a.workspace_id AND (l.type = 'PURCHASE' OR (l.type = 'REFUND' AND l.reference_type = 'ORDER'))), 0)))
    WHERE a.plan_balance = 0 AND a.promo_balance = 0 AND a.purchased_balance = 0 AND a.balance > 0`);
  await db.run(`UPDATE workspace_credit_accounts SET promo_balance = promo_balance + (balance - plan_balance - promo_balance - purchased_balance)
    WHERE balance > plan_balance + promo_balance + purchased_balance`);
  const owners = await db.all(`SELECT DISTINCT ON (w.owner_id) w.owner_id, u.email, w.id AS workspace_id, l.created_at FROM credit_ledger l JOIN workspaces w ON w.id = l.workspace_id
    JOIN users u ON u.id = w.owner_id WHERE l.type = 'PROMOTION' AND l.reference_id IN (${STARTER_REFS.map(() => '?').join(',')}) ORDER BY w.owner_id, l.created_at`, STARTER_REFS);
  let claims = 0;
  for (const o of owners) {
    if (!o.email) continue;
    if (await db.get('INSERT INTO free_credit_claims (owner_user_id, email_hash, workspace_id, granted_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING owner_user_id',
      [o.owner_id, emailHash(o.email), o.workspace_id, o.created_at])) claims += 1;
  }
  return { split: split.changes, claims };
}

/**
 * One-time starter credits for workspaces that existed before AI-credits-only billing (migration v41): each workspace's starter
 * grant is brought up to `target` (the earlier 100-credit trial counts towards it). Idempotent: a second run finds the starter
 * total already at `target` and grants nothing. Workspaces without an account get theirs from ensureAccount on first touch.
 */
export async function topUpStarterCredits(db, { target = aiConfig().trialCredits } = {}) {
  if (!(target > 0)) return { topped: 0 };
  const rows = await db.all(`SELECT a.workspace_id, COALESCE(SUM(l.amount) FILTER (WHERE l.type = 'PROMOTION' AND l.reference_id IN ('AI_INITIAL_TRIAL_CREDITS','STARTER_TOPUP','STARTER_WORKSPACE_52')), 0) AS starter
    FROM workspace_credit_accounts a JOIN workspaces w ON w.id = a.workspace_id LEFT JOIN credit_ledger l ON l.workspace_id = a.workspace_id
    WHERE w.deleted_at IS NULL GROUP BY a.workspace_id`);
  let topped = 0;
  for (const r of rows) {
    const add = target - Number(r.starter);
    if (add <= 0) continue;
    await applyCredits(db, { wid: r.workspace_id, amount: add, type: 'PROMOTION', reason: `무료 시작 크레딧 (${target.toLocaleString('ko-KR')}까지 충전)`, referenceType: 'ENV', referenceId: 'STARTER_TOPUP' });
    topped += 1;
  }
  return { topped };
}

/**
 * Migration v52 (founder decision 2026-10-20: 500 free credits per WORKSPACE, once). A workspace whose account never received a
 * starter grant (no ledger row referencing any STARTER_REFS — e.g. created while AI_INITIAL_TRIAL_CREDITS was 0 or under
 * DEV_INITIAL_AI_CREDITS) is topped up to a balance of `target`; nothing is ever taken away. Workspaces that already had their
 * starter grant (new-workspace grant or the v41 top-up) are skipped, so nobody is granted twice. Idempotent: the grant writes a
 * STARTER_WORKSPACE_52 ledger row, so a second run finds it and skips. Each workspace runs under its account-row lock.
 */
export async function grantMissingWorkspaceStarter(db, { target = aiConfig().trialCredits } = {}) {
  if (!(target > 0)) return { granted: 0 };
  const rows = await db.all(`SELECT a.workspace_id FROM workspace_credit_accounts a JOIN workspaces w ON w.id = a.workspace_id
    WHERE w.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM credit_ledger l WHERE l.workspace_id = a.workspace_id AND l.reference_id IN (${STARTER_REFS.map(() => '?').join(',')}))`, STARTER_REFS);
  let granted = 0;
  // Workspaces with no credit account yet (review P2-2): open it now — ensureAccount grants the starter on that INSERT — so the
  // migration's count covers them too instead of leaving the grant to the first page view.
  const noAccount = await db.all(`SELECT w.id FROM workspaces w WHERE w.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM workspace_credit_accounts a WHERE a.workspace_id = w.id)`);
  for (const w of noAccount) {
    await ensureAccount(db, w.id);
    if (await db.get(`SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND reference_id IN (${STARTER_REFS.map(() => '?').join(',')})`, [w.id, ...STARTER_REFS])) granted += 1;
  }
  for (const r of rows) {
    const done = await tx(db, async (t) => {
      const acc = await lockAccount(t, r.workspace_id);
      if (await t.get(`SELECT 1 FROM credit_ledger WHERE workspace_id = ? AND reference_id IN (${STARTER_REFS.map(() => '?').join(',')})`, [r.workspace_id, ...STARTER_REFS])) return false;
      const add = target - Number(acc.balance);
      if (add <= 0) return false;
      await applyCredits(t, { wid: r.workspace_id, amount: add, type: 'PROMOTION', reason: `무료 시작 크레딧 (워크스페이스당 ${target.toLocaleString('ko-KR')})`, referenceType: 'ENV', referenceId: 'STARTER_WORKSPACE_52' });
      return true;
    });
    if (done) granted += 1;
  }
  return { granted };
}

/** Safety net for the orchestrator: whatever happened, a PENDING run is never left behind. Idempotent. */
export async function releaseIfPending(db, runId, { errorCode = 'AI_INTERNAL_ERROR', errorMessage = null, latencyMs = null } = {}) {
  return settleRun(db, runId, { success: false, errorCode, errorMessage, latencyMs });
}

export async function listLedger(db, wid, { limit = 50 } = {}) {
  return db.all(`SELECT l.id, l.type, l.amount, l.balance_after, l.reason, l.reference_type, l.reference_id, l.ai_run_id, l.created_at, u.name AS created_by_name, r.feature
    FROM credit_ledger l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN ai_runs r ON r.id = l.ai_run_id
    WHERE l.workspace_id = ? ORDER BY l.created_at DESC, l.seq DESC LIMIT ?`, [wid, Math.min(200, Math.max(1, Number(limit) || 50))]);
}
