/* Failure handling found by the production-stability test (2026-10-21, research/relai-stability/report.md §4):
 * overload / connection errors are 503 + Retry-After with a Korean message and a request id (not a bare 500), every response
 * carries X-Request-Id, and the serving pool cancels runaway statements while migrations are exempt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, dbErrorInfo } from '../db.js';
import { createApp } from '../app.js';
import { testDb, TEST_DATABASE_URL } from './helpers.js';

test('dbErrorInfo: pool exhaustion, Neon slots/memory/starting, resets → 503 db_busy; statement timeout → 503 db_timeout', () => {
  for (const e of [new Error('timeout exceeded when trying to connect'), new Error('Connection terminated unexpectedly'), new Error("couldn't connect to compute node"),
    Object.assign(new Error('x'), { code: '53300' }), Object.assign(new Error('x'), { code: '53200' }), Object.assign(new Error('x'), { code: '57P03' }), Object.assign(new Error('x'), { code: 'ECONNRESET' })]) {
    assert.deepEqual([dbErrorInfo(e)?.status, dbErrorInfo(e)?.code], [503, 'db_busy'], e.code || e.message);
  }
  assert.equal(dbErrorInfo(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })).code, 'db_timeout');
  assert.equal(dbErrorInfo(new Error('some bug')), null);   // real bugs stay 500 internal
});

test('X-Request-Id on every response; 5xx bodies carry request_id + 오류 ID, set Retry-After, and the log line names the id', async () => {
  const db = await testDb();
  const app = createApp(db);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const h = await fetch(`${base}/health`); assert.match(h.headers.get('x-request-id'), /^[\w-]{6,}$/);
  const v = await fetch(`${base}/health`, { headers: { 'x-vercel-id': 'icn1::sin1::abcde-1792543074359-b88744353c4c' } });
  assert.equal(v.headers.get('x-request-id'), 'abcde-1792543074359-b88744353c4c');
  server.close(); await db.close();

  const dead = await openDb({ url: TEST_DATABASE_URL.replace(/:\d+\//, ':1/'), applyMigrations: false, max: 1 });
  const s2 = createApp(dead).listen(0); const b2 = `http://127.0.0.1:${s2.address().port}`;
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = await fetch(`${b2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-id': 'icn1::sin1::req42-1-abc' }, body: JSON.stringify({ email: 'a@x.com', password: 'x' }) });
    const j = await r.json();
    assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(j.error.request_id, 'req42-1-abc'); assert.match(j.error.message, /오류 ID: req42-1-abc/);
    assert.ok(logs.some((l) => l.includes('req42-1-abc') && l.includes('/api/auth/login')), logs.join('\n'));
  } finally { console.error = orig; s2.close(); await dead.close(); }
});

test('statementTimeoutMs: serving pool cancels a runaway statement (57014); migrations run with the limit lifted', async () => {
  const schema = `stab_${Date.now()}`;
  const db = await openDb({ url: TEST_DATABASE_URL, schema, createSchema: true, max: 2, statementTimeoutMs: 1_000 });   // migrations ran on this pool
  try {
    await assert.rejects(() => db.get('SELECT pg_sleep(2)'), (e) => e.code === '57014');
    assert.equal((await db.get('SELECT 1 AS ok')).ok, 1);   // the connection is usable again
    assert.equal((await db.get("SELECT current_setting('statement_timeout') AS v")).v, '1s');   // the migration client's lift was reset
  } finally { await db.dropSchema(); await db.close(); }
});
