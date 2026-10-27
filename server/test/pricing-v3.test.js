/* Pricing v3 T1 — pure contracts: catalogue, VAT-inclusive prices, 20% annual, proration worked examples (design.md §3), rounding. */
import { test } from 'node:test';
process.env.ONE_TIME_PLANS_ENABLED ??= 'true';   // the retired one-time plan checkout (paid plans = 정기결제 only since 2026-10-20) is still exercised here
import assert from 'node:assert/strict';
import { PLANS, CYCLES, PAID_PLANS, planPrice, addonPrice, limitsFor, splitVat, catalogue, FREE_LIMITS, USAGE_DIMS } from '../plans.js';
import { prorate, roundKrw, ratio, kstDaysBetween } from '../billing/prorate.js';
import { quotePlan, quoteAddon, quoteUpgrade, quote, renewalAmount, OrderError } from '../billing/orders.js';

test('catalogue: list prices are the card amounts (VAT included) for FREE / PRO / TEAM, ENTERPRISE is contact-sales', () => {
  assert.deepEqual([planPrice('FREE', 'MONTHLY'), planPrice('FREE', 'ANNUAL')], [0, 0]);
  assert.deepEqual([planPrice('PRO', 'MONTHLY'), planPrice('PRO', 'ANNUAL')], [30000, 288000]);
  assert.deepEqual([planPrice('TEAM', 'MONTHLY'), planPrice('TEAM', 'ANNUAL')], [80000, 768000]);
  assert.equal(planPrice('ENTERPRISE', 'MONTHLY'), null);
  assert.equal(planPrice('PRO', 'WEEKLY'), null);
  assert.equal(PLANS.ENTERPRISE.contact_sales, true);
  assert.deepEqual(PAID_PLANS, ['PRO', 'TEAM']);
  assert.deepEqual([addonPrice('PRO', 'user', 'MONTHLY'), addonPrice('PRO', 'project', 'MONTHLY'), addonPrice('TEAM', 'project', 'MONTHLY')], [1000, 10000, 8000]);
  assert.deepEqual([addonPrice('PRO', 'user', 'ANNUAL'), addonPrice('PRO', 'project', 'ANNUAL'), addonPrice('TEAM', 'project', 'ANNUAL')], [9600, 96000, 76800]);
  assert.equal(addonPrice('FREE', 'user', 'MONTHLY'), null);
  assert.deepEqual([PLANS.FREE.included, PLANS.PRO.included, PLANS.TEAM.included], [{ projects: 1, users: 3 }, { projects: 3, users: 15 }, { projects: 10, users: 40 }]);
  // AI (2026-10-27): credits retired — an allowance per plan, shown as "AI 이용량 포함"; the USD limits are internal (aiLimitUsd)
  assert.deepEqual([PLANS.FREE.ai.allowance, PLANS.PRO.ai.allowance, PLANS.TEAM.ai.allowance, PLANS.ENTERPRISE.ai.allowance], ['ONCE', 'MONTHLY', 'MONTHLY', 'CONTRACT']);
  assert.ok(Object.values(PLANS).every((p) => p.credits === undefined && p.topup === undefined));
  assert.deepEqual([CYCLES.MONTHLY.months, CYCLES.ANNUAL.months], [1, 12]);
});

test('annual = monthly × 12 × 0.8 for every plan and add-on; monthly equivalent 24,000 / 64,000 / 800 / 8,000 / 6,400', () => {
  for (const k of PAID_PLANS) {
    assert.equal(planPrice(k, 'ANNUAL'), planPrice(k, 'MONTHLY') * 12 * 0.8, k);
    for (const kind of ['user', 'project']) assert.equal(addonPrice(k, kind, 'ANNUAL'), addonPrice(k, kind, 'MONTHLY') * 12 * 0.8, `${k} ${kind}`);
  }
  const c = catalogue();
  const pro = c.plans.find((p) => p.key === 'PRO'); const team = c.plans.find((p) => p.key === 'TEAM');
  assert.deepEqual([pro.price.monthly_equivalent, pro.price.discount, team.price.monthly_equivalent, team.price.discount], [24000, 72000, 64000, 192000]);
  assert.deepEqual([pro.addons.user.monthly_equivalent, pro.addons.project.monthly_equivalent, team.addons.project.monthly_equivalent], [800, 8000, 6400]);
  assert.deepEqual(c.plans.map((p) => p.key), ['FREE', 'PRO', 'TEAM', 'ENTERPRISE']);
  assert.equal(c.vat_included, true);
});

