/**
 * 워크스페이스 결제 내역 (pricing v3 T4, spec §4.2 "결제 내역"): read-only list of the workspace's billing_orders for the Billing page.
 *   GET /api/workspaces/:wid/billing/orders → { orders: [{ id, kind, kind_label, title, plan, cycle, amount, supply, vat, status, … }] }
 * OWNER only (requireAction('billing')): amounts are payment data. Only whitelisted columns leave this module — provider TIDs,
 * billing keys and client keys never do. Pending orders older than a day are not listed (abandoned payment windows).
 */
import { requireAction } from '../authz.js';
import { PLANS, CYCLES } from '../plans.js';

export const ORDER_KIND_LABEL = { ONE_TIME: '요금제 결제', RECURRING_FIRST: '정기결제 첫 결제', RECURRING_RENEWAL: '정기결제 갱신', CREDIT_PACK: 'AI 크레딧 충전', CREDIT_TOPUP: 'AI 크레딧 충전', ADDON: '추가 이용', UPGRADE: '요금제 변경' };
export const ORDER_STATUS_LABEL = { PENDING: '결제 대기', APPROVING: '승인 중', PAID: '결제 완료', FAILED: '실패', REFUNDED: '환불' };

/** One order row → what the screen shows (title = what was bought, in words). */
export function orderView(o) {
  const plan = PLANS[o.plan]?.label || o.plan || '';
  const cycle = CYCLES[o.cycle]?.label || '';
  const parts = [];
  if (o.kind === 'CREDIT_PACK' || o.kind === 'CREDIT_TOPUP') parts.push(`AI 크레딧 ${Number(o.credits || 0).toLocaleString('ko-KR')}`);
  else if (o.kind === 'ADDON') { if (Number(o.addon_users)) parts.push(`추가 사용자 ${o.addon_users}명`); if (Number(o.addon_projects)) parts.push(`추가 프로젝트 ${o.addon_projects}개`); }
  else if (o.kind === 'UPGRADE') parts.push(`${plan}로 변경`);
  else parts.push(`${plan}${cycle ? ` ${cycle}` : ''}`);
  const refunded = Number(o.refunded_amount || 0);
  return {
    id: o.id, kind: o.kind, kind_label: ORDER_KIND_LABEL[o.kind] || o.kind, title: parts.join(' · ') || o.goods_name, plan: o.plan || null, cycle: o.cycle || null,
    amount: Number(o.amount), supply: Number(o.supply_amount), vat: Number(o.vat_amount), refunded_amount: refunded,
    status: refunded && o.status === 'PAID' ? 'PARTIAL_REFUND' : o.status, status_label: refunded && o.status === 'PAID' ? '부분 환불' : ORDER_STATUS_LABEL[o.status] || o.status,
    period_start: o.period_start || null, period_end: o.period_end || null, receipt_url: o.receipt_url || null, created_at: o.created_at, paid_at: o.paid_at || null,
  };
}

export async function workspaceOrders(db, wid, { limit = 50 } = {}) {
  const rows = await db.all(`SELECT id, kind, plan, cycle, credits, addon_users, addon_projects, goods_name, amount, supply_amount, vat_amount, refunded_amount, status,
      period_start, period_end, receipt_url, created_at, paid_at
    FROM billing_orders WHERE workspace_id = ? AND (status <> 'PENDING' OR created_at > now() - interval '1 day')
    ORDER BY created_at DESC, id DESC LIMIT ?`, [wid, Math.min(200, Math.max(1, Number(limit) || 50))]);
  return rows.map(orderView);
}

export function mountBillingHistory({ app, db, guard, wrap }) {
  app.get('/api/workspaces/:wid/billing/orders', [...guard, requireAction('billing')], wrap(async (req, res) => res.json({ orders: await workspaceOrders(db, req.params.wid, { limit: req.query.limit }) })));
}
