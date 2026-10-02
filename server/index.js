import { openDb } from './db.js';
import { createApp } from './app.js';
import { startInProcessScheduler } from './integrations/scheduler.js';
import { assertEncryptionConfig, IntegrationConfigError } from './integrations/crypto.js';

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) { console.error('SESSION_SECRET is required in production'); process.exit(1); }

// Integration credential key: malformed → always fatal; missing → fatal in production, derived from SESSION_SECRET elsewhere.
try { assertEncryptionConfig(); } catch (e) { if (e instanceof IntegrationConfigError) { console.error(e.message); process.exit(1); } throw e; }

const db = await openDb();
const app = createApp(db);
const server = app.listen(port, () => console.log(`RELAI listening on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`));
startInProcessScheduler(db);   // only when INTEGRATION_SCHEDULER_INTERVAL_MIN > 0; external cron (scripts/integration-cron.js) is the recommended scheduler

/* Graceful shutdown: stop accepting connections, let in-flight requests finish, then close the pool. */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[app] ${signal} received, shutting down`);
  const timer = setTimeout(() => { console.error('[app] forced exit'); process.exit(1); }, 10_000); timer.unref();
  server.close(async () => { try { await db.close(); } finally { process.exit(0); } });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
process.on('unhandledRejection', (e) => { console.error('[app] unhandledRejection', e); });
