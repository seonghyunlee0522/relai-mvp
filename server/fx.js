/**
 * USD/KRW for the Admin console (founder 2026-10-27): 한국수출입은행 현재환율 Open API, fetched once a day at 10:00 KST by Vercel Cron
 * (vercel.json `0 1 * * *` UTC → GET /api/cron/fx). Display only — AI limits are in USD and never read this table.
 *
 *   GET https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=…&searchdate=YYYYMMDD&data=AP01
 *   → [{ result: 1, cur_unit: 'USD', deal_bas_r: '1,385.5', … }]   (매매기준율; the old www.koreaexim.go.kr domain was retired)
 * Weekends, holidays and a run before the day's 고시 return an empty list: nothing is stored and the admin screen keeps showing the
 * latest stored rate with its date. KOREAEXIM_API_KEY unset → the job reports skipped. The key never leaves the request URL.
 */
import { cronAuthorized } from './cron-routes.js';

export const FX_SOURCE_URL = 'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';
const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

/** Parse the API body → KRW per 1 USD, or null when the day has no USD row (holiday / not yet published / error result). */
export function parseUsdKrw(body) {
  if (!Array.isArray(body)) return null;
  const usd = body.find((r) => String(r?.cur_unit || '').toUpperCase() === 'USD' && Number(r?.result ?? 1) === 1);
  const v = usd ? Number(String(usd.deal_bas_r || '').replace(/,/g, '')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Fetch today's (KST) USD/KRW and store it. → { status: 'stored' | 'no_rate' | 'skipped' | 'error', rate_date, krw_per_unit } */
export async function fetchDailyFx(db, { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const key = String(env.KOREAEXIM_API_KEY || '').trim();
  const date = kstDate(now);
  if (!key) return { status: 'skipped', reason: 'KOREAEXIM_API_KEY 미설정', rate_date: date };
  const url = `${FX_SOURCE_URL}?authkey=${encodeURIComponent(key)}&searchdate=${date.replace(/-/g, '')}&data=AP01`;
  let rate = null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetchImpl(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}`, rate_date: date };
    rate = parseUsdKrw(await res.json());
  } catch (e) { return { status: 'error', reason: e.name === 'AbortError' ? 'timeout' : 'network', rate_date: date }; }
  if (rate === null) return { status: 'no_rate', rate_date: date };
  await db.run(`INSERT INTO fx_rates (rate_date, currency, krw_per_unit, source, fetched_at) VALUES (?, 'USD', ?, 'KOREAEXIM', now())
    ON CONFLICT (rate_date) DO UPDATE SET krw_per_unit = EXCLUDED.krw_per_unit, fetched_at = now()`, [date, rate]);
  return { status: 'stored', rate_date: date, krw_per_unit: rate };
}

/** Latest stored rate { rate_date, krw_per_unit, fetched_at } or null. */
export async function latestFx(db) {
  const r = await db.get(`SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, krw_per_unit, fetched_at FROM fx_rates WHERE currency = 'USD' ORDER BY rate_date DESC LIMIT 1`);
  return r ? { rate_date: r.rate_date, krw_per_unit: Number(r.krw_per_unit), fetched_at: r.fetched_at } : null;
}

/** GET /api/cron/fx — Vercel Cron, Bearer CRON_SECRET. */
export function mountFxRoutes({ app, db, wrap, fail, env = process.env }) {
  app.get('/api/cron/fx', wrap(async (req, res) => {
    if (!cronAuthorized(req, res, fail, env)) return;
    res.json(await fetchDailyFx(db, { env }));
  }));
}
