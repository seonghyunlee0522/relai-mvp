/**
 * Versioned migrations (PostgreSQL). `schema_migrations` records what has been applied.
 *
 * schema.sql is idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE) and always represents the full current
 * schema, so it is applied first on every start; versioned `up()` steps are only for data fixes and ALTERs that
 * cannot be expressed idempotently. Versions 1–9 are the SQLite-era history, kept as markers so a database
 * migrated from SQLite (scripts/migrate-sqlite-to-postgres.js) and a fresh PostgreSQL database end up identical.
 */
import { ensurePhases } from './guide.js';

export const migrations = [
  { version: 1, name: 'projects.current_phase template-based (SQLite era)', up() {} },
  { version: 2, name: 'backfill guided phases for existing projects', async up(db) { for (const p of await db.all('SELECT * FROM projects')) await ensurePhases(db, p, { createdBy: p.created_by, at: p.created_at }); } },
  { version: 3, name: 'requirement management tables', up() {} },
  { version: 4, name: 'wbs tables', up() {} },
  { version: 5, name: 'requirement ↔ wbs links', up() {} },
  { version: 6, name: 'change requests + requirement_history.source_change_request_id', up() {} },
  { version: 7, name: 'issues & risks', up() {} },
  { version: 8, name: 'tests & acceptance + issues.source_test_execution_id', up() {} },
  { version: 9, name: 'weekly reports (Phase 9)', up() {} },
  { version: 10, name: 'PostgreSQL baseline (timestamptz/date types, plpgsql triggers, history seq, usage indexes)', up() {} },
  { version: 11, name: 'comments + wbs_history (comments tab, activity feed)', up() {} },
];

export const LATEST_VERSION = migrations[migrations.length - 1].version;

/** Apply schema.sql, then any `up()` newer than the recorded version. Serialized with an advisory lock so two app instances starting together cannot race. */
export async function migrate(db, schemaSql, bindClient) {
  const lock = db.schema ? 'hashtext($1)' : '$1::int';
  const client = await db.pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${lock})`, [db.schema ? db.schema : 7101]);
    const fresh = !(await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'users'`)).rowCount;
    await client.query(schemaSql);
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    let version = Number(rows[0].v);
    const applied = [];
    if (fresh) {
      for (const m of migrations) await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.version, m.name]);
      return applied;
    }
    for (const m of migrations) {
      if (m.version <= version) continue;
      await client.query('BEGIN');
      try {
        await m.up(bindClient(client), schemaSql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed: ${e.message}`);
      }
      version = m.version;
      applied.push(m.name);
    }
    return applied;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${lock})`, [db.schema ? db.schema : 7101]).catch(() => {});
    client.release();
  }
}
