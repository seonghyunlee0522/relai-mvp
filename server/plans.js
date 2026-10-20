/**
 * Plan catalogue — the single source of truth for plan limits and prices (pricing v3, founder spec 2026-10-20,
 * hive research/relai-pricing-v3/design.md §1).
 *
 * Every price is in KRW and VAT INCLUDED (부가세 포함): the list price is the card amount. supply/VAT for receipts = splitVat(amount).
 *              월간      연간 (12개월 한 번에, 20% 할인)   활성 프로젝트   기본 사용자   AI 크레딧
 *   FREE       0         0                                 1               3            최초 200 (once, no monthly grant, no top-up)
 *   PRO        30,000    288,000 (월 환산 24,000)          3               15           매월 1,000, top-up allowed
 *   TEAM       80,000    768,000 (월 환산 64,000)          10              40           매월 3,000, top-up allowed
 *   ENTERPRISE contact sales — limits set by an operator (subscriptions.seats / project_limit), top-up per contract
 * Add-ons (per workspace, per unit):        월간     연간 (12개월분)
 *   추가 사용자 1명 (PRO, TEAM)             1,000    9,600  (월 환산 800)
 *   추가 프로젝트 1개 PRO                   10,000   96,000 (월 환산 8,000)
 *   추가 프로젝트 1개 TEAM                  8,000    76,800 (월 환산 6,400)
 * Annual = monthly × 12 × 0.8 for every plan and add-on (unit-tested). Display values (월 환산, 할인액) are derived, never typed twice.
 *
 * Limits are active projects + users only (decision D1: the old Free caps on requirements / WBS / weekly reports are gone).
 * `null` = unlimited. Enforced by billing/limits.js; limitsFor() adds purchased add-ons to the plan's included amounts.
 */
const envInt = (v, d) => (Number.isInteger(Number(v)) && v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : d);

/** Monthly AI credit grant per plan (0 = none). TEAM can be overridden with env AI_TEAM_MONTHLY_CREDITS, PRO with AI_PRO_MONTHLY_CREDITS. */
export const AI_CREDITS_MONTHLY = { FREE: 0, PRO: envInt(process.env.AI_PRO_MONTHLY_CREDITS, 1000), TEAM: envInt(process.env.AI_TEAM_MONTHLY_CREDITS, 3000), ENTERPRISE: 0 };
/** Credits a new Free workspace gets once (never again through re-signup, recovery or a plan change — ai/credits.js, T2). */
export const FREE_ONCE_CREDITS = 200;

/** Free plan limits (also the limits of retired early-access workspaces). requirements / WBS / weekly reports: unlimited (D1). */
export const FREE_LIMITS = Object.freeze({ projects: 1, members: 3, requirements: null, wbs: null, weekly_reports: null });
const UNLIMITED_CONTENT = { requirements: null, wbs: null, weekly_reports: null };

