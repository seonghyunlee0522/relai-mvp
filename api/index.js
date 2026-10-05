/* Vercel entry — the whole Express app runs as one serverless function (vercel.json rewrites every path here).
 * The DB pool + app are created once per warm instance; openDb applies pending migrations on first start.
 * `server/index.js` stays the entry for Railway/any long-running host. */
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

let ready;
async function boot() {
  const db = await openDb({ max: Number(process.env.DB_POOL_MAX || 3) });
  return createApp(db);
}
export default async function handler(req, res) {
  try { ready ||= boot(); const app = await ready; return app(req, res); }
  catch (e) { ready = null; console.error('[vercel] boot failed', e); res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Server boot failed: ' + e.message); }
}
