/**
 * Plan catalogue — the single source of truth for plan limits and prices (approved 2026-10-14).
 *
 * Prices are per seat, in KRW, VAT excluded (부가세 별도); the amount charged adds 10% VAT (see billing/orders.js quote()).
 *   FREE        ₩0, 1 project, 50 requirements, 100 WBS.
 *   TEAM        ₩15,000 / seat / month billed annually (₩180,000 / seat / year), or ₩19,000 / seat billed monthly; minimum 3 seats.
 *   ENTERPRISE  from ₩25,000 / seat / month, contact sales (not sold through checkout; set up by an operator).
 * Founding offer: the first FOUNDING_OFFER.customers paying workspaces get FOUNDING_OFFER.pct off for their first year.
 *
 * AI credits: TEAM workspaces get AI_CREDITS_MONTHLY.TEAM credits per month while the subscription is ACTIVE (billing/ai-grants.js);
 * ENTERPRISE credits are granted by an operator per contract. FREE keeps the one-time trial (ai/credits.js).
 *
 * `null` limit = unlimited. Limits are enforced by billing/limits.js. On TEAM the member limit is the purchased seat count.
 */
/** Monthly AI credit grant per plan (0 = none). Override TEAM with env AI_TEAM_MONTHLY_CREDITS. */
const envInt = (v, d) => (Number.isInteger(Number(v)) && v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : d);
export const AI_CREDITS_MONTHLY = { FREE: 0, TEAM: envInt(process.env.AI_TEAM_MONTHLY_CREDITS, 1000), ENTERPRISE: 0 };

export const PLANS = {
  FREE: { key: 'FREE', label: 'Free', price_monthly: 0, ai_credits_monthly: AI_CREDITS_MONTHLY.FREE, limits: { projects: 1, members: 3, requirements: 50, wbs: 100, weekly_reports: 8 } },
  TEAM: { key: 'TEAM', label: 'Team', price_monthly: 19000, price_annual_monthly: 15000, min_seats: 3, per_seat: true, ai_credits_monthly: AI_CREDITS_MONTHLY.TEAM,
    limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
  ENTERPRISE: { key: 'ENTERPRISE', label: 'Enterprise', price_monthly: 25000, price_from: true, per_seat: true, contact_sales: true, ai_credits_monthly: AI_CREDITS_MONTHLY.ENTERPRISE,
    limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
};
export const DEFAULT_PLAN = 'FREE';
export const VAT_RATE = 0.1;
export const PRICES_EXCLUDE_VAT = true;
export const FOUNDING_OFFER = { customers: 10, pct: 40, months: 12 };
/** Billing cycles sold through checkout: months covered by one payment and the per-seat monthly price. */
export const CYCLES = {
  ANNUAL: { key: 'ANNUAL', label: '연간 선결제', months: 12, unit: (plan) => plan.price_annual_monthly },
  MONTHLY: { key: 'MONTHLY', label: '1개월', months: 1, unit: (plan) => plan.price_monthly },
};

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