export const PRICE_VERSION = 'v3-2026-10';
export const PLANS = {
  FREE: { key: 'FREE', label: 'Free', price: { MONTHLY: 0, ANNUAL: 0 }, included: { projects: 1, users: 3 },
    credits: { once: FREE_ONCE_CREDITS, monthly: 0 }, topup: false, addons: null,
    base_monthly: 0, ai_credits_monthly: AI_CREDITS_MONTHLY.FREE, limits: FREE_LIMITS },
  PRO: { key: 'PRO', label: 'Pro', price: { MONTHLY: 30000, ANNUAL: 288000 }, included: { projects: 3, users: 15 },
    credits: { once: 0, monthly: AI_CREDITS_MONTHLY.PRO }, topup: true,
    addons: { user: { MONTHLY: 1000, ANNUAL: 9600 }, project: { MONTHLY: 10000, ANNUAL: 96000 } },
    base_monthly: 30000, ai_credits_monthly: AI_CREDITS_MONTHLY.PRO, limits: { projects: 3, members: 15, ...UNLIMITED_CONTENT } },
  TEAM: { key: 'TEAM', label: 'Team', price: { MONTHLY: 80000, ANNUAL: 768000 }, included: { projects: 10, users: 40 },
    credits: { once: 0, monthly: AI_CREDITS_MONTHLY.TEAM }, topup: true,
    addons: { user: { MONTHLY: 1000, ANNUAL: 9600 }, project: { MONTHLY: 8000, ANNUAL: 76800 } },
    base_monthly: 80000, ai_credits_monthly: AI_CREDITS_MONTHLY.TEAM, limits: { projects: 10, members: 40, ...UNLIMITED_CONTENT } },
  ENTERPRISE: { key: 'ENTERPRISE', label: 'Enterprise', price: null, included: { projects: null, users: null },
    credits: { once: 0, monthly: AI_CREDITS_MONTHLY.ENTERPRISE }, topup: 'contract', addons: null, contact_sales: true,
    ai_credits_monthly: AI_CREDITS_MONTHLY.ENTERPRISE, limits: { projects: null, members: null, ...UNLIMITED_CONTENT } },
  // Early access is retired (founder 2026-10-20): effectivePlan() never answers EARLY. The key stays so an old reference resolves, with FREE limits.
  EARLY: { key: 'EARLY', label: 'Free', price: { MONTHLY: 0, ANNUAL: 0 }, included: { projects: 1, users: 3 }, credits: { once: 0, monthly: 0 }, topup: false, addons: null,
    base_monthly: 0, ai_credits_monthly: 0, limits: FREE_LIMITS },
};
/** Plans sold through checkout (self-serve). */
export const PAID_PLANS = ['PRO', 'TEAM'];
/** Plans shown on pricing screens, in order. */
export const PLAN_ORDER = ['FREE', 'PRO', 'TEAM', 'ENTERPRISE'];
export const DEFAULT_PLAN = 'FREE';
export const VAT_RATE = 0.1;
export const PRICES_INCLUDE_VAT = true;
/** @deprecated pricing v2 (VAT excluded). Kept false so an old reader never adds VAT on top. */
export const PRICES_EXCLUDE_VAT = false;
/** @deprecated pricing v2 founding offer — retired in v3 (no discount is ever applied). */
export const FOUNDING_OFFER = { customers: 0, pct: 0, months: 0 };
export const ANNUAL_DISCOUNT_PCT = 20;
/** Billing cycles: months covered by one payment and the % off against 12 monthly payments. */
export const CYCLES = {
  MONTHLY: { key: 'MONTHLY', label: '월간', months: 1, discount_pct: 0 },
  ANNUAL: { key: 'ANNUAL', label: '연간', months: 12, discount_pct: ANNUAL_DISCOUNT_PCT },
};
export const ADDON_KINDS = ['user', 'project'];

/** Card amount (VAT incl.) of one `cycle` of `plan`: FREE → 0, ENTERPRISE / unknown → null. */
export function planPrice(plan, cycle) {
  const p = PLANS[plan];
  if (!p || !p.price || !CYCLES[cycle]) return null;
  return p.price[cycle];
}
/** Card amount (VAT incl.) of ONE add-on unit (`kind` 'user' | 'project') for one full `cycle`; null when the plan sells no add-ons. */
export function addonPrice(plan, kind, cycle) {
  const a = PLANS[plan]?.addons?.[kind];
  return a && CYCLES[cycle] ? a[cycle] : null;
}
/** Annual monthly-equivalent and discount, derived (24,000 / 72,000 for PRO). */
export const annualView = (monthly, annual) => ({ monthly_equivalent: Math.floor(annual / 12), discount: monthly * 12 - annual, discount_pct: ANNUAL_DISCOUNT_PCT });

const nonNeg = (v) => Math.max(0, Number(v) || 0);
/**
 * Limits of a workspace → { projects, users } (null = unlimited).
 * `sub` = { plan, extra_users?, extra_projects?, seats?, project_limit?, price_version? } where `plan` must be the EFFECTIVE plan
 * (subscriptions.effectivePlan), not the stored one: an expired PRO row passed with plan 'FREE' gets FREE limits and no add-ons.
 *   FREE / EARLY / null  → FREE included
 *   PRO / TEAM           → included + purchased add-ons (seats, when larger, is honoured: users bought on the plan checkout)
 *   ENTERPRISE           → operator-set seats / project_limit (null = unlimited)
 *   legacy v2 TEAM rows  (price_version 'v2', paid before v3) keep what they bought until their period ends: projects unlimited, users = seats.
 */
export function limitsFor(sub) {
  const key = sub?.plan && PLANS[sub.plan] ? sub.plan : DEFAULT_PLAN;
  if (key === 'FREE' || key === 'EARLY') return { projects: PLANS.FREE.included.projects, users: PLANS.FREE.included.users };
  if (key === 'ENTERPRISE') return { projects: sub.project_limit ? Number(sub.project_limit) : null, users: sub.seats ? Number(sub.seats) : null };
  if (sub.price_version === 'v2') return { projects: null, users: sub.seats ? Number(sub.seats) : null };
  const inc = PLANS[key].included;
  const users = inc.users + nonNeg(sub.extra_users);
  return { projects: inc.projects + nonNeg(sub.extra_projects), users: Math.max(users, nonNeg(sub.seats)) };
}

