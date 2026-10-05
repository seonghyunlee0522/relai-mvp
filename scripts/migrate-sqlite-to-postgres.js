#!/usr/bin/env node
/**
 * One-shot data migration: legacy SQLite file → PostgreSQL (same schema, same IDs).
 *
 *   node scripts/migrate-sqlite-to-postgres.js --sqlite data/relai.db --url postgres://… [--truncate] [--dry-run]
 *
 * - Copies every table in FK order, keeping primary keys, display IDs, history, junction rows.
 * - Converts text timestamps/dates to timestamptz/date (PostgreSQL casts the ISO strings).
 * - Runs inside ONE transaction: either everything lands or nothing does.
 * - Prints a before/after row-count table and an orphan-relation check (also available alone via --validate).
 * The target database must be empty (or use --truncate to wipe RELAI tables first). The SQLite file is never modified.
 */
import { DatabaseSync } from 'node:sqlite';
import { openDb, tx } from '../server/db.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter((x) => x.length));
const isMain = import.meta.url === `file://${process.argv[1]}`;

/** Insert order respects foreign keys. */
export const TABLES = [
  'users', 'sessions', 'workspaces', 'workspace_members', 'projects', 'project_phases', 'project_steps', 'phase_transitions', 'project_counters',
  'requirements', 'requirement_criteria', 'requirement_history', 'wbs_items', 'wbs_dependencies', 'requirement_wbs_links',
  'change_requests', 'change_request_requirements', 'change_request_wbs_impacts', 'change_request_history',
  'risks', 'issues', 'raid_links', 'raid_history', 'test_cases', 'test_executions', 'test_links', 'acceptances', 'acceptance_links', 'qa_history', 'weekly_reports',
];
const SKIP_COLS = new Set(['seq']); // bigserial columns are generated on the PostgreSQL side
// SQLite-era projects.project_type (SI / MIGRATION / …) is a different, retired field: never copied into the new enum column (stays NULL = 미설정)
const SKIP_TABLE_COLS = { projects: new Set(['project_type']) };

