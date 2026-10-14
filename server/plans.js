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

/** Usage dimension labels in UI order. weekly_reports is counted per calendar month (see usage.js). */
export const USAGE_DIMS = [
  { key: 'projects', label: 'Active Projects' },
  { key: 'members', label: 'Members' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'wbs', label: 'WBS' },
  { key: 'weekly_reports', label: 'Weekly Reports (이번 달)' },
];

export const planOf = (key) => PLANS[key] || PLANS[DEFAULT_PLAN];

/** usage % of a dimension (null when unlimited). */
export const pctOf = (used, limit) => (limit === null || limit === undefined ? null : Math.round((used / limit) * 100));
/** Highest usage % across dimensions → attention tier: 'ok' | 'warn' (≥80) | 'attention' (≥90). */
export const tierOf = (maxPct) => (maxPct === null ? 'ok' : maxPct >= 90 ? 'attention' : maxPct >= 80 ? 'warn' : 'ok');
