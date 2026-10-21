/* Vercel entry — the whole Express app runs as one serverless function (vercel.json rewrites every path here).
 * The DB pool + app are created once per warm instance; openDb applies pending migrations on first start.
 * `server/index.js` stays the entry for Railway/any long-running host. */
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { assertStartupConfig } from '../server/config-check.js';
import { attachDatabasePool } from '@vercel/functions';

let ready;
/* Vercel Postgres/Neon integrations inject their own names — prefer the direct (non-pgbouncer) URL: the app uses session advisory locks + SET. */
const dbUrl = () => ['DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'].map((k) => (process.env[k] || '').trim()).find(Boolean);
async function boot() {
  assertStartupConfig();   // same gate as server/index.js: no SESSION_SECRET / bad encryption key / bad e-mail config → refuse to serve
  const url = dbUrl(); if (!url) throw new Error('DATABASE_URL is not set (Vercel → Settings → Environment Variables; Neon/Postgres storage injects DATABASE_URL or POSTGRES_URL)');
  const t0 = Date.now(); console.log('[vercel] boot: connecting to', url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@'));
  const db = await openWithRetry(url);
  console.log(`[vercel] boot: db ready in ${Date.now() - t0}ms`);
  return createApp(db);
}
/* Small per-instance pool (2026-10-21 outages: many instances × pool 3 used up Neon's slots and memory). DB_POOL_MAX can only
 * lower it. Idle clients close after 5 s and attachDatabasePool keeps the instance alive until they have, so a suspended
 * instance never holds a Neon connection. */
const POOL_MAX = Math.max(1, Math.min(Number(process.env.DB_POOL_MAX) || 2, 2));
/* No query or open transaction may outlive the function (maxDuration 60 s): past this Postgres cancels it (503 db_timeout) and the
 * connection goes back to the pool instead of staying busy on Neon after Vercel has given up on the request. */
const STATEMENT_TIMEOUT_MS = Math.max(1_000, Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30_000);
const transient = (e) => /couldn't connect to compute node|connection slots|too many connections|out of memory|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout exceeded when trying to connect|Connection terminated/i.test(`${e && e.message} ${e && e.code}`)
  || ['53300', '53200', '57P01', '57P03', '08006', '08001'].includes(e && e.code);
/** A Neon compute that is waking up or briefly full refuses connections: retry with backoff instead of a 500 at once. */
async function openWithRetry(url, delays = [300, 1000, 2500]) {
  for (let i = 0; ; i++) {
    try { return await openDb({ url, max: POOL_MAX, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000, statementTimeoutMs: STATEMENT_TIMEOUT_MS, onPool: attachDatabasePool }); }
    catch (e) {
      if (i >= delays.length || !transient(e)) throw e;   // openDb already ended this attempt's pool
      console.warn(`[vercel] boot: db not ready (${e.code || ''} ${e.message}), retry ${i + 1} in ${delays[i]}ms`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}
export default async function handler(req, res) {
  try { ready ||= boot(); const app = await ready; return app(req, res); }
  catch (e) { ready = null; console.error('[vercel] boot failed', e); res.statusCode = 503; res.setHeader('Retry-After', '5'); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Service temporarily unavailable.'); }   // details stay in the function log, not in the response
}
