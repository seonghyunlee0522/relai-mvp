/* Vercel entry — the whole Express app runs as one serverless function (vercel.json rewrites every path here).
 * The DB pool + app are created once per warm instance; openDb applies pending migrations on first start.
 * `server/index.js` stays the entry for Railway/any long-running host. */
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

let ready;
/* Vercel Postgres/Neon integrations inject their own names — prefer the direct (non-pgbouncer) URL: the app uses session advisory locks + SET. */
const dbUrl = () => ['DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'].map((k) => (process.env[k] || '').trim()).find(Boolean);
async function boot() {
  const url = dbUrl(); if (!url) throw new Error('DATABASE_URL is not set (Vercel → Settings → Environment Variables; Neon/Postgres storage injects DATABASE_URL or POSTGRES_URL)');
  const t0 = Date.now(); console.log('[vercel] boot: connecting to', url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@'));
  const db = await openDb({ url, max: Number(process.env.DB_POOL_MAX || 3) });
  console.log(`[vercel] boot: db ready in ${Date.now() - t0}ms`);
  return createApp(db);
}
export default async function handler(req, res) {
  try { ready ||= boot(); const app = await ready; return app(req, res); }
  catch (e) { ready = null; console.error('[vercel] boot failed', e); res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Server boot failed: ' + e.message); }
}
