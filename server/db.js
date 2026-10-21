/**
 * PostgreSQL access layer (pg Pool). One small surface used by every module:
 *   db.get(sql, params)  → first row or undefined
 *   db.all(sql, params)  → rows
 *   db.run(sql, params)  → { changes }
 *   tx(db, async (t) => …) → runs fn on a dedicated client inside BEGIN/COMMIT (ROLLBACK on throw);
 *                            `t` has the same get/all/run API and must be used for every query in the transaction.
 * SQL is written with `?` placeholders (converted to $n here). No ORM; no second dialect.
 *
 * Type policy: int8/numeric → Number, date → 'YYYY-MM-DD' string, timestamptz → ISO string
 * (so JSON responses and string comparisons behave exactly as before).
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrations.js';

const { Pool, types } = pg;
const here = dirname(fileURLToPath(import.meta.url));
export const schemaSql = readFileSync(resolve(here, 'schema.sql'), 'utf8');

types.setTypeParser(20, (v) => Number(v));            // int8 (COUNT, SUM of ints)
types.setTypeParser(1700, (v) => Number(v));          // numeric
types.setTypeParser(1082, (v) => v);                  // date → keep 'YYYY-MM-DD'
const iso = (v) => (v === null ? null : new Date(v).toISOString());
types.setTypeParser(1184, iso);                       // timestamptz → ISO string (UTC)
types.setTypeParser(1114, iso);                       // timestamp

export const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Seoul';

/** `?` → `$1, $2 …` outside of quoted strings / dollar-quoted blocks. */
export function toPositional(sql) {
  let out = ''; let n = 0; let i = 0; let quote = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) { if (quote === "'" && sql[i + 1] === "'") { out += "'"; i++; } else quote = null; } i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; i++; continue; }
    if (ch === '?') { out += '$' + (++n); i++; continue; }
    out += ch; i++;
  }
  return out;
}

const bind = (client, { isTx = false, pool = null, schema = null } = {}) => ({
  isTx, pool, schema, client,
  async all(sql, params = []) { return (await client.query(toPositional(sql), params)).rows; },
  async get(sql, params = []) { return (await client.query(toPositional(sql), params)).rows[0]; },
  async run(sql, params = []) { const r = await client.query(toPositional(sql), params); return { changes: r.rowCount ?? 0, rows: r.rows }; },
  async exec(sql) { await client.query(sql); },
});

/**
 * Open a pool. `schema` (tests) isolates everything under a dedicated PostgreSQL schema so each test gets a fresh,
 * independent database without creating a database per test. Pool size is conservative (env DB_POOL_MAX, default 10).
 */
export async function openDb({ url = process.env.DATABASE_URL, schema = null, max = Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis = 30_000, connectionTimeoutMillis = 10_000, statementTimeoutMs = 0, onPool = null, createSchema = false, applyMigrations = true } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  // statementTimeoutMs (serverless): a stuck query or a transaction left open cannot hold one of an instance's 2 connections past
  // the function's own time limit. Migrations lift it on their own session (migrate()).
  const limits = statementTimeoutMs > 0 ? ` -c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${statementTimeoutMs}` : '';
  const options = (schema ? `-c search_path=${schema},public -c timezone=${APP_TIMEZONE}` : `-c timezone=${APP_TIMEZONE}`) + limits;
  const pool = new Pool({ connectionString: url, max, idleTimeoutMillis, connectionTimeoutMillis, options });
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  if (onPool) onPool(pool);   // serverless: attachDatabasePool keeps the instance alive until idle clients are closed
  if (schema && createSchema) { const c = await pool.connect(); try { await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`); } finally { c.release(); } }
  const db = bind(pool, { pool, schema });
  db.close = async () => { await pool.end(); };
  db.dropSchema = async () => { if (!schema) return; const p = new Pool({ connectionString: url, max: 1 }); try { await p.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await p.end(); } };
  if (applyMigrations) {
    // A failed boot must give its connections back at once: serverless instances retry boot per request, and a leaked pool per
    // attempt (kept alive while the instance is frozen) used up every Neon slot on 2026-10-21 ('remaining connection slots are reserved').
    let applied;
    try { applied = await migrate(db, schemaSql, (client) => bind(client, { isTx: true, pool, schema })); }
    catch (e) { await pool.end().catch(() => {}); throw e; }
    if (applied.length) console.log(`[db] applied migrations: ${applied.join('; ')}`);
  }
  return db;
}

/** Bind a raw pg client to the get/all/run API (used by migrations and tests). */
export const bindTx = (client, db) => bind(client, { isTx: true, pool: db.pool, schema: db.schema });

/** Run fn inside a transaction. Nested calls reuse the outer transaction client. */
export async function tx(db, fn) {
  if (db.isTx) return fn(db);
  const client = await db.pool.connect();
  const t = bind(client, { isTx: true, pool: db.pool, schema: db.schema });
  try {
    await client.query('BEGIN');
    const out = await fn(t);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Map PostgreSQL error codes to API semantics (used by the Express error handler). */
export function dbErrorInfo(err) {
  const code = err && err.code;
  if (code === '23505') return { status: 409, code: 'conflict', message: '이미 존재하는 값입니다.' };
  if (code === '23503') return { status: 400, code: 'invalid_reference', message: '연결 대상을 찾을 수 없습니다.' };
  // 22021 / 22P05: text PostgreSQL cannot store (a NUL byte \u0000 in a title was a 500, integrity 2026-10-21)
  if (code === '22021' || code === '22P05') return { status: 400, code: 'invalid_value', message: '입력값에 저장할 수 없는 문자가 있습니다.' };
  if (code === '23514' || code === '23502') return { status: 400, code: 'invalid_value', message: '입력값을 확인해 주세요.' };
  if (code === 'RL001') return { status: 400, code: 'integrity', message: err.message };
  if (code === '40P01' || code === '40001') return { status: 409, code: 'retry', message: '잠시 후 다시 시도해 주세요.' };
  if (code === 'ECONNREFUSED' || code === '57P01' || code === '08006' || code === '08003') return { status: 503, code: 'db_unavailable', message: '데이터베이스에 연결할 수 없습니다.' };
  // Overload / transient connection trouble (stability test 2026-10-21): every one of these was a bare 500 'internal'. The pool's
  // "timeout exceeded when trying to connect" (all ≤2 clients busy for 5 s) was 100% of the 500s at 10–50 users; Neon answers
  // 53300 when its slots are full, 53200 when out of memory, 57P03 while the compute starts. A 503 + Retry-After says "try again".
  if (code === '57014') return { status: 503, code: 'db_timeout', message: '처리 시간이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요.' };
  if (['53300', '53200', '53400', '57P03', '08001', '08004', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)
    || /timeout exceeded when trying to connect|Connection terminated|couldn't connect to compute node|Client has encountered a connection error/i.test(String(err && err.message))) {
    return { status: 503, code: 'db_busy', message: '접속이 많아 잠시 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
  return null;
}
