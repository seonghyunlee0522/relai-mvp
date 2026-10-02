/**
 * Scheduled reconciliation + webhook renewal. Two entry points:
 *   runIntegrationJobs(db)  — one pass (sync due projects, renew expiring webhooks, prune old oauth states). Call from any
 *                             external scheduler: `node scripts/integration-cron.js` (cron / systemd timer / k8s CronJob).
 *   startInProcessScheduler — optional convenience for single-instance deployments (INTEGRATION_SCHEDULER_INTERVAL_MIN > 0).
 * Webhooks are the fast path; this is the safety net, so it never depends on them.
 */
import { syncAllDue, renewWebhooks } from './jira/sync.js';

export async function runIntegrationJobs(db, { olderThanMinutes = Number(process.env.INTEGRATION_SYNC_STALE_MIN) || 30, limit = 50 } = {}, env = process.env) {
  const started = Date.now();
  const synced = await syncAllDue(db, { olderThanMinutes, limit }, env);
  const webhooks = await renewWebhooks(db, env);
  await db.run('DELETE FROM integration_oauth_states WHERE expires_at < now()');
  return { synced, webhooks, ms: Date.now() - started };
}

export function startInProcessScheduler(db, env = process.env) {
  const min = Number(env.INTEGRATION_SCHEDULER_INTERVAL_MIN) || 0;
  if (!(min > 0)) return null;
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { const r = await runIntegrationJobs(db, {}, env); if (r.synced.length || r.webhooks.length) console.log(`[integrations] scheduled: synced ${r.synced.length}, webhooks ${r.webhooks.length} (${r.ms} ms)`); } catch (e) { console.error('[integrations] scheduled job failed:', e.message); } finally { busy = false; } };
  const t = setInterval(tick, min * 60 * 1000); t.unref();
  return t;
}
