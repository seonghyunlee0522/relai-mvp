/**
 * Housekeeping for auth tables. Runs from the Vercel cron route (GET /api/cron/purge, vercel.json `crons`) and from
 * scripts/integration-cron.js on long-running hosts. Every statement is idempotent; safe to run as often as you like.
 *   sessions          expires_at in the past
 *   auth_tokens       expired or used more than a day ago (kept briefly so a double-click on a used link reads "already used")
 *   rate_limits       window ended
 *   auth_oauth_states expired more than a day ago
 *   login_records     older than 3 months (통신비밀보호법), and workspaces deleted more than 30 days ago (server/auth/account.js)
 */
import { timingSafeEqual } from 'node:crypto';
import { purgeAccountData } from './auth/account.js';

export async function purgeExpired(db) {
  const count = async (sql) => Number((await db.get(`WITH d AS (${sql} RETURNING 1) SELECT COUNT(*) AS n FROM d`)).n);
  return {
    sessions: await count('DELETE FROM sessions WHERE expires_at < now()'),
    auth_tokens: await count(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`),
    rate_limits: await count('DELETE FROM rate_limits WHERE reset_at < now()'),
    oauth_states: await count(`DELETE FROM auth_oauth_states WHERE expires_at < now() - interval '1 day'`),
    ...(await purgeAccountData(db)),
    // TODO(retention-legal): personal-data retention after a subscription ends / inside projects (founder policy 2026-10-21 §2) is
    // decided by the legal review (hive research/relai-retention-legal.md). Ending a plan deletes nothing; add a job here only then.
  };
}

/** GET /api/cron/purge — Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET the route is off (404). */
export function mountMaintenanceRoutes({ app, db, wrap, fail }) {
  app.get('/api/cron/purge', wrap(async (req, res) => {
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    const given = Buffer.from(String(req.get('authorization') || '')); const want = Buffer.from(`Bearer ${secret}`);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return fail(res, 401, 'unauthenticated', '인증이 필요합니다.');
    const purged = await purgeExpired(db);
    console.log(JSON.stringify({ at: new Date().toISOString(), job: 'purge', ...purged }));
    res.set('Cache-Control', 'no-store').json({ ok: true, purged });
  }));
}
