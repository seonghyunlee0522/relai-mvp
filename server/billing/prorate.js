/**
 * Proration and won rounding (pricing v3, design.md §3). Pure functions — no DB, no clock unless `at` is omitted.
 *
 *   remaining_days = KST date of `at` → KST date of periodEnd     (the purchase day counts, the end day does not)
 *   period_days    = KST date of periodStart → KST date of periodEnd   (28–31 monthly, 365/366 annual)
 *   amount         = floor(unit × qty × remaining_days / period_days)   — integer arithmetic, rounded once at the end
 * Rounding rule (customer-favourable, legal-review §8): amounts CHARGED are rounded down to the won (roundKrw 'down'),
 * amounts REFUNDED are rounded up (roundKrw 'up'). A refund is never more than what was paid (callers cap it).
 */
const DAY_MS = 86400000;
const KST_MS = 9 * 3600000;

/** Days since the epoch of the KST calendar date of `t` (Date | ISO string | ms). */
export function kstDay(t) {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new TypeError('invalid date');
  return Math.floor((ms + KST_MS) / DAY_MS);
}
/** KST calendar days from `a` to `b` (b − a; negative when b is earlier). */
export const kstDaysBetween = (a, b) => kstDay(b) - kstDay(a);

/**
 * Round a won amount to an integer: 'down' (charges, default) floors, 'up' (refunds) ceils.
 * A tiny epsilon absorbs binary noise (774.0000000001 → 774 either way); pass exact fractions via ratio() when possible.
 */
export function roundKrw(x, dir = 'down') {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new TypeError('amount must be a finite number');
  if (dir !== 'down' && dir !== 'up') throw new TypeError("dir must be 'down' or 'up'");
  const r = Math.round(n);
  if (Math.abs(n - r) < 1e-9) return r;
  return dir === 'up' ? Math.ceil(n) : Math.floor(n);
}

/** Exact integer division of non-negative integers num / den, rounded 'down' or 'up'. */
export function ratio(num, den, dir = 'down') {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) throw new TypeError('ratio needs safe integers and a positive denominator');
  const neg = num < 0; const a = Math.abs(num);
  const q = (a - (a % den)) / den; const rem = a % den;
  // For a negative numerator 'down' (towards −∞) moves away from zero.
  if (!neg) return rem && dir === 'up' ? q + 1 : q;
  return -(rem && dir === 'down' ? q + 1 : q);
}

/**
 * Prorated amount of `qty` units priced `unit` per full period, for the part of [periodStart, periodEnd) left at `at`.
 * `dir` 'down' for a charge (default), 'up' for a refund/credit. Returns { amount, days, period_days }.
 * `at` before the period → the full period; at/after the end → 0 days.
 */
export function prorate({ unit, qty = 1, periodStart, periodEnd, at = new Date(), dir = 'down' }) {
  const u = Number(unit); const q = Number(qty);
  if (!Number.isSafeInteger(u) || !Number.isSafeInteger(q)) throw new TypeError('unit and qty must be integers');
  const periodDays = kstDaysBetween(periodStart, periodEnd);
  if (periodDays <= 0) throw new RangeError('period must end after it starts');
  const days = Math.min(periodDays, Math.max(0, kstDaysBetween(at, periodEnd)));
  return { amount: ratio(u * q * days, periodDays, dir), days, period_days: periodDays };
}
