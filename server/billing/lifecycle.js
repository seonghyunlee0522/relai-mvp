/**
 * Subscription lifecycle (pricing v3 T3, design.md §6, founder decisions 2026-10-20):
 *
 *   scheduled changes  DOWNGRADE (TEAM → PRO), CYCLE (월간 ↔ 연간), ADDON_REDUCE — never now, always at the next renewal, no refund of the
 *                      current period. The renewal charge prices the target (renewalTarget) and applies the rows (subscriptions.js).
 *   cancel             any time, monthly and annual: auto-renewal stops at once (requestCancel in subscriptions.js), the plan runs to the
 *                      end of what was paid.
 *   cancel + refund    the plan ends now and every paid order of the current period is refunded for its unused KST days
 *                      (prorate.js, refunds rounded up, never more than paid), NO penalty, annual NOT re-priced at the monthly list price.
 *                      Within WITHDRAWAL_DAYS of the payment the same row is recorded as 청약철회 (WITHDRAWAL). The refund is executed as
 *                      a NicePay partial cancel with a new orderId when REFUND_PARTIAL_ENABLED=true; otherwise it stays REQUESTED for the
 *                      operator (관리자) and the owner is told it will be paid within 3 business days.
 *   after the end      ended_at + data_retention_until (30 days of 조회 · 내보내기); nothing is deleted by billing.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { PLANS, PAID_PLANS, CYCLES, limitsFor } from '../plans.js';
import { prorate, kstDaysBetween } from './prorate.js';
import { renewalAmount, newOrderId, OrderError } from './orders.js';
import { countUsage } from './limits.js';
import { transition } from './subscriptions.js';
import { WITHDRAWAL_DAYS } from './consent.js';

export const CHANGE_KINDS = ['DOWNGRADE', 'CYCLE', 'ADDON_REDUCE'];
export const PERIOD_KINDS = ['ONE_TIME', 'RECURRING_FIRST', 'RECURRING_RENEWAL', 'ADDON', 'UPGRADE'];
export const refundPartialEnabled = () => process.env.REFUND_PARTIAL_ENABLED === 'true';
const DAY = 86400e3;

const stateOf = (s) => ({ plan: s.plan, cycle: s.billing_cycle || 'MONTHLY', extra_users: Number(s.extra_users || 0), extra_projects: Number(s.extra_projects || 0) });
const parse = (j) => { try { return JSON.parse(j); } catch { return {}; } };

/** Open scheduled changes of a subscription, oldest first, with parsed states. */
export async function scheduledChanges(db, subscriptionId) {
  if (!subscriptionId) return [];
  const rows = await db.all(`SELECT id, kind, from_state, to_state, effective_at, created_at FROM subscription_changes WHERE subscription_id = ? AND status = 'SCHEDULED' ORDER BY created_at, id`, [subscriptionId]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, from: parse(r.from_state), to: parse(r.to_state), effective_at: r.effective_at, created_at: r.created_at }));
}

/** The state the next renewal charges: current plan / cycle / add-ons with every scheduled change applied (oldest first). */
export function composeTarget(sub, changes) {
  const t = stateOf(sub);
  for (const c of changes) {
    if (c.kind === 'DOWNGRADE') Object.assign(t, { plan: c.to.plan, extra_users: c.to.extra_users ?? 0, extra_projects: c.to.extra_projects ?? 0 });
    else if (c.kind === 'CYCLE') t.cycle = c.to.cycle;
    else if (c.kind === 'ADDON_REDUCE') Object.assign(t, { extra_users: c.to.extra_users, extra_projects: c.to.extra_projects });
  }
  return { ...t, amount: renewalAmount(t.plan, t.cycle, t.extra_users, t.extra_projects), months: CYCLES[t.cycle]?.months || 1 };
}
export async function renewalTarget(db, sub) { return composeTarget(sub, await scheduledChanges(db, sub.id)); }

const err = (status, code, message, fields) => new OrderError(status, code, message, fields);

/**
 * Schedule a change for the next renewal. body: DOWNGRADE { plan: 'PRO', extra_users?, extra_projects? } · CYCLE { cycle } ·
 * ADDON_REDUCE { extra_users, extra_projects } (the new totals). Refused when the workspace's usage would not fit the target
 * ("먼저 정리") and when the subscription does not renew. A second request of the same kind replaces the first.
 * Returns { change, target }.
 */
