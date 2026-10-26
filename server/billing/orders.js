/**
 * Checkout orders and quotes (pricing v3, design.md §1/§3). The server decides what a purchase costs, stores it in billing_orders,
 * and the provider is only ever asked to charge `order.amount`. Approvals and provider notifications are applied through
 * processWebhookEvent, which re-checks the paid amount against the order — a tampered payment window amount never activates.
 *
 * Every price is VAT INCLUDED (plans.js): amount = list price; supply/VAT = splitVat(amount) for receipts.
 * Quotes (T1 contract — T3 checkout, T4 screens build on these; no ₩ is ever computed in the browser):
 *   quotePlan({ plan, cycle, extra_users, extra_projects, at })        a new full period of PRO/TEAM (+ add-ons)
 *   quoteAddon({ sub, extra_users, extra_projects, at })               more users/projects now, prorated to the current period end
 *   quoteUpgrade({ sub, plan, at })                                    PRO → TEAM now, prorated difference (add-ons carried)
 * each → { kind, plan, cycle, months, lines[{ key, label, qty, unit, days, period_days, amount }], total, supply, vat,
 *          next_renewal_amount, next_renewal_at, waived, limits_after, ... }.
 * `sub` is the subscription row with `plan` set to the EFFECTIVE plan (loadQuoteContext()). `wid` is accepted and echoed.
 * Rounding: every prorated line is rounded down (charges) — credits for a cheaper carried add-on round in the customer's favour too —
 * and a total below MIN_CARD_KRW is waived (charged 0, activated until renewal).
 */
import { randomBytes } from 'node:crypto';
import { PLANS, CYCLES, PAID_PLANS, MIN_CARD_KRW, PRICE_VERSION, planPrice, addonPrice, limitsFor, splitVat, oneTimeMode } from '../plans.js';
import { prorate } from './prorate.js';

export const MAX_USERS = 1000;
export const MAX_EXTRA_PROJECTS = 200;
export const ORDER_TTL_MINUTES = 60;   // a payment window result older than this is refused (NicePay allows 10 min to approve)

export class OrderError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
const invalid = (fields) => new OrderError(400, 'validation_error', '입력값을 확인해 주세요.', fields);
const count = (v, max, field, msg) => {
  const n = v === undefined || v === null || v === '' ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw invalid({ [field]: msg });
  return n;
};
const paidPlan = (plan) => {
  if (!PAID_PLANS.includes(plan)) throw invalid({ plan: PLANS[plan]?.contact_sales ? 'Enterprise는 도입 문의로 계약합니다.' : '선택할 수 없는 플랜입니다.' });
  return PLANS[plan];
};
const cycleOf = (cycle) => { if (!CYCLES[cycle]) throw invalid({ cycle: '결제 주기를 선택해 주세요.' }); return CYCLES[cycle]; };
const addMonths = (d, m) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x; };
const finish = (lines, extra) => {
  const raw = lines.reduce((s, l) => s + l.amount, 0);
  const sum = Math.max(0, raw);
  const waived = sum > 0 && sum < MIN_CARD_KRW && lines.some((l) => l.days !== undefined);
  const total = waived ? 0 : sum;
  const { supply, vat } = splitVat(total);
  return { ...extra, lines, total, supply, vat, waived, currency: 'KRW', vat_included: true, price_version: PRICE_VERSION };
};

/** Card amount of one renewal of `plan`/`cycle` with `extraUsers`/`extraProjects` add-ons (VAT incl.). */
export function renewalAmount(plan, cycle, extraUsers = 0, extraProjects = 0) {
  const base = planPrice(plan, cycle);
  if (base === null) return null;
  return base + (addonPrice(plan, 'user', cycle) || 0) * extraUsers + (addonPrice(plan, 'project', cycle) || 0) * extraProjects;
}