export const ORPHAN_CHECKS = [
  ['workspace_members → users', `SELECT COUNT(*) AS n FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL`],
  ['projects → workspaces', `SELECT COUNT(*) AS n FROM projects p LEFT JOIN workspaces w ON w.id = p.workspace_id WHERE w.id IS NULL`],
  ['project_steps → project_phases', `SELECT COUNT(*) AS n FROM project_steps s LEFT JOIN project_phases p ON p.id = s.project_phase_id WHERE p.id IS NULL`],
  ['requirements → projects', `SELECT COUNT(*) AS n FROM requirements r LEFT JOIN projects p ON p.id = r.project_id WHERE p.id IS NULL`],
  ['requirement_history → requirements', `SELECT COUNT(*) AS n FROM requirement_history h LEFT JOIN requirements r ON r.id = h.requirement_id WHERE r.id IS NULL`],
  ['requirement_wbs_links ends', `SELECT COUNT(*) AS n FROM requirement_wbs_links l LEFT JOIN requirements r ON r.id = l.requirement_id LEFT JOIN wbs_items w ON w.id = l.wbs_item_id WHERE r.id IS NULL OR w.id IS NULL OR r.project_id <> l.project_id OR w.project_id <> l.project_id`],
  ['wbs_items.parent same project', `SELECT COUNT(*) AS n FROM wbs_items c JOIN wbs_items p ON p.id = c.parent_id WHERE p.project_id <> c.project_id`],
  ['wbs_dependencies ends', `SELECT COUNT(*) AS n FROM wbs_dependencies d LEFT JOIN wbs_items a ON a.id = d.predecessor_id LEFT JOIN wbs_items b ON b.id = d.successor_id WHERE a.id IS NULL OR b.id IS NULL`],
  ['change_request_requirements ends', `SELECT COUNT(*) AS n FROM change_request_requirements x LEFT JOIN change_requests c ON c.id = x.change_request_id LEFT JOIN requirements r ON r.id = x.requirement_id WHERE c.id IS NULL OR r.id IS NULL OR c.project_id <> r.project_id`],
  ['change_request_wbs_impacts ends', `SELECT COUNT(*) AS n FROM change_request_wbs_impacts x LEFT JOIN change_requests c ON c.id = x.change_request_id LEFT JOIN wbs_items w ON w.id = x.wbs_item_id WHERE c.id IS NULL OR w.id IS NULL OR c.project_id <> w.project_id`],
  ['requirement_history.source_change_request_id', `SELECT COUNT(*) AS n FROM requirement_history h LEFT JOIN change_requests c ON c.id = h.source_change_request_id WHERE h.source_change_request_id IS NOT NULL AND c.id IS NULL`],
  ['issues.source_risk_id', `SELECT COUNT(*) AS n FROM issues i LEFT JOIN risks r ON r.id = i.source_risk_id WHERE i.source_risk_id IS NOT NULL AND (r.id IS NULL OR r.project_id <> i.project_id)`],
  ['issues.source_test_execution_id', `SELECT COUNT(*) AS n FROM issues i LEFT JOIN test_executions e ON e.id = i.source_test_execution_id WHERE i.source_test_execution_id IS NOT NULL AND e.id IS NULL`],
  ['raid_links ends', `SELECT COUNT(*) AS n FROM raid_links l WHERE NOT rl_entity_in_project(l.source_type, l.source_id, l.project_id) OR NOT rl_entity_in_project(l.target_type, l.target_id, l.project_id)`],
  ['raid_history → entity', `SELECT COUNT(*) AS n FROM raid_history h WHERE NOT EXISTS (SELECT 1 FROM issues i WHERE h.entity_type = 'ISSUE' AND i.id = h.entity_id) AND NOT EXISTS (SELECT 1 FROM risks r WHERE h.entity_type = 'RISK' AND r.id = h.entity_id)`],
  ['test_executions → test_cases', `SELECT COUNT(*) AS n FROM test_executions e LEFT JOIN test_cases t ON t.id = e.test_case_id WHERE t.id IS NULL`],
  ['test_links ends', `SELECT COUNT(*) AS n FROM test_links l WHERE NOT rl_entity_in_project('TEST', l.test_case_id, l.project_id) OR NOT rl_entity_in_project(l.target_type, l.target_id, l.project_id)`],
  ['acceptance_links ends', `SELECT COUNT(*) AS n FROM acceptance_links l WHERE NOT rl_entity_in_project('ACCEPTANCE', l.acceptance_id, l.project_id) OR NOT rl_entity_in_project(l.target_type, l.target_id, l.project_id)`],
  ['qa_history → entity', `SELECT COUNT(*) AS n FROM qa_history h WHERE NOT EXISTS (SELECT 1 FROM test_cases t WHERE h.entity_type = 'TEST' AND t.id = h.entity_id) AND NOT EXISTS (SELECT 1 FROM acceptances a WHERE h.entity_type = 'ACCEPTANCE' AND a.id = h.entity_id)`],
  ['weekly_reports → projects', `SELECT COUNT(*) AS n FROM weekly_reports r LEFT JOIN projects p ON p.id = r.project_id WHERE p.id IS NULL`],
  ['projects.current_phase has a phase row', `SELECT COUNT(*) AS n FROM projects p WHERE NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.project_id = p.id AND ph.phase_key = p.current_phase)`],
];