export async function scheduleChange(db, { workspaceId, userId, kind, body = {} }) {
  if (!CHANGE_KINDS.includes(kind)) throw err(400, 'validation_error', '입력값을 확인해 주세요.', { kind: '변경 종류를 확인해 주세요.' });
  return tx(db, async (t) => {
    const sub = await t.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (!sub || sub.status !== 'ACTIVE' || !PAID_PLANS.includes(sub.plan)) throw err(409, 'no_paid_plan', 'Pro 또는 Team 플랜을 이용 중일 때만 변경을 예약할 수 있습니다.');
    if (!sub.auto_renew || sub.cancel_at_period_end) throw err(409, 'not_renewing', '해지 예약된 구독은 다음 결제가 없어 변경을 예약할 수 없습니다. 해지를 취소하거나 새로 구독해 주세요.');
    if (sub.price_version === 'v2') throw err(409, 'legacy_plan', '이전 요금제 이용 기간이 끝난 뒤 새 요금제로 변경할 수 있습니다.');
    const cur = stateOf(sub);
    const others = (await scheduledChanges(t, sub.id)).filter((c) => c.kind !== kind);
    const int = (v, field) => { const n = Number(v ?? 0); if (!Number.isInteger(n) || n < 0 || n > 1000) throw err(400, 'validation_error', '입력값을 확인해 주세요.', { [field]: '0 이상의 정수로 입력해 주세요.' }); return n; };
    let to;
    if (kind === 'DOWNGRADE') {
      const plan = String(body.plan || '');
      if (!PAID_PLANS.includes(plan) || PAID_PLANS.indexOf(plan) >= PAID_PLANS.indexOf(sub.plan)) {
        throw err(409, 'not_downgrade', plan === 'FREE' ? 'Free로 바꾸려면 구독을 해지해 주세요. 결제한 기간이 끝나면 Free 플랜이 됩니다.' : '현재보다 낮은 유료 플랜만 예약할 수 있습니다.');
      }
      to = { plan, extra_users: int(body.extra_users, 'extra_users'), extra_projects: int(body.extra_projects, 'extra_projects') };
    } else if (kind === 'CYCLE') {
      const cycle = String(body.cycle || '');
      if (!CYCLES[cycle]) throw err(400, 'validation_error', '입력값을 확인해 주세요.', { cycle: '결제 주기를 선택해 주세요.' });
      if (cycle === cur.cycle && !others.length) throw err(409, 'same_cycle', `이미 ${CYCLES[cycle].label} 결제입니다.`);
      to = { cycle };
    } else {
      to = { extra_users: int(body.extra_users, 'extra_users'), extra_projects: int(body.extra_projects, 'extra_projects') };
      if (to.extra_users > cur.extra_users || to.extra_projects > cur.extra_projects) throw err(409, 'not_reduction', '늘리는 것은 추가 구매로 바로 할 수 있습니다. 여기서는 줄이는 것만 예약합니다.');
      if (to.extra_users === cur.extra_users && to.extra_projects === cur.extra_projects) throw err(409, 'no_change', '바뀌는 수량이 없습니다.');
    }
    const target = composeTarget(sub, [...others, { kind, to }]);
    // The target must hold what the workspace uses today (members + pending invites, active projects): clean up first.
    const lim = limitsFor({ plan: target.plan, extra_users: target.extra_users, extra_projects: target.extra_projects });
    const u = await countUsage(t, workspaceId);
    const over = [];
    if (lim.users !== null && u.members + u.pending_invites > lim.users) over.push(`사용자 ${u.members + u.pending_invites - lim.users}명`);
    if (lim.projects !== null && u.projects_active > lim.projects) over.push(`활성 프로젝트 ${u.projects_active - lim.projects}개`);
    if (over.length) throw err(409, 'reduce_first', `변경 후 한도보다 ${over.join(', ')}이(가) 많습니다. 먼저 멤버를 내보내거나 초대를 취소하고, 프로젝트를 완료 · 보관해 주세요.`, { usage: u, limits_after: lim });
    await t.run(`UPDATE subscription_changes SET status = 'CANCELED', closed_at = now() WHERE subscription_id = ? AND kind = ? AND status = 'SCHEDULED'`, [sub.id, kind]);
    const id = randomUUID();
    await t.run(`INSERT INTO subscription_changes (id, subscription_id, workspace_id, kind, from_state, to_state, effective_at, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [id, sub.id, workspaceId, kind, JSON.stringify(cur), JSON.stringify(to), sub.current_period_end, userId || null]);
    await t.run('INSERT INTO subscription_events (id, subscription_id, event_type, metadata) VALUES (?,?,?,?)', [randomUUID(), sub.id, `change.scheduled:${kind}`, JSON.stringify({ to, by: userId || null })]);
    return { change: { id, kind, from: cur, to, effective_at: sub.current_period_end }, target };
  });
}

/** Withdraw a scheduled change (the OWNER's "취소"). */
export async function cancelScheduledChange(db, { workspaceId, changeId }) {
  const r = await db.get(`UPDATE subscription_changes SET status = 'CANCELED', closed_at = now() WHERE id = ? AND workspace_id = ? AND status = 'SCHEDULED' RETURNING id`, [String(changeId || ''), workspaceId]);
  return Boolean(r);
}

/* ---------- cancel + refund (unused days, no penalty) ---------- */

/** The slice of time a paid order covers: its own period_* (add-ons, upgrades, renewals) or the subscription period it bought. */
function orderPeriod(order, sub) {
  if (order.period_start && order.period_end) return { start: order.period_start, end: order.period_end };
  if (!sub?.current_period_end || !order.months) return null;
  const end = new Date(sub.current_period_end); const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - Number(order.months));
  return { start, end };
}

/**
 * Refund preview for an immediate cancel at `at`: one line per paid order of the current period with unused days.
 * Used days = from the period start through today (KST); refund = ceil(amount × unused / period days), capped at what is left.
 * kind WITHDRAWAL when the order was paid within WITHDRAWAL_DAYS (청약철회), else CANCEL — the amount rule is the same.
 */
export async function refundQuote(db, workspaceId, { at = new Date() } = {}) {
  const sub = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  if (!sub || !['ACTIVE', 'PAST_DUE'].includes(sub.status) || !PAID_PLANS.includes(sub.plan)) return { sub, lines: [], total: 0 };
  const orders = await db.all(`SELECT * FROM billing_orders WHERE workspace_id = ? AND status = 'PAID' AND kind IN (${PERIOD_KINDS.map(() => '?').join(',')}) ORDER BY paid_at`, [workspaceId, ...PERIOD_KINDS]);
  const tomorrow = new Date(at.getTime() + DAY);
  const lines = [];
  for (const o of orders) {
    const left = Number(o.amount) - Number(o.refunded_amount || 0);
    if (!(left > 0)) continue;
    const per = orderPeriod(o, sub);
    if (!per || new Date(per.end) <= at) continue;
    const r = prorate({ unit: Number(o.amount), qty: 1, periodStart: per.start, periodEnd: per.end, at: tomorrow, dir: 'up' });
    const amount = Math.min(left, r.amount);
    if (!(amount > 0)) continue;
    const withdrawal = o.paid_at && kstDaysBetween(o.paid_at, at) < WITHDRAWAL_DAYS;
    lines.push({ order_id: o.id, kind: withdrawal ? 'WITHDRAWAL' : 'CANCEL', order_kind: o.kind, label: o.goods_name, paid: Number(o.amount), paid_at: o.paid_at,
      days: r.days, period_days: r.period_days, amount });
  }
  return { sub, lines, total: lines.reduce((s, l) => s + l.amount, 0), withdrawal: lines.some((l) => l.kind === 'WITHDRAWAL') };
}

/**
 * Immediate cancel with the refund of unused days. provider.cancel (billing key expiry) runs first, outside the DB lock; then in one
 * transaction the subscription ends now (CANCELED, ended_at, 30-day retention), scheduled changes lapse and one
 * subscription_refunds row per order is written (REQUESTED). After the commit, when REFUND_PARTIAL_ENABLED, each refund is sent as a
 * partial cancel with a new orderId; a failure leaves the row FAILED for the operator (never retried blindly).
 */
export async function cancelWithRefund(db, provider, { workspaceId, userId = null, reason = '고객 해지 환불' }) {
  const pre = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  if (!pre || !['ACTIVE', 'PAST_DUE'].includes(pre.status) || !PAID_PLANS.includes(pre.plan)) return { error: 'no_active_subscription' };
  if (pre.billing_key_enc && provider?.cancel) await provider.cancel({ subscription: pre });
  const out = await tx(db, async (t) => {
    const sub = await t.get('SELECT * FROM subscriptions WHERE workspace_id = ? FOR UPDATE', [workspaceId]);
    if (!sub || !['ACTIVE', 'PAST_DUE'].includes(sub.status)) return { error: 'no_active_subscription' };
    const q = await refundQuote(t, workspaceId);
    for (const l of q.lines) await t.get('SELECT id FROM billing_orders WHERE id = ? FOR UPDATE', [l.order_id]);
    const rows = [];
    for (const l of q.lines) {
      const id = randomUUID();
      await t.run(`INSERT INTO subscription_refunds (id, workspace_id, subscription_id, order_id, kind, amount, days, period_days, reason, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, workspaceId, sub.id, l.order_id, l.kind, l.amount, l.days, l.period_days, String(reason).slice(0, 100), userId]);
      rows.push({ id, ...l });
    }
    await transition(t, sub, 'subscription.canceled', { immediate: true });
    await t.run(`UPDATE subscriptions SET auto_renew = false, cancel_at_period_end = false, billing_key_enc = NULL, current_period_end = LEAST(current_period_end, now()) WHERE id = ?`, [sub.id]);
    await t.run(`UPDATE subscription_changes SET status = 'CANCELED', closed_at = now() WHERE subscription_id = ? AND status = 'SCHEDULED'`, [sub.id]);
    return { refunds: rows, total: q.total, withdrawal: q.withdrawal, subscription_id: sub.id };
  });
  if (out.error) return out;
  out.executed = false;
  if (refundPartialEnabled() && provider?.refundPartial) {
    out.executed = true;
    for (const r of out.refunds) Object.assign(r, await executeRefund(db, provider, r.id));
  }
  return out;
}

