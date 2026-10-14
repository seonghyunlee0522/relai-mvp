/**
 * Checkout orders: the server decides what a purchase costs, stores it in billing_orders, and the provider is only ever
 * asked to charge `order.amount`. Approvals and provider notifications are applied through processWebhookEvent, which
 * re-checks the paid amount against the order (amount verification) — a tampered payment window amount never activates.
 *
 * Price = unit (per seat per month, VAT excluded) × seats × months − founding discount, then + 10% VAT.
 * Founding offer: the first FOUNDING_OFFER.customers workspaces that pay get FOUNDING_OFFER.pct off every purchase made in
 * their first FOUNDING_OFFER.months (subscriptions.founding_until). Slots are counted from PAID founding orders, so two
 * checkouts racing for the last slot can both get it; the overshoot is bounded by concurrent checkouts and accepted.
 */
import { randomBytes } from 'node:crypto';
import { PLANS, CYCLES, VAT_RATE, FOUNDING_OFFER } from '../plans.js';

export const MAX_SEATS = 1000;
export const ORDER_TTL_MINUTES = 60;   // a payment window result older than this is refused (NicePay allows 10 min to approve)

export class OrderError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

/** Pure price calculation. Throws OrderError on a bad plan / cycle / seat count. */
export function quote({ plan = 'TEAM', cycle = 'ANNUAL', seats, founding = false } = {}) {
  const p = PLANS[plan];
  if (!p || p.contact_sales || !p.per_seat) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { plan: '선택할 수 없는 플랜입니다.' });
  const c = CYCLES[cycle];
  if (!c) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { cycle: '결제 주기를 선택해 주세요.' });
  const n = Number(seats);
  if (!Number.isInteger(n) || n < p.min_seats || n > MAX_SEATS) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { seats: `좌석은 ${p.min_seats}~${MAX_SEATS}석 사이로 입력해 주세요.` });
  const unit = c.unit(p);
  const list = unit * n * c.months;
  const discount = founding ? Math.round((list * FOUNDING_OFFER.pct) / 100) : 0;
  const supply = list - discount;
  const vat = Math.round(supply * VAT_RATE);
  return { plan, cycle, cycle_label: c.label, seats: n, months: c.months, unit_price: unit, list_amount: list, discount_amount: discount,
    supply_amount: supply, vat_amount: vat, amount: supply + vat, founding: Boolean(founding), currency: 'KRW',
    goods_name: `RELAI ${p.label} ${n}석 ${c.months === 12 ? '1년' : '1개월'}` };
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

/** Seats default/minimum for a workspace: at least the plan minimum and the current member count. */
export async function minSeats(db, workspaceId, plan = 'TEAM') {
  const members = Number((await db.get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?', [workspaceId])).n);
  return Math.max(PLANS[plan].min_seats || 1, members);
}

/** Quote for a workspace (founding offer + member-count floor applied). */
export async function quoteFor(db, workspaceId, { plan = 'TEAM', cycle = 'ANNUAL', seats } = {}) {
  const floor = await minSeats(db, workspaceId, plan);
  const n = seats === undefined || seats === null || seats === '' ? floor : Number(seats);
  if (Number.isInteger(n) && n < floor) throw new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', { seats: `현재 멤버 수(${floor}명)보다 적은 좌석은 구매할 수 없습니다.` });
  return quote({ plan, cycle, seats: n, founding: await foundingEligible(db, workspaceId) });
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
export const publicOrder = (o) => o && ({ id: o.id, plan: o.plan, cycle: o.cycle, seats: o.seats, months: o.months, unit_price: o.unit_price, list_amount: o.list_amount,
  discount_amount: o.discount_amount, supply_amount: o.supply_amount, vat_amount: o.vat_amount, amount: o.amount, founding: o.founding, goods_name: o.goods_name,
  status: o.status, created_at: o.created_at, paid_at: o.paid_at });