/** A new full period of a paid plan (+ add-ons). Throws OrderError on bad input. */
export function quotePlan({ wid = null, plan, cycle = 'MONTHLY', extra_users = 0, extra_projects = 0, at = new Date() } = {}) {
  const p = paidPlan(plan); const c = cycleOf(cycle);
  const eu = count(extra_users, MAX_USERS, 'extra_users', `추가 사용자는 0~${MAX_USERS}명 사이로 입력해 주세요.`);
  const ep = count(extra_projects, MAX_EXTRA_PROJECTS, 'extra_projects', `추가 프로젝트는 0~${MAX_EXTRA_PROJECTS}개 사이로 입력해 주세요.`);
  const lines = [{ key: 'plan', label: `${p.label} ${c.label}`, qty: 1, unit: planPrice(plan, cycle), amount: planPrice(plan, cycle) }];
  if (eu) lines.push({ key: 'user', label: '추가 사용자', qty: eu, unit: addonPrice(plan, 'user', cycle), amount: eu * addonPrice(plan, 'user', cycle) });
  if (ep) lines.push({ key: 'project', label: '추가 프로젝트', qty: ep, unit: addonPrice(plan, 'project', cycle), amount: ep * addonPrice(plan, 'project', cycle) });
  const q = finish(lines, { kind: 'PLAN', wid, plan, cycle, months: c.months, extra_users: eu, extra_projects: ep });
  return { ...q, next_renewal_amount: q.total, next_renewal_at: addMonths(at, c.months).toISOString(),
    limits_after: limitsFor({ plan, extra_users: eu, extra_projects: ep }) };
}

/** The subscription a prorated quote is priced against: a paid plan (effective) with a current period. */
function currentPeriod(sub) {
  if (!sub || !PAID_PLANS.includes(sub.plan) || !['ACTIVE', 'PAST_DUE'].includes(sub.status || 'ACTIVE')) throw new OrderError(409, 'no_paid_plan', 'Pro 또는 Team 플랜을 이용 중일 때만 추가 구매할 수 있습니다.');
  if (sub.price_version === 'v2') throw new OrderError(409, 'legacy_plan', '이전 요금제 이용 기간이 끝난 뒤 새 요금제로 구매할 수 있습니다.');
  const cycle = sub.billing_cycle || sub.cycle;
  if (!CYCLES[cycle] || !sub.current_period_start || !sub.current_period_end) throw new OrderError(409, 'no_period', '현재 이용 기간을 확인할 수 없습니다. 운영자에게 문의해 주세요.');
  return { cycle, start: sub.current_period_start, end: sub.current_period_end };
}
const proLine = (key, label, unit, qty, per, at) => {
  const r = prorate({ unit, qty, periodStart: per.start, periodEnd: per.end, at });
  return { key, label, qty, unit, days: r.days, period_days: r.period_days, amount: r.amount };
};

/** More users / projects on the current paid period: prorated to its end (design.md §3). */
export function quoteAddon({ wid = null, sub, extra_users = 0, extra_projects = 0, at = new Date() } = {}) {
  const per = currentPeriod(sub);
  const eu = count(extra_users, MAX_USERS, 'extra_users', `추가 사용자는 0~${MAX_USERS}명 사이로 입력해 주세요.`);
  const ep = count(extra_projects, MAX_EXTRA_PROJECTS, 'extra_projects', `추가 프로젝트는 0~${MAX_EXTRA_PROJECTS}개 사이로 입력해 주세요.`);
  if (!eu && !ep) throw invalid({ extra_users: '추가할 사용자 또는 프로젝트 수를 입력해 주세요.' });
  const lines = [];
  if (eu) lines.push(proLine('user', '추가 사용자 (남은 기간)', addonPrice(sub.plan, 'user', per.cycle), eu, per, at));
  if (ep) lines.push(proLine('project', '추가 프로젝트 (남은 기간)', addonPrice(sub.plan, 'project', per.cycle), ep, per, at));
  const nu = Number(sub.extra_users || 0) + eu; const np = Number(sub.extra_projects || 0) + ep;
  return { ...finish(lines, { kind: 'ADDON', wid, plan: sub.plan, cycle: per.cycle, add_users: eu, add_projects: ep, extra_users: nu, extra_projects: np,
    period_start: new Date(per.start).toISOString(), period_end: new Date(per.end).toISOString() }),
  next_renewal_amount: renewalAmount(sub.plan, per.cycle, nu, np), next_renewal_at: new Date(per.end).toISOString(),
  limits_after: limitsFor({ ...sub, extra_users: nu, extra_projects: np }) };
}

/**
 * Immediate upgrade (PRO → TEAM) for the rest of the current period, same cycle. Add-ons carry over: what the new plan
 * includes is dropped (Pro 3 + 2 extra projects = 5 ≤ Team 10 → 0 extra), the rest is re-priced at the new plan's add-on price.
 * A cheaper carried add-on is a negative line netted against the plan line; the total is never below 0.
 */