/** Sends one REQUESTED/FAILED refund to the provider (partial cancel, new orderId). Returns { status, failure_message? }. */
export async function executeRefund(db, provider, refundId) {
  const r = await db.get(`SELECT * FROM subscription_refunds WHERE id = ?`, [refundId]);
  if (!r || r.status === 'DONE') return { status: r?.status || 'MISSING' };
  const order = await db.get('SELECT * FROM billing_orders WHERE id = ?', [r.order_id]);
  const cancelOrderId = newOrderId();
  try {
    const p = await provider.refundPartial({ order, amount: Number(r.amount), reason: r.kind === 'WITHDRAWAL' ? '청약철회' : '해지 환불 (미사용 기간)', cancelOrderId });
    await tx(db, async (t) => {
      const done = await t.get(`UPDATE subscription_refunds SET status = 'DONE', cancel_order_id = ?, cancelled_tid = ?, failure_message = NULL, done_at = now() WHERE id = ? AND status <> 'DONE' RETURNING id`, [cancelOrderId, p.cancelled_tid || null, r.id]);
      if (done) await t.run('UPDATE billing_orders SET refunded_amount = refunded_amount + ?, refund_tid_seq = refund_tid_seq + 1, updated_at = now() WHERE id = ?', [Number(r.amount), r.order_id]);
    });
    return { status: 'DONE' };
  } catch (e) {
    await db.run(`UPDATE subscription_refunds SET status = 'FAILED', cancel_order_id = ?, failure_message = ? WHERE id = ? AND status <> 'DONE'`, [cancelOrderId, String(e.message || 'refund failed').slice(0, 300), r.id]);
    return { status: 'FAILED', failure_message: e.message };
  }
}

/** Operator: a refund paid by hand (bank transfer, console cancel) is marked DONE and counted on its order. */
export async function markRefundDone(db, refundId, { note = '' } = {}) {
  return tx(db, async (t) => {
    const r = await t.get(`UPDATE subscription_refunds SET status = 'DONE', done_at = now(), failure_message = ? WHERE id = ? AND status <> 'DONE' RETURNING order_id, amount`, [note ? `수동 처리: ${String(note).slice(0, 200)}` : '수동 처리', String(refundId || '')]);
    if (r) await t.run('UPDATE billing_orders SET refunded_amount = refunded_amount + ?, updated_at = now() WHERE id = ?', [Number(r.amount), r.order_id]);
    return Boolean(r);
  });
}

/** Public view of the refunds of a workspace (newest first). */
export const listRefunds = (db, workspaceId) => db.all(`SELECT id, order_id, kind, amount, days, period_days, status, created_at, done_at FROM subscription_refunds WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`, [workspaceId]);

export { PLANS };
