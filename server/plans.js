/**
 * Plan catalogue (Phase 10 groundwork, used by the Admin Console's Usage views).
 *
 * Billing is not implemented yet: there is no `subscriptions` table, so every workspace is on FREE. The limits
 * below are the operational baseline the Admin Console measures usage against; Phase 10 Billing should keep
 * this file as the single source of truth for plan limits (and add `price_monthly` when pricing is fixed).
 *
 * `null` limit = unlimited. Nothing here is enforced on the product API yet — enforcement is a Billing-phase task.
 */
export const PLANS = {
  FREE: { key: 'FREE', label: 'Free', price_monthly: null, limits: { projects: 1, members: 3, requirements: 10, wbs: 30, weekly_reports: 8 } },
  TEAM: { key: 'TEAM', label: 'Team', price_monthly: null, limits: { projects: null, members: null, requirements: null, wbs: null, weekly_reports: null } },
};
export const DEFAULT_PLAN = 'FREE';

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
