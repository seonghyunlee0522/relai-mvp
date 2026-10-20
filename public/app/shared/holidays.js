/* 한국 공휴일 for the client's 근무일 math (batch7 B4) — GET /api/calendar/holidays once per page load, as Map('YYYY-MM-DD' → name).
 * On failure → an empty Map (weekends still count), so a screen never waits on it. */
import { api } from '../core/api.js';

let cached = null;
export function holidays() {
  if (!cached) cached = api('GET', '/api/calendar/holidays').then((r) => new Map((r.holidays || []).map((h) => [h.day, h.name]))).catch(() => { cached = null; return new Map(); });
  return cached;
}
