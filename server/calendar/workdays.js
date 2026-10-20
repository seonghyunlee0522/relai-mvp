/**
 * 근무일 달력 (batch7 B4): 토·일과 한국 공휴일을 뺀 날. The date logic lives in public/app/shared/kst-date.js (the client uses the same
 * functions); this module supplies the holiday table — public_holidays (seeded by schema.sql) with HOLIDAYS_KR as the fallback.
 *   holidayMap(db, from?, to?) → Map('YYYY-MM-DD' → name)
 *   isWorkday / workdaysBetween / addWorkdays / snapToWorkday with that map
 */
import { HOLIDAYS_KR } from './holidays-kr.js';
import { isWorkday as isW, workdaysBetween as wb, addWorkdays as aw, snapToWorkday as sw, workdayList as wl } from '../../public/app/shared/kst-date.js';

export const FALLBACK = new Map(HOLIDAYS_KR);
/** Holidays between from and to (inclusive, both optional) from the DB; the constant list when the table is empty or missing. */
export async function holidayMap(db, from = null, to = null) {
  try {
    const rows = await db.all(`SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM public_holidays WHERE (?::date IS NULL OR day >= ?::date) AND (?::date IS NULL OR day <= ?::date) ORDER BY day`, [from, from, to, to]);
    if (rows.length || (await db.get('SELECT 1 FROM public_holidays LIMIT 1'))) return new Map(rows.map((r) => [r.day, r.name]));
  } catch { /* table not there yet (older schema) → constants */ }
  return new Map(HOLIDAYS_KR.filter(([d]) => (!from || d >= from) && (!to || d <= to)));
}
export const isWorkday = (d, hol = FALLBACK) => isW(d, hol);
export const workdaysBetween = (s, e, hol = FALLBACK) => wb(s, e, hol);
export const addWorkdays = (d, n, hol = FALLBACK) => aw(d, n, hol);
export const snapToWorkday = (d, dir = 1, hol = FALLBACK) => sw(d, dir, hol);
export const workdayList = (s, e, hol = FALLBACK) => wl(s, e, hol);