export function quoteUpgrade({ wid = null, sub, plan, at = new Date() } = {}) {
  const per = currentPeriod(sub);
  const from = PLANS[sub.plan]; const to = paidPlan(plan);
  if (PAID_PLANS.indexOf(plan) <= PAID_PLANS.indexOf(sub.plan)) throw new OrderError(409, 'not_upgrade', '현재보다 높은 플랜으로만 즉시 변경할 수 있습니다. 낮은 플랜으로의 변경은 다음 결제일에 적용됩니다.');
  const eu = Number(sub.extra_users || 0); const ep = Number(sub.extra_projects || 0);
  const nu = Math.max(0, from.included.users + eu - to.included.users);
  const np = Math.max(0, from.included.projects + ep - to.included.projects);
  const lines = [proLine('plan', `${from.label} → ${to.label} (남은 기간)`, planPrice(plan, per.cycle) - planPrice(sub.plan, per.cycle), 1, per, at)];
  const carry = (kind, label, oldQty, newQty) => {
    const diff = (addonPrice(plan, kind, per.cycle) || 0) * newQty - (addonPrice(sub.plan, kind, per.cycle) || 0) * oldQty;
    if (diff) lines.push({ ...proLine(kind, label, diff, 1, per, at), carried_from: oldQty, carried_to: newQty });
  };
  carry('user', '추가 사용자 이전 (남은 기간)', eu, nu);
  carry('project', '추가 프로젝트 이전 (남은 기간)', ep, np);
  return { ...finish(lines, { kind: 'UPGRADE', wid, from_plan: sub.plan, plan, cycle: per.cycle, extra_users: nu, extra_projects: np,
    credits_delta: Math.max(0, to.credits.monthly - from.credits.monthly), period_start: new Date(per.start).toISOString(), period_end: new Date(per.end).toISOString() }),
  next_renewal_amount: renewalAmount(plan, per.cycle, nu, np), next_renewal_at: new Date(per.end).toISOString(),
  limits_after: limitsFor({ ...sub, plan, extra_users: nu, extra_projects: np, seats: null }) };
}

/** Subscription row of a workspace with `plan` replaced by the effective plan, plus live usage: what quoteAddon/quoteUpgrade need. */
export async function loadQuoteContext(db, workspaceId) {
  const { effectivePlan } = await import('./subscriptions.js');
  const { countUsage } = await import('./limits.js');
  const row = await db.get('SELECT * FROM subscriptions WHERE workspace_id = ?', [workspaceId]);
  const plan = await effectivePlan(db, workspaceId);
  return { plan, sub: row ? { ...row, stored_plan: row.plan, plan } : null, usage: await countUsage(db, workspaceId) };
}

/**
 * Plan checkout quote in the order shape (createOrder): quotePlan + legacy fields (seats = users the order buys = the member limit,
 * months, unit_price = monthly equivalent, list_amount = 12 × monthly for annual, discount_amount = the annual saving).
 * `users` (total users incl. included ones; `seats` alias) is still accepted → extra_users = users − included.
 */
export function quote({ plan = 'PRO', cycle = 'MONTHLY', users, seats, extra_users, extra_projects = 0 } = {}) {
  const p = paidPlan(plan); cycleOf(cycle);
  const n = users ?? seats;
  let eu = extra_users;
  if (eu === undefined && n !== undefined && n !== null && n !== '') {
    if (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > MAX_USERS) throw invalid({ users: `사용자 수는 1~${MAX_USERS}명 사이로 입력해 주세요.` });
    eu = Math.max(0, Number(n) - p.included.users);
  }
  const q = quotePlan({ plan, cycle, extra_users: eu || 0, extra_projects });
  const monthlyList = renewalAmount(plan, 'MONTHLY', q.extra_users, q.extra_projects) * q.months;
  return { ...q, cycle_label: CYCLES[cycle].label, users: p.included.users + q.extra_users, seats: p.included.users + q.extra_users, included_users: p.included.users,
    unit_price: Math.floor(q.total / q.months), list_amount: monthlyList, discount_amount: monthlyList - q.total, cycle_discount_amount: monthlyList - q.total, founding_discount_amount: 0,
    supply_amount: q.supply, vat_amount: q.vat, amount: q.total, founding: false,
    goods_name: `RELAI ${p.label} ${q.months === 12 ? '연간' : oneTimeMode() ? '1개월 이용권' : '월간'}${q.extra_users ? ` +사용자 ${q.extra_users}` : ''}${q.extra_projects ? ` +프로젝트 ${q.extra_projects}` : ''}` };
}

/** @deprecated founding offer retired in v3. */
export async function foundingEligible() { return false; }

/** Members of a workspace that count as seats (active accounts). */
export async function minUsers(db, workspaceId, plan = 'PRO') {
  const { countUsage } = await import('./limits.js');
  return Math.max(PLANS[plan]?.included?.users || 1, (await countUsage(db, workspaceId)).members);
}

