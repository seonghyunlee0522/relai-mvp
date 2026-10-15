/**
 * Plan catalogue — the single source of truth for plan limits and prices (pricing v2, founder decision 2026-10-14).
 *
 * Prices are in KRW, VAT excluded (부가세 별도); the amount charged adds 10% VAT (see billing/orders.js quote()).
 *   FREE        ₩0, 1 project, 50 requirements, 100 WBS.
 *   TEAM        ₩20,000 / month per workspace, which includes the workspace owner (included_users),
 *               + ₩5,000 / month for each additional user (extra_user_monthly). No minimum.
 *               Annual prepay = 12 months at the same monthly rate, less ANNUAL_DISCOUNT_PCT (0 = no annual discount).
 *   ENTERPRISE  no list price, contact sales (not sold through checkout; set up by an operator).
 * Founding offer: the first FOUNDING_OFFER.customers paying workspaces get FOUNDING_OFFER.pct off for their first year.
 *
 * AI credits: TEAM workspaces get AI_CREDITS_MONTHLY.TEAM credits per month while the subscription is ACTIVE (billing/ai-grants.js);
 * ENTERPRISE credits are granted by an operator per contract. FREE keeps the one-time trial (ai/credits.js).
 *
 * `null` limit = unlimited. Limits are enforced by billing/limits.js. On TEAM the member limit is the purchased user count
 * (subscriptions.seats = included_users + extra users bought).
 */
/** Monthly AI credit grant per plan (0 = none). Override TEAM with env AI_TEAM_MONTHLY_CREDITS. */
const envInt = (v, d) => (Number.isInteger(Number(v)) && v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : d);
export const AI_CREDITS_MONTHLY = { FREE: 0, TEAM: envInt(process.env.AI_TEAM_MONTHLY_CREDITS, 1000), ENTERPRISE: 0 };

export const PLANS = {
  FREE: { key: 'FREE', label: 'Free', base_monthly: 0, ai_credits_monthly: AI_CREDITS_MONTHLY.FREE, limits: { projects: 1, members: 3, requirements: 50, wbs: 100, weekly_reports: 8 } },
  TEAM: { key: 'TEAM', label: 'Team', base_monthly: 20000, included_users: 1, extra_user_monthly: 5000, per_seat: true, ai_credits_monthly: AI_CREDITS_MONTHLY.TEAM,
    limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
  ENTERPRISE: { key: 'ENTERPRISE', label: 'Enterprise', per_seat: true, contact_sales: true, ai_credits_monthly: AI_CREDITS_MONTHLY.ENTERPRISE,
    limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
  // Early access (AI-credits-only billing, 2026-10-15): the whole app with TEAM limits for EARLY_ACCESS.months, no subscription row.
  // effectivePlan() answers EARLY while workspaces.early_access_until > now() and no paid subscription grants a plan.
  EARLY: { key: 'EARLY', label: '얼리 액세스', base_monthly: 0, ai_credits_monthly: 0, limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
};
export const DEFAULT_PLAN = 'FREE';
export const VAT_RATE = 0.1;
export const PRICES_EXCLUDE_VAT = true;
export const FOUNDING_OFFER = { customers: 10, pct: 40, months: 12 };
/** % off an annual prepay (12 months at the monthly rate). 0 = annual costs exactly 12 × monthly. */
export const ANNUAL_DISCOUNT_PCT = 0;
/** Billing cycles sold through checkout: months covered by one payment and the % discount on that cycle. */
export const CYCLES = {
  ANNUAL: { key: 'ANNUAL', label: '연간 선결제', months: 12, discount_pct: ANNUAL_DISCOUNT_PCT },
  MONTHLY: { key: 'MONTHLY', label: '1개월', months: 1, discount_pct: 0 },
};
/** Monthly list price (VAT excluded) of a plan for `users` total users: base + each user beyond included_users. */
export const monthlyPrice = (plan, users) => plan.base_monthly + Math.max(0, users - (plan.included_users || 0)) * (plan.extra_user_monthly || 0);

/**
 * AI credits (AI-credits-only billing). 1 credit = ₩10, VAT included; ₩ is always credits × CREDIT_PRICE_KRW and never stored.
 * Packs are prepaid through the NicePay one-time checkout (billing/credit-packs.js). No bonus credits, so a refund is linear.
 */
export const CREDIT_PRICE_KRW = 10;
export const CREDIT_PACKS = [
  { key: 'P10', amount: 10000, credits: 1000 },
  { key: 'P30', amount: 30000, credits: 3000 },
  { key: 'P100', amount: 100000, credits: 10000 },
];
/** Below this balance the page and the AI cost line turn amber and the OWNER gets one e-mail (re-armed by a purchase). */
export const LOW_BALANCE_CREDITS = envInt(process.env.AI_LOW_BALANCE_CREDITS, 200);
/** Refunds of unused purchased credits: full within REFUND_FULL_DAYS of an untouched pack, else less REFUND_FEE_PCT. */
export const REFUND_FULL_DAYS = 7;
export const REFUND_FEE_PCT = 10;
/** Purchased credits are valid this many years (terms; no expiry job in this round). */
export const PURCHASED_VALID_YEARS = 5;
/**
 * Early access: every workspace created on or before `cutoff` is free (TEAM limits) for `months` months, counted from
 * max(created_at, launch). After that it needs TEAM to keep unlimited limits, else FREE limits apply (data kept, read-only over the limit).
 */
export const EARLY_ACCESS = {
  months: 12,
  get launch() { return process.env.EARLY_ACCESS_LAUNCH || '2026-10-15T00:00:00+09:00'; },
  get cutoff() { return process.env.EARLY_ACCESS_CUTOFF || '2027-06-30T23:59:59+09:00'; },   // founder decision pending; env overrides
  notice_days: [30, 7],
};
/** Supply / VAT split of a VAT-inclusive amount (₩10,000 → 9,091 + 909). */
export const splitVat = (amount) => { const supply = Math.round(amount / (1 + VAT_RATE)); return { supply, vat: amount - supply }; };

/** Usage dimension labels in UI order. weekly_reports is counted per calendar month (see usage.js). */
export const USAGE_DIMS = [
  { key: 'projects', label: '진행 중 프로젝트' },
  { key: 'members', label: '멤버' },
  { key: 'requirements', label: '요구사항' },
  { key: 'wbs', label: 'WBS' },
  { key: 'weekly_reports', label: '주간보고 (이번 달)' },
];

export const planOf = (key) => PLANS[key] || PLANS[DEFAULT_PLAN];

/** usage % of a dimension (null when unlimited). */
export const pctOf = (used, limit) => (limit === null || limit === undefined ? null : Math.round((used / limit) * 100));
/** Highest usage % across dimensions → attention tier: 'ok' | 'warn' (≥80) | 'attention' (≥90). */
export const tierOf = (maxPct) => (maxPct === null ? 'ok' : maxPct >= 90 ? 'attention' : maxPct >= 80 ? 'warn' : 'ok');