export async function validate(pg) {
  const counts = {}; for (const t of TABLES) counts[t] = (await pg.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  const orphans = []; for (const [label, sql] of ORPHAN_CHECKS) { const n = (await pg.get(sql)).n; if (n) orphans.push({ label, n }); }
  return { counts, orphans };
}

export async function migrateData(sqliteFile, pg, { truncate = false, dryRun = false, log = console.log } = {}) {
  const src = new DatabaseSync(sqliteFile, { readOnly: true });
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const before = {}; for (const t of TABLES) before[t] = srcTables.has(t) ? src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0;
  const existing = (await pg.get(`SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM projects) AS n`)).n;
  if (existing && !truncate) throw new Error('target database is not empty — pass --truncate to wipe RELAI tables first');
  let copied = {};
  await tx(pg, async (t) => {
    if (truncate) await t.exec(`TRUNCATE ${[...TABLES].reverse().join(', ')} CASCADE`);
    await t.exec('SET CONSTRAINTS ALL DEFERRED');
    for (const table of TABLES) {
      if (!srcTables.has(table)) { copied[table] = 0; continue; }
      const rows = src.prepare(`SELECT * FROM ${table}`).all();
      const pgCols = (await t.all(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, [table])).map((r) => r.column_name);
      const cols = rows.length ? Object.keys(rows[0]).filter((c) => pgCols.includes(c) && !SKIP_COLS.has(c) && !(SKIP_TABLE_COLS[table] && SKIP_TABLE_COLS[table].has(c))) : [];
      // history rows carry no seq in SQLite: keep their original insertion order (rowid) so seq reproduces it
      const ordered = table.endsWith('_history') || table === 'phase_transitions' ? src.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : rows;
      const CHUNK = 500;
      for (let i = 0; i < ordered.length; i += CHUNK) {
        const chunk = ordered.slice(i, i + CHUNK); const vals = []; const ph = [];
        for (const r of chunk) { ph.push(`(${cols.map(() => '?').join(',')})`); for (const c of cols) vals.push(r[c] === '' && /_at$|_date$/.test(c) ? null : r[c]); }
        await t.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}`, vals);
      }
      copied[table] = ordered.length;
    }
    // triggers were skipped? no — triggers fire on insert; rows that violated them would have thrown. Reset sequences for bigserial columns.
    for (const h of ['requirement_history', 'change_request_history', 'raid_history', 'qa_history', 'phase_transitions']) await t.exec(`SELECT setval(pg_get_serial_sequence('${h}', 'seq'), COALESCE((SELECT MAX(seq) FROM ${h}), 0) + 1, false)`);
    if (dryRun) throw new DryRun();
  }).catch((e) => { if (!(e instanceof DryRun)) throw e; });
  src.close();
  const after = dryRun ? null : await validate(pg);
  log(`${'table'.padEnd(32)} sqlite  copied  postgres`);
  for (const t of TABLES) log(`${t.padEnd(32)} ${String(before[t]).padStart(6)}  ${String(copied[t] ?? 0).padStart(6)}  ${after ? String(after.counts[t]).padStart(8) : '   (dry)'}`);
  const mismatch = TABLES.filter((t) => after && after.counts[t] !== before[t]);
  if (after) { log(mismatch.length ? `ROW COUNT MISMATCH: ${mismatch.join(', ')}` : 'row counts match for every table'); log(after.orphans.length ? `ORPHANS: ${after.orphans.map((o) => `${o.label}=${o.n}`).join('; ')}` : 'no orphan relations'); }
  return { before, copied, after, ok: after ? !mismatch.length && !after.orphans.length : null };
}
class DryRun extends Error {}

if (isMain) {
  const sqliteFile = args.sqlite || process.env.DATABASE_FILE || 'data/relai.db';
  const url = args.url || process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL (or --url) is required'); process.exit(2); }
  const pg = await openDb({ url });
  try {
    if (args.validate) { const v = await validate(pg); console.log(v.counts); console.log(v.orphans.length ? v.orphans : 'no orphan relations'); process.exit(v.orphans.length ? 1 : 0); }
    const r = await migrateData(sqliteFile, pg, { truncate: Boolean(args.truncate), dryRun: Boolean(args['dry-run']) });
    process.exit(r.ok === false ? 1 : 0);
  } finally { await pg.close(); }
}
