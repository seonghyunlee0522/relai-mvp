import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) { console.error('SESSION_SECRET is required in production'); process.exit(1); }

const db = await openDb();
const app = createApp(db);
const server = app.listen(port, () => console.log(`RELAI listening on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`));

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