test('VAT included: amount = list price; supply + vat = amount (30,000 = 27,273 + 2,727)', () => {
  assert.deepEqual(splitVat(30000), { supply: 27273, vat: 2727 });
  for (const [plan, cycle] of [['PRO', 'MONTHLY'], ['PRO', 'ANNUAL'], ['TEAM', 'MONTHLY'], ['TEAM', 'ANNUAL']]) {
    const q = quotePlan({ plan, cycle });
    assert.equal(q.total, planPrice(plan, cycle));
    assert.equal(q.supply + q.vat, q.total);
    assert.equal(q.next_renewal_amount, q.total);
  }
  const q = quotePlan({ plan: 'PRO', cycle: 'MONTHLY', extra_users: 2, extra_projects: 1 });
  assert.equal(q.total, 30000 + 2000 + 10000);
  assert.deepEqual(q.lines.map((l) => [l.key, l.qty, l.unit, l.amount]), [['plan', 1, 30000, 30000], ['user', 2, 1000, 2000], ['project', 1, 10000, 10000]]);
  assert.deepEqual(q.limits_after, { projects: 4, users: 17 });
  const a = quotePlan({ plan: 'TEAM', cycle: 'ANNUAL', extra_projects: 1 });
  assert.equal(a.total, 844800);
  // the legacy order shape the checkout stores
  const o = quote({ plan: 'PRO', cycle: 'ANNUAL' });
  assert.deepEqual([o.amount, o.supply_amount + o.vat_amount, o.months, o.seats, o.unit_price, o.list_amount, o.discount_amount], [288000, 288000, 12, 15, 24000, 360000, 72000]);
  assert.throws(() => quotePlan({ plan: 'ENTERPRISE', cycle: 'MONTHLY' }), OrderError);
  assert.throws(() => quotePlan({ plan: 'FREE', cycle: 'MONTHLY' }), OrderError);
  assert.throws(() => quotePlan({ plan: 'PRO', cycle: 'WEEKLY' }), OrderError);
  assert.throws(() => quotePlan({ plan: 'PRO', cycle: 'MONTHLY', extra_users: -1 }), OrderError);
  assert.throws(() => quotePlan({ plan: 'PRO', cycle: 'MONTHLY', extra_users: 1.5 }), OrderError);
});

test('rounding: charges round down, refunds round up; integer ratio is exact', () => {
  assert.equal(roundKrw(774.19, 'down'), 774);
  assert.equal(roundKrw(774.19, 'up'), 775);
  assert.equal(roundKrw(774, 'up'), 774);
  assert.equal(roundKrw(774.0000000001, 'up'), 774);   // binary noise is not a won
  assert.equal(roundKrw(19354.8), 19354);
  assert.throws(() => roundKrw(1, 'nearest'));
  assert.equal(ratio(2 * 1000 * 12, 31, 'down'), 774);
  assert.equal(ratio(2 * 1000 * 12, 31, 'up'), 775);
  assert.equal(ratio(62000, 31, 'up'), 2000);
  assert.equal(ratio(-2 * 1000 * 12, 31, 'down'), -775);   // a credit rounds in the customer's favour
});

