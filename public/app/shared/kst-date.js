/* Dates in Korea time (Phase 4 C1): '오늘' and '이번 주(월~일)' are Asia/Seoul, never the server's UTC or the browser's zone.
 * Shared by the server (WBS delay reason, WEEKLY_REPORT week, approval date check) and the client (dialogs, period defaults). */
export const TZ = 'Asia/Seoul';

/** 'YYYY-MM-DD' of `at` (default now) in Korea time. */
export const todayKst = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export const addDays = (ymd, n) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** b − a in whole days ('YYYY-MM-DD' strings). */
export const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** This week Monday–Sunday in Korea time: { start, end }. */
export function weekKst(at = new Date()) {
  const today = todayKst(at);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();   // 0 Sun … 6 Sat
  const start = addDays(today, dow === 0 ? -6 : 1 - dow);
  return { start, end: addDays(start, 6) };
}

/** 'M/D' (no leading zeros) for compact lines: "계획 5/14 → 5/21 (+7일)". */
export const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : '-');

/**
 * Phase 4 US-1 — does moving a task's end date from `before` to `after` need a delay reason?
 * Only when it moves LATER, and the task has started (status ≠ 미시작) or was already late (before < today, Korea time).
 * Pulling a date earlier, a first date, and re-planning a not-started future task never ask.
 */
export function needsDelayReason(before, after, today = todayKst(), status = 'NOT_STARTED') {
  if (!before || !after || after <= before) return false;
  return status !== 'NOT_STARTED' || before < today;
}

/** "계획 5/14 → 5/21 (+7일)" from the original (frozen at 04 entry) and current end dates; '' when they match or one is missing. */
export function planShiftText(original, current) {
  if (!original || !current || original === current) return '';
  const d = diffDays(original, current);
  return `계획 ${md(original)} → ${md(current)} (${d > 0 ? '+' : ''}${d}일)`;
}

/* ---------- 근무일 (batch7 B4): 토·일·공휴일을 뺀 날. `hol` = Set/Map of 'YYYY-MM-DD' (server/calendar/holidays-kr.js · GET /api/calendar/holidays) ---------- */
/** Day of week of 'YYYY-MM-DD' (0 Sun … 6 Sat), zone-free. */
export const dow = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
export const isWorkday = (ymd, hol = null) => { const d = dow(ymd); return d !== 0 && d !== 6 && !(hol && hol.has(ymd)); };
/** Workdays from s to e, both ends included (0 when e < s or a date is missing). */
export function workdaysBetween(s, e, hol = null) {
  if (!s || !e || e < s) return 0;
  let n = 0; for (let d = s; d <= e; d = addDays(d, 1)) if (isWorkday(d, hol)) n++;
  return n;
}
/** `d` itself when it is a workday, else the next (dir 1) or previous (dir -1) workday. */
export function snapToWorkday(d, dir = 1, hol = null) { let x = d; let g = 0; while (!isWorkday(x, hol) && g++ < 60) x = addDays(x, dir < 0 ? -1 : 1); return x; }
/** The workday `n` workdays after `d` (n = 0 → `d` snapped forward; negative n walks back). */
export function addWorkdays(d, n, hol = null) {
  let x = snapToWorkday(d, n < 0 ? -1 : 1, hol); let left = Math.abs(n); const step = n < 0 ? -1 : 1;
  while (left > 0) { x = addDays(x, step); if (isWorkday(x, hol)) left--; }
  return x;
}
/** Every workday from s to e (inclusive), in order. */
export function workdayList(s, e, hol = null) { const out = []; if (!s || !e) return out; for (let d = s; d <= e; d = addDays(d, 1)) if (isWorkday(d, hol)) out.push(d); return out; }