/** Plan checkout quote for a workspace: refuses a user count below the current members (would start over the limit). */
export async function quoteFor(db, workspaceId, { plan = 'PRO', cycle = 'MONTHLY', users, seats, extra_users, extra_projects } = {}) {
  const q = quote({ plan, cycle, users, seats, extra_users, extra_projects });
  const { countUsage } = await import('./limits.js');
  const u = await countUsage(db, workspaceId);
  if (u.members > q.limits_after.users) throw invalid({ users: `현재 사용자 수(${u.members}명)보다 적은 사용자 한도로는 구매할 수 없습니다. 추가 사용자를 늘려 주세요.` });
  return q;
}

/** NicePay orderId: ≤ 64 chars, unique, never reused. */
export const newOrderId = () => `RELAI${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(9).toString('hex')}`;

/**
 * Insert a PENDING order. `kind` ONE_TIME | RECURRING_FIRST | RECURRING_RENEWAL (plan periods), ADDON, UPGRADE (T3).
 * `clientKey` (optional, from the checkout request) makes a double click return the same order: UNIQUE (workspace_id, client_key).
 */
export async function createOrder(db, { workspaceId, userId, provider, kind = 'ONE_TIME', q, clientKey = null }) {
  const id = newOrderId();
  const key = clientKey ? String(clientKey).slice(0, 80) : null;
  const row = await db.get(`INSERT INTO billing_orders (id, workspace_id, user_id, provider, kind, plan, cycle, seats, months, unit_price, list_amount, discount_amount,
      supply_amount, vat_amount, amount, founding, goods_name, addon_users, addon_projects, period_start, period_end, client_key, price_version, buyer_name, buyer_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, (SELECT name FROM users WHERE id = ?), (SELECT email FROM users WHERE id = ?)) ON CONFLICT (workspace_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`,
  [id, workspaceId, userId, provider, kind, q.plan, q.cycle, q.seats ?? null, q.months ?? null, q.unit_price ?? q.total, q.list_amount ?? q.total, q.discount_amount ?? 0,
    q.supply_amount ?? q.supply, q.vat_amount ?? q.vat, q.amount ?? q.total, false, q.goods_name || goodsName(q),
    q.add_users ?? q.extra_users ?? 0, q.add_projects ?? q.extra_projects ?? 0, q.period_start || null, q.period_end || null, key, q.price_version || PRICE_VERSION, userId, userId]);
  if (row) return getOrder(db, id);
  return db.get('SELECT * FROM billing_orders WHERE workspace_id = ? AND client_key = ?', [workspaceId, key]);
}
const goodsName = (q) => `RELAI ${PLANS[q.plan]?.label || ''} ${q.kind === 'ADDON' ? '추가 구매' : q.kind === 'UPGRADE' ? '플랜 변경' : ''}`.replace(/\s+/g, ' ').trim();
export const getOrder = (db, id) => db.get('SELECT * FROM billing_orders WHERE id = ?', [String(id || '')]);
export const isExpired = (order) => Date.now() - new Date(order.created_at).getTime() > ORDER_TTL_MINUTES * 60e3;

export async function failOrder(db, id, code, message) {
  await db.run(`UPDATE billing_orders SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = now() WHERE id = ? AND status = 'PENDING'`,
    [String(code || 'failed').slice(0, 60), String(message || '').slice(0, 300), id]);
}

/**
 * The charge claim: exactly one request moves an unclaimed PENDING order to claimed and may charge or approve it. Returns the claimed
 * row, or null when another request already holds it (or the order is closed). Status stays PENDING, so webhooks, failOrder and
 * applyOrRefund are unchanged. A request that dies after the claim leaves a PENDING order that expires like any other.
 */
export const claimCharge = (db, id) => db.get(`UPDATE billing_orders SET charge_claimed_at = now(), updated_at = now() WHERE id = ? AND status = 'PENDING' AND charge_claimed_at IS NULL RETURNING *`, [id]);

/** Customer-facing order fields. */
export const publicOrder = (o) => o && ({ id: o.id, kind: o.kind, plan: o.plan, cycle: o.cycle, seats: o.seats, users: o.seats, months: o.months, unit_price: o.unit_price, list_amount: o.list_amount,
  discount_amount: o.discount_amount, supply_amount: o.supply_amount, vat_amount: o.vat_amount, amount: o.amount, founding: o.founding, goods_name: o.goods_name,
  addon_users: o.addon_users ?? 0, addon_projects: o.addon_projects ?? 0, period_start: o.period_start ?? null, period_end: o.period_end ?? null,
  status: o.status, created_at: o.created_at, paid_at: o.paid_at });