test('proration worked examples (design.md §3)', () => {
  const m = { periodStart: '2026-10-01T00:00:00+09:00', periodEnd: '2026-11-01T00:00:00+09:00', at: '2026-10-20T15:30:00+09:00' };
  assert.deepEqual(prorate({ unit: 1000, qty: 2, ...m }), { amount: 774, days: 12, period_days: 31 });
  const y = { periodStart: '2026-01-15T00:00:00+09:00', periodEnd: '2027-01-15T00:00:00+09:00', at: '2026-07-20T09:00:00+09:00' };
  assert.deepEqual(prorate({ unit: 76800, qty: 1, ...y }), { amount: 37663, days: 179, period_days: 365 });
  assert.equal(prorate({ unit: 9600, qty: 1, ...y }).amount, 4707);
  assert.equal(prorate({ unit: 80000 - 30000, ...m }).amount, 19354);
  assert.equal(prorate({ unit: 768000 - 288000, ...y }).amount, 235397);
  // purchase day counts, end day does not; KST dates (23:30 UTC on 10/19 is already 10/20 in Korea)
  assert.equal(prorate({ unit: 1000, ...m, at: '2026-10-19T15:30:00Z' }).days, 12);
  assert.equal(prorate({ unit: 1000, ...m, at: '2026-10-31T23:59:00+09:00' }).days, 1);
  assert.equal(prorate({ unit: 1000, ...m, at: '2026-11-01T00:00:00+09:00' }).amount, 0);
  assert.deepEqual(prorate({ unit: 1000, ...m, at: '2026-09-01T00:00:00+09:00' }), { amount: 1000, days: 31, period_days: 31 });   // before the period → full
  assert.equal(kstDaysBetween('2028-01-01T00:00:00+09:00', '2029-01-01T00:00:00+09:00'), 366);
  assert.throws(() => prorate({ unit: 1000, periodStart: m.periodEnd, periodEnd: m.periodStart }), RangeError);
});

const proMonthly = { plan: 'PRO', status: 'ACTIVE', billing_cycle: 'MONTHLY', current_period_start: '2026-10-01T00:00:00+09:00', current_period_end: '2026-11-01T00:00:00+09:00', extra_users: 0, extra_projects: 0 };
const teamAnnual = { plan: 'TEAM', status: 'ACTIVE', billing_cycle: 'ANNUAL', current_period_start: '2026-01-15T00:00:00+09:00', current_period_end: '2027-01-15T00:00:00+09:00', extra_users: 0, extra_projects: 0 };

test('quoteAddon: Pro monthly +2 users = 774원 now, 32,000원 next renewal; Team annual +1 project = 37,663원, renewal 844,800원', () => {
  const a = quoteAddon({ wid: 'w1', sub: proMonthly, extra_users: 2, at: '2026-10-20T10:00:00+09:00' });
  assert.equal(a.total, 774); assert.equal(a.next_renewal_amount, 32000); assert.equal(a.next_renewal_at, new Date(proMonthly.current_period_end).toISOString());
  assert.deepEqual(a.lines.map((l) => [l.key, l.qty, l.unit, l.days, l.period_days, l.amount]), [['user', 2, 1000, 12, 31, 774]]);
  assert.equal(a.supply + a.vat, 774); assert.equal(a.kind, 'ADDON'); assert.equal(a.wid, 'w1');
  assert.deepEqual(a.limits_after, { projects: 3, users: 17 });
  const b = quoteAddon({ sub: teamAnnual, extra_projects: 1, at: '2026-07-20T10:00:00+09:00' });
  assert.equal(b.total, 37663); assert.equal(b.next_renewal_amount, 844800);
  const c = quoteAddon({ sub: { ...teamAnnual, plan: 'PRO' }, extra_users: 1, at: '2026-07-20T10:00:00+09:00' });
  assert.equal(c.total, 4707);
  // under the card minimum → waived (activated free until renewal), renewal still includes it
  const w = quoteAddon({ sub: proMonthly, extra_users: 1, at: '2026-10-31T10:00:00+09:00' });
  assert.deepEqual([w.lines[0].amount, w.total, w.waived, w.next_renewal_amount], [32, 0, true, 31000]);
  // existing add-ons add up in the renewal
  assert.equal(quoteAddon({ sub: { ...proMonthly, extra_users: 3 }, extra_users: 2, at: '2026-10-20T10:00:00+09:00' }).next_renewal_amount, 35000);
  assert.throws(() => quoteAddon({ sub: proMonthly, at: '2026-10-20' }), OrderError);   // nothing to add
  assert.throws(() => quoteAddon({ sub: { ...proMonthly, plan: 'FREE' }, extra_users: 1 }), (e) => e.code === 'no_paid_plan');
  assert.throws(() => quoteAddon({ sub: null, extra_users: 1 }), (e) => e.code === 'no_paid_plan');
  assert.throws(() => quoteAddon({ sub: { ...proMonthly, price_version: 'v2' }, extra_users: 1 }), (e) => e.code === 'legacy_plan');
});

