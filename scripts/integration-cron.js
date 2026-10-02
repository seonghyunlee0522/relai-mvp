#!/usr/bin/env node
/* One reconciliation pass for the integration layer (Jira snapshots + webhook renewal). Run from cron, e.g.
 *   */15 * * * *  cd /srv/relai && node scripts/integration-cron.js >> /var/log/relai-integrations.log 2>&1
 * Exits 0 when the pass ran (per-project failures are logged, not fatal). */
import { openDb } from '../server/db.js';
import { runIntegrationJobs } from '../server/integrations/scheduler.js';

const db = await openDb();
try {
  const r = await runIntegrationJobs(db);
  console.log(JSON.stringify({ at: new Date().toISOString(), synced: r.synced, webhooks: r.webhooks, ms: r.ms }));
} finally { await db.close?.(); }