/**
 * AI credits. 1 credit = ₩10, VAT included. Top-ups are any multiple of TOPUP_STEP_KRW between TOPUP_STEP_KRW and TOPUP_MAX_KRW (T2).
 * CREDIT_PACKS: the v2 fixed packs, kept until the top-up screen moves to amounts (T2).
 */
export const CREDIT_PRICE_KRW = 10;
export const TOPUP_STEP_KRW = 10000;
export const TOPUP_MAX_KRW = 500000;
export const CREDIT_PACKS = [
  { key: 'P10', amount: 10000, credits: 1000 },
  { key: 'P30', amount: 30000, credits: 3000 },
  { key: 'P100', amount: 100000, credits: 10000 },
];
/** Below this balance the page and the AI cost line turn amber and the OWNER gets one e-mail (re-armed by a purchase). */
export const LOW_BALANCE_CREDITS = envInt(process.env.AI_LOW_BALANCE_CREDITS, 200);
/** Refunds of unused purchased credits: in full, no fee (v3). The old v2 rule (CREDIT_REFUND_RULE=v2): full within REFUND_FULL_DAYS of an untouched pack, else less REFUND_FEE_PCT. */
export const REFUND_FULL_DAYS = 7;
export const REFUND_FEE_PCT = 10;
/** Purchased credits are valid this many years (terms; no expiry job in this round). */
export const PURCHASED_VALID_YEARS = 5;
/** Prorated charges below this are waived until renewal (card minimum unverified; env MIN_CARD_KRW). */
export const MIN_CARD_KRW = envInt(process.env.MIN_CARD_KRW, 100);
/**
 * Early access (retired): kept for the history columns and the notices job. effectivePlan() never grants a plan from it.
 */
export const EARLY_ACCESS = {
  months: 12,
  get launch() { return process.env.EARLY_ACCESS_LAUNCH || '2026-10-15T00:00:00+09:00'; },
  get cutoff() { return process.env.EARLY_ACCESS_CUTOFF || '2027-06-30T23:59:59+09:00'; },
  notice_days: [30, 7],
};
/** Supply / VAT split of a VAT-inclusive amount (₩30,000 → 27,273 + 2,727). */
export const splitVat = (amount) => { const supply = Math.round(amount / (1 + VAT_RATE)); return { supply, vat: amount - supply }; };

/** @deprecated v2 per-seat monthly price; v3 = plan monthly + extra users × add-on (used by the admin MRR until T4 rewrites it). */
export const monthlyPrice = (plan, users) => (plan?.price ? plan.price.MONTHLY + Math.max(0, (Number(users) || 0) - (plan.included?.users || 0)) * (plan.addons?.user?.MONTHLY || 0) : 0);

/** Where every plan-limit / credit upsell points (subscription page, batch7 T5). */
export const PLANS_URL = '/app/billing/plans';

/** Usage dimension labels in UI order (v3: active projects and users only — D1). */
export const USAGE_DIMS = [
  { key: 'projects', label: '활성 프로젝트' },
  { key: 'members', label: '사용자' },
];

export const planOf = (key) => PLANS[key] || PLANS[DEFAULT_PLAN];

/** Public catalogue for screens and GET …/billing (derived values included, nothing typed twice). */
export function catalogue() {
  return {
    price_version: PRICE_VERSION, vat_included: true, annual_discount_pct: ANNUAL_DISCOUNT_PCT, credit_price_krw: CREDIT_PRICE_KRW,
    topup: { step: TOPUP_STEP_KRW, max: TOPUP_MAX_KRW },
    cycles: Object.values(CYCLES).map((c) => ({ key: c.key, label: c.label, months: c.months, discount_pct: c.discount_pct })),
    plans: PLAN_ORDER.map((k) => {
      const p = PLANS[k];
      const price = p.price ? { MONTHLY: p.price.MONTHLY, ANNUAL: p.price.ANNUAL, ...annualView(p.price.MONTHLY, p.price.ANNUAL) } : null;
      const addons = p.addons ? Object.fromEntries(ADDON_KINDS.map((kind) => [kind, { ...p.addons[kind], monthly_equivalent: Math.floor(p.addons[kind].ANNUAL / 12) }])) : null;
      return { key: p.key, label: p.label, contact_sales: Boolean(p.contact_sales), price, included: p.included, credits: p.credits, topup: p.topup, addons };
    }),
  };
}

/** usage % of a dimension (null when unlimited). */
export const pctOf = (used, limit) => (limit === null || limit === undefined ? null : Math.round((used / limit) * 100));
/** Highest usage % across dimensions → attention tier: 'ok' | 'warn' (≥80) | 'attention' (≥90). */
export const tierOf = (maxPct) => (maxPct === null ? 'ok' : maxPct >= 90 ? 'attention' : maxPct >= 80 ? 'warn' : 'ok');