test('quoteUpgrade: Pro→Team monthly 19,354원, annual 235,397원; add-ons carried and netted', () => {
  const m = quoteUpgrade({ sub: proMonthly, plan: 'TEAM', at: '2026-10-20T10:00:00+09:00' });
  assert.deepEqual([m.total, m.next_renewal_amount, m.from_plan, m.plan, m.cycle], [19354, 80000, 'PRO', 'TEAM', 'MONTHLY']); assert.equal(m.credits_delta, undefined);
  const y = quoteUpgrade({ sub: { ...proMonthly, billing_cycle: 'ANNUAL', current_period_start: teamAnnual.current_period_start, current_period_end: teamAnnual.current_period_end }, plan: 'TEAM', at: '2026-07-20T10:00:00+09:00' });
  assert.equal(y.total, 235397); assert.equal(y.next_renewal_amount, 768000);
  // Pro +2 projects (5 ≤ Team 10 included) → dropped: credit line for the Pro add-on, renewal is plain Team
  const c = quoteUpgrade({ sub: { ...proMonthly, extra_projects: 2 }, plan: 'TEAM', at: '2026-10-20T10:00:00+09:00' });
  const credit = c.lines.find((l) => l.key === 'project');
  assert.deepEqual([credit.carried_from, credit.carried_to, credit.amount], [2, 0, -7742]);   // −20,000 × 12/31 = −7,741.9 → −7,742 (customer-favourable)
  assert.equal(c.total, 19354 - 7742); assert.equal(c.extra_projects, 0); assert.equal(c.next_renewal_amount, 80000);
  // Pro +30 users (45 > Team 40) → 5 extra users carried at the same unit price
  const u = quoteUpgrade({ sub: { ...proMonthly, extra_users: 30 }, plan: 'TEAM', at: '2026-10-20T10:00:00+09:00' });
  assert.equal(u.extra_users, 5); assert.equal(u.next_renewal_amount, 85000); assert.deepEqual(u.limits_after, { projects: 10, users: 45 });
  // the total never goes below 0
  const big = quoteUpgrade({ sub: { ...proMonthly, extra_projects: 7 }, plan: 'TEAM', at: '2026-10-20T10:00:00+09:00' });
  assert.ok(big.total >= 0);
  assert.throws(() => quoteUpgrade({ sub: { ...proMonthly, plan: 'TEAM' }, plan: 'PRO' }), (e) => e.code === 'not_upgrade');
  assert.throws(() => quoteUpgrade({ sub: proMonthly, plan: 'ENTERPRISE' }), OrderError);
});

test('renewalAmount and limitsFor: included + add-ons; ENTERPRISE operator-set; legacy v2 TEAM keeps seats; expired plan → FREE', () => {
  assert.equal(renewalAmount('PRO', 'MONTHLY', 2, 0), 32000);
  assert.equal(renewalAmount('TEAM', 'ANNUAL', 0, 1), 844800);
  assert.equal(renewalAmount('ENTERPRISE', 'MONTHLY'), null);
  assert.deepEqual(limitsFor(null), { projects: 1, users: 3 });
  assert.deepEqual(limitsFor({ plan: 'FREE', extra_users: 5 }), { projects: 1, users: 3 });   // add-ons never apply on FREE
  assert.deepEqual(limitsFor({ plan: 'EARLY' }), { projects: 1, users: 3 });
  assert.deepEqual(limitsFor({ plan: 'PRO' }), { projects: 3, users: 15 });
  assert.deepEqual(limitsFor({ plan: 'TEAM', extra_users: 2, extra_projects: 1 }), { projects: 11, users: 42 });
  assert.deepEqual(limitsFor({ plan: 'PRO', seats: 20 }), { projects: 3, users: 20 });
  assert.deepEqual(limitsFor({ plan: 'ENTERPRISE' }), { projects: null, users: null });
  assert.deepEqual(limitsFor({ plan: 'ENTERPRISE', seats: 120, project_limit: 50 }), { projects: 50, users: 120 });
  assert.deepEqual(limitsFor({ plan: 'TEAM', price_version: 'v2', seats: 4 }), { projects: null, users: 4 });
  assert.deepEqual([FREE_LIMITS.projects, FREE_LIMITS.members, FREE_LIMITS.requirements, FREE_LIMITS.wbs, FREE_LIMITS.weekly_reports], [1, 3, null, null, null]);   // D1
  assert.deepEqual(USAGE_DIMS.map((d) => d.key), ['projects', 'members']);
});
