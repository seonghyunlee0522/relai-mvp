/**
 * Vercel Cron entry points. Vercel calls each `crons[].path` in vercel.json with GET and `Authorization: Bearer $CRON_SECRET`.
 * Without CRON_SECRET the routes are off (404), so nothing is reachable by accident. Long-running hosts keep using
 * scripts/integration-cron.js (same job) or INTEGRATION_SCHEDULER_INTERVAL_MIN.
 *
 *   GET /api/cron/integrations — renew expiring Jira webhooks (30-day expiry) and run the scheduled Jira reconciliation.
 */
import { timingSafeEqual } from 'node:crypto';
import { runIntegrationJobs } from './integrations/scheduler.js';

/** true when the request carries `Bearer $CRON_SECRET`; otherwise answers 404 (no secret configured) or 401 and returns false. */
export function cronAuthorized(req, res, fail, env = process.env) {
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) { fail(res, 404, 'not_found', '찾을 수 없습니다.'); return false; }
  const given = Buffer.from(String(req.get('authorization') || '')); const want = Buffer.from(`Bearer ${secret}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) { fail(res, 401, 'unauthenticated', '인증이 필요합니다.'); return false; }
  return true;
}

export function mountCronRoutes({ app, db, wrap, fail }, env = process.env) {
  app.get('/api/cron/integrations', wrap(async (req, res) => {
    if (!cronAuthorized(req, res, fail, env)) return;
    // One function call has maxDuration 60 s (vercel.json): cap the number of projects synced per run.
    const r = await runIntegrationJobs(db, { limit: Number(env.INTEGRATION_CRON_SYNC_LIMIT) || 20 }, env);
    const failed = r.synced.filter((s) => s.status === 'FAILED').length + r.webhooks.filter((w) => w.action === 'error').length;
    console.log(JSON.stringify({ at: new Date().toISOString(), job: 'integrations', synced: r.synced.length, webhooks: r.webhooks.length, failed, ms: r.ms }));
    res.set('Cache-Control', 'no-store').json({ ok: true, synced: r.synced.length, webhooks: r.webhooks.length, failed, ms: r.ms });
  }));
}
