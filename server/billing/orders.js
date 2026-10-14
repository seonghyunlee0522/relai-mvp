/**
 * Checkout orders: the server decides what a purchase costs, stores it in billing_orders, and the provider is only ever
 * asked to charge `order.amount`. Approvals and provider notifications are applied through processWebhookEvent, which
 * re-checks the paid amount against the order (amount verification) — a tampered payment window amount never activates.
 *
 * Price (VAT excluded) = monthly × months − cycle discount − founding discount, then + 10% VAT, where
 * monthly = base_monthly (workspace incl. owner) + extra users × extra_user_monthly (plans.js monthlyPrice).
 * `seats` on orders/subscriptions is the total user count bought (included_users + extra users) = the TEAM member limit.
 * Founding offer: the first FOUNDING_OFFER.customers workspaces that pay get FOUNDING_OFFER.pct off every purchase made in
 * their first FOUNDING_OFFER.months (subscriptions.founding_until). Slots are counted from PAID founding orders, so two
 * checkouts racing for the last slot can both get it; the overshoot is bounded by concurrent checkouts and accepted.
 */
import { randomBytes } from 'node:crypto';
import { PLANS, CYCLES, VAT_RATE, FOUNDING_OFFER, monthlyPrice } from '../plans.js';

export const MAX_USERS = 1000;
export const ORDER_TTL_MINUTES = 60;   // a payment window result older than this is refused (NicePay allows 10 min to approve)

export class OrderError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

/** Pure price calculation. `users` = total users incl. the owner (`seats` is accepted as an alias). Throws OrderError on bad input. */
export function quote({ plan = 'TEAM', cycle = 'ANNUAL', users, seats, founding = false } = {}) {
  const p = PLANS[plan];
  if (!p || p.contact_sales || !p.base_monthly) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { plan: '선택할 수 없는 플랜입니다.' });
  const c = CYCLES[cycle];
  if (!c) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { cycle: '결제 주기를 선택해 주세요.' });
  const n = Number(users ?? seats);
  const min = p.included_users || 1;
  if (!Number.isInteger(n) || n < min || n > MAX_USERS) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { users: `사용자 수는 ${min}~${MAX_USERS}명 사이로 입력해 주세요.` });
  const extra = Math.max(0, n - min);
  const monthly = monthlyPrice(p, n);
  const list = monthly * c.months;
  const cycleDiscount = Math.round((list * (c.discount_pct || 0)) / 100);
  const foundingDiscount = founding ? Math.round(((list - cycleDiscount) * FOUNDING_OFFER.pct) / 100) : 0;
  const discount = cycleDiscount + foundingDiscount;
  const supply = list - discount;
  const vat = Math.round(supply * VAT_RATE);
  return { plan, cycle, cycle_label: c.label, users: n, seats: n, included_users: min, extra_users: extra, base_monthly: p.base_monthly,
    extra_user_monthly: p.extra_user_monthly, monthly_amount: monthly, months: c.months, unit_price: monthly, list_amount: list,
    cycle_discount_amount: cycleDiscount, founding_discount_amount: foundingDiscount, discount_amount: discount,
    supply_amount: supply, vat_amount: vat, amount: supply + vat, founding: Boolean(founding), currency: 'KRW',
    goods_name: `RELAI ${p.label} ${n}명 ${c.months === 12 ? '1년' : '1개월'}` };
}

/** Is this workspace's next purchase discounted by the founding offer? */
export async function foundingEligible(db, workspaceId) {
  const sub = await db.get('SELECT founding_until FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  if (sub?.founding_until) return new Date(sub.founding_until) > new Date();
  // Already a paying customer without the offer → never eligible later.
  if (await db.get(`SELECT 1 FROM billing_orders WHERE workspace_id = ? AND status IN ('PAID','REFUNDED') LIMIT 1`, [workspaceId])) return false;
  const used = Number((await db.get(`SELECT COUNT(DISTINCT workspace_id) AS n FROM billing_orders WHERE founding AND status IN ('PAID','REFUNDED')`)).n);
  return used < FOUNDING_OFFER.customers;
}

/** Users default/minimum for a workspace: at least the users included in the plan and the current member count. */
export async function minUsers(db, workspaceId, plan = 'TEAM') {
  const members = Number((await db.get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?', [workspaceId])).n);
  return Math.max(PLANS[plan].included_users || 1, members);
}

/** Quote for a workspace (founding offer + member-count floor applied). `users` = total users; `seats` is an alias. */
export async function quoteFor(db, workspaceId, { plan = 'TEAM', cycle = 'ANNUAL', users, seats } = {}) {
  const floor = await minUsers(db, workspaceId, plan);
  const raw = users ?? seats;
  const n = raw === undefined || raw === null || raw === '' ? floor : Number(raw);
  if (Number.isInteger(n) && n < floor) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { users: `현재 멤버 수(${floor}명)보다 적은 사용자 수는 구매할 수 없습니다.` });
  return quote({ plan, cycle, users: n, founding: await foundingEligible(db, workspaceId) });
}

/** NicePay orderId: ≤ 64 chars, unique, never reused. */
export const newOrderId = () => `RELAI${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(9).toString('hex')}`;

export async function createOrder(db, { workspaceId, userId, provider, kind = 'ONE_TIME', q }) {
  const id = newOrderId();
  await db.run(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, discount_amount,
      supply_amount, vat_amount, amount, founding, goods_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, workspaceId, userId, provider, kind, q.plan, q.cycle, q.seats, q.months, q.unit_price, q.list_amount, q.discount_amount, q.supply_amount, q.vat_amount, q.amount, q.founding, q.goods_name]);
  return getOrder(db, id);
}
export const getOrder = (db, id) => db.get('SELECT * FROM billing_orders WHERE id = ?', [String(id || '')]);
export const isExpired = (order) => Date.now() - new Date(order.created_at).getTime() > ORDER_TTL_MINUTES * 60e3;

export async function failOrder(db, id, code, message) {
  await db.run(`UPDATE billing_orders SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ? AND status = 'PENDING'`,
    [String(code || 'failed').slice(0, 60), String(message || '').slice(0, 300), id]);
}

/** Customer-facing order fields. */
export const publicOrder = (o) => o && ({ id: o.id, plan: o.plan, cycle: o.cycle, seats: o.seats, users: o.seats, months: o.months, unit_price: o.unit_price, list_amount: o.list_amount,
  discount_amount: o.discount_amount, supply_amount: o.supply_amount, vat_amount: o.vat_amount, amount: o.amount, founding: o.founding, goods_name: o.goods_name,
  status: o.status, created_at: o.created_at, paid_at: o.paid_at });
