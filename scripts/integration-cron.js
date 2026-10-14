#!/usr/bin/env node
/* One reconciliation pass for the integration layer (Jira snapshots + webhook renewal) plus the expired-session /
 * token / rate-limit purge (on Vercel the purge runs from the /api/cron/purge cron instead). Run from cron, e.g.
 *   (crontab) 15분마다:  cd /srv/relai && node scripts/integration-cron.js >> /var/log/relai-integrations.log 2>&1
 * Exits 0 when the pass ran (per-project failures are logged, not fatal). */
import { openDb } from '../server/db.js';
import { runIntegrationJobs } from '../server/integrations/scheduler.js';
import { purgeExpired } from '../server/maintenance.js';

const db = await openDb();
try {
  const r = await runIntegrationJobs(db);
  const purged = await purgeExpired(db);
  console.log(JSON.stringify({ at: new Date().toISOString(), synced: r.synced, webhooks: r.webhooks, ms: r.ms, purged }));
} finally { await db.close?.(); }
