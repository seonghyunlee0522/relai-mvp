/**
 * Versioned migrations (PostgreSQL). `schema_migrations` records what has been applied.
 *
 * schema.sql is idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE) and always represents the full current
 * schema, so it is applied first on every start; versioned `up()` steps are only for data fixes and ALTERs that
 * cannot be expressed idempotently. Versions 1–9 are the SQLite-era history, kept as markers so a database
 * migrated from SQLite (scripts/migrate-sqlite-to-postgres.js) and a fresh PostgreSQL database end up identical.
 */
import { ensurePhases, resetPhases } from './guide.js';
import { randomUUID } from 'node:crypto';
import { PHASE_BY_KEY, ANALYSIS_DESIGN_DESCRIPTION, ANALYSIS_DESIGN_DESCRIPTION_V1 } from './templates/default-phases.js';

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
  { version: 12, name: 'admin console: users.status/system_role/last_login_at, workspaces.status, admin_audit_logs', up() {} },
  { version: 13, name: 'AI productivity layer: ai_runs, workspace_credit_accounts, credit_ledger (Phase 11)', up() {} },
  { version: 14, name: 'project_definitions (프로젝트 정의)', up() {} },
  { version: 15, name: 'tree WBS: depth/weight columns, depth backfill (SUMMARY kept as legacy group)', async up(db) {
    await db.run(`WITH RECURSIVE t AS (SELECT id, 0 AS d FROM wbs_items WHERE parent_id IS NULL UNION ALL SELECT w.id, t.d + 1 FROM wbs_items w JOIN t ON w.parent_id = t.id)
      UPDATE wbs_items w SET depth = t.d FROM t WHERE t.id = w.id AND w.depth <> t.d`);
  } },
  { version: 16, name: 'integration foundation: connections, oauth states, project mappings, entity links, activity (Phase 12)', up() {} },
  { version: 17, name: 'jira snapshots, integration events (idempotency), sync runs, webhook registrations (Phase 12)', up() {} },
  { version: 18, name: 'identity & invitations (Phase 13): user_identities (+PASSWORD backfill), invitations, auth_oauth_states, email_deliveries, users.password_hash nullable', async up(db) {
    // Every existing password user gets a PASSWORD identity (subject = user id) so "login methods" is uniform from day one.
    await db.run(`INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, created_at, last_used_at)
      SELECT gen_random_uuid()::text, u.id, 'PASSWORD', u.id, u.email, false, u.created_at, u.last_login_at FROM users u
      WHERE u.password_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.provider = 'PASSWORD' AND i.provider_subject = u.id)`);
  } },
  { version: 19, name: 'onboarding & guided activation (Phase 14): user_onboarding, user_feature_guides', up() {} },
  { version: 20, name: 'AI Project WBS Planner (Phase 15): ai_wbs_plans', up() {} },
  { version: 21, name: 'Lifecycle V2: 7-phase lifecycle template, activity importance/SKIPPED, wbs_items.lifecycle_phase — phases of every project re-seeded from 착수 (no legacy phase mapping)', async up(db) {
    for (const p of await db.all('SELECT * FROM projects')) await resetPhases(db, p);
  } },
  { version: 22, name: 'Project creation form: client_name + project_scale replace project_type / current_situation (columns dropped, no legacy mapping)', async up(db) {
    await db.run('ALTER TABLE projects DROP COLUMN IF EXISTS project_type, DROP COLUMN IF EXISTS current_situation');
  } },
  { version: 23, name: 'Project Charter: free-text definition fields (project_type, deliverables, assumptions, constraints_text, initial_risks, change_management, acceptance)', up() {} },
  { version: 24, name: 'project traits on projects: project_type (enum, NULL = 미설정) + data_migration / deployment_environment / delivery_model / has_existing_system / has_external_integration (TBD)', async up(db) {
    // schema.sql adds these columns before versioned steps run; a database upgraded across v22 (which drops the legacy free-text
    // projects.project_type) loses it again in the same boot, so re-add it here. Existing projects: type NULL, the rest TBD.
    await db.run(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT CHECK (project_type IN ('NEW_BUILD','ENHANCEMENT','TRANSITION','OTHER'))`);
  } },
  { version: 25, name: 'Billing (Phase 10): subscriptions, payments, billing_events, subscription_events — tables in schema.sql; plan limits enforced by billing/limits.js', up() {} },
  { version: 26, name: 'auth hardening: auth_tokens (password reset / e-mail verification, hashed, single use), rate_limits (shared limiter for serverless)', up() {} },
  { version: 27, name: 'change_requests.approver_user_id (designated approver; self-approval blocked)', up() {} },
  { version: 28, name: 'Activity checklists (06 전환·오픈 · 07 운영): activity_checklist_items — table in schema.sql; activity state derives from it', up() {} },
  { version: 29, name: 'NicePay billing: billing_orders (server-side prices) + subscriptions.seats/billing_cycle/auto_renew/renewal_reminded_for/founding_until/billing_key_enc — DDL in schema.sql', up() {} },
  { version: 30, name: 'account lifecycle: users.deleted_at, workspaces.deleted_at/deleted_by/purged_at (soft delete + 30-day purge), login_records (3 months)', up() {} },
  { version: 31, name: 'Phase 1 착수: project_definitions.kickoff/approval (schema.sql) + KICKOFF (착수보고회) and APPROVAL (착수 결과 승인) activities added to every project\'s 01 착수 as TODO', async up(db) {
    // Existing projects are never blocked: the two activities simply appear as open in 01 (spec §4, D3). Idempotent per phase.
    const ins = `INSERT INTO project_steps (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, now(), now())`;
    const tpl = PHASE_BY_KEY.INITIATION.steps.filter((st) => st.key === 'KICKOFF' || st.key === 'APPROVAL');
    for (const ph of await db.all(`SELECT id FROM project_phases WHERE phase_key = 'INITIATION'`)) {
      const have = new Set((await db.all('SELECT step_key FROM project_steps WHERE project_phase_id = ?', [ph.id])).map((r) => r.step_key));
      let seq = Number((await db.get('SELECT COALESCE(MAX(sequence), 0) AS n FROM project_steps WHERE project_phase_id = ?', [ph.id])).n);
      for (const st of tpl) if (!have.has(st.key)) await db.run(ins, [randomUUID(), ph.id, st.key, st.title, st.description, st.completion_criteria, ++seq, st.is_required ? 1 : 0, st.importance, st.linked_feature_type]);
    }
  } },
  { version: 32, name: 'Phase 2 요구사항 정의: project_definitions.req_approval (schema.sql) + BASELINE_APPROVAL (요구사항 기준선 승인) added to every project\'s 02 right after CONFIRM as TODO', async up(db) {
    // Existing projects are never blocked (already past 02 → the activity just shows as open there). Idempotent per phase.
    const st = PHASE_BY_KEY.REQUIREMENTS.steps.find((x) => x.key === 'BASELINE_APPROVAL');
    for (const ph of await db.all(`SELECT id FROM project_phases WHERE phase_key = 'REQUIREMENTS'`)) {
      if (await db.get(`SELECT 1 FROM project_steps WHERE project_phase_id = ? AND step_key = 'BASELINE_APPROVAL'`, [ph.id])) continue;
      const conf = await db.get(`SELECT sequence FROM project_steps WHERE project_phase_id = ? AND step_key = 'CONFIRM'`, [ph.id]);
      const seq = conf ? Number(conf.sequence) + 1 : Number((await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM project_steps WHERE project_phase_id = ?', [ph.id])).n);
      await db.run('UPDATE project_steps SET sequence = sequence + 1 WHERE project_phase_id = ? AND sequence >= ?', [ph.id, seq]);
      await db.run(`INSERT INTO project_steps (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, now(), now())`, [randomUUID(), ph.id, st.key, st.title, st.description, st.completion_criteria, seq, 1, st.importance, st.linked_feature_type]);
    }
  } },
  { version: 33, name: 'Phase 3 분석·설계: wbs_items.owner_stakeholder_id (schema.sql) + NON_DEV_TASKS 선택 → 권장 + 03 단계 설명 한 줄 추가 in every project', async up(db) {
    // Existing projects only see 기능 개발 외 작업 확인 as 권장 (still never a gate) and the extra description line; no data is moved.
    await db.run(`UPDATE project_steps SET importance = 'RECOMMENDED', is_required = 0, updated_at = now() WHERE step_key = 'NON_DEV_TASKS' AND importance <> 'RECOMMENDED'
      AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'ANALYSIS_DESIGN')`);
    await db.run(`UPDATE project_phases SET description = ? WHERE phase_key = 'ANALYSIS_DESIGN' AND description = ?`, [ANALYSIS_DESIGN_DESCRIPTION, ANALYSIS_DESIGN_DESCRIPTION_V1]);
  } },
  { version: 34, name: 'Phase 3 acceptance J-A3: stored 03 activity copy → Korean (REQ_TRACE \'요구사항–WBS 연결\', PLAN \'작업 수준\')', async up(db) {
    // Only rows still carrying the old template text are touched (a PM-edited title stays as is).
    await db.run(`UPDATE project_steps SET title = '요구사항–WBS 연결' WHERE step_key = 'REQ_TRACE' AND title = 'Requirements ↔ WBS 연결'`);
    await db.run(`UPDATE project_steps SET description = replace(description, 'Task 수준', '작업 수준') WHERE step_key = 'PLAN' AND description LIKE '%Task 수준%'`);
  } },
  { version: 35, name: 'Phase 4 구현: wbs_items.original_planned_end_date (backfilled for projects at/after 04), wbs_history.note, change_requests.customer_approval, issues.owner_stakeholder_id (schema.sql) + WEEKLY_REPORT (주간보고 작성·공유) added to every project\'s 04 right after CHANGES as TODO', async up(db) {
    // 최초 종료일: projects already at/after 04 take the end date as it stood when 04 began (last planned_end_date / milestone_date change
    // recorded before the first entry into DEVELOPMENT — or into any later phase when 04 was skipped), else the current value.
    // Projects before 04 stay NULL: the value is frozen when they enter 04 (guide.js transitionTo).
    await db.run(`UPDATE wbs_items w SET original_planned_end_date = COALESCE(
        (SELECT (h.new_value)::date FROM wbs_history h WHERE h.wbs_item_id = w.id AND h.action_type = 'UPDATED'
          AND h.field_name = CASE WHEN w.item_type = 'MILESTONE' THEN 'milestone_date' ELSE 'planned_end_date' END
          AND h.new_value ~ '^\\d{4}-\\d{2}-\\d{2}$'
          AND h.changed_at <= (SELECT MIN(t.changed_at) FROM phase_transitions t JOIN project_phases ph ON ph.id = t.to_phase_id
            WHERE t.project_id = w.project_id AND ph.sequence >= (SELECT sequence FROM project_phases d WHERE d.project_id = w.project_id AND d.phase_key = 'DEVELOPMENT'))
          ORDER BY h.changed_at DESC, h.seq DESC LIMIT 1),
        CASE WHEN w.item_type = 'MILESTONE' THEN w.milestone_date ELSE w.planned_end_date END)
      FROM projects p WHERE p.id = w.project_id AND w.original_planned_end_date IS NULL
        AND p.current_phase IN ('DEVELOPMENT','TESTING','TRANSITION_GO_LIVE','OPERATIONS')`);
    const st = PHASE_BY_KEY.DEVELOPMENT.steps.find((x) => x.key === 'WEEKLY_REPORT');
    for (const ph of await db.all(`SELECT id FROM project_phases WHERE phase_key = 'DEVELOPMENT'`)) {
      if (await db.get(`SELECT 1 FROM project_steps WHERE project_phase_id = ? AND step_key = 'WEEKLY_REPORT'`, [ph.id])) continue;
      const ch = await db.get(`SELECT sequence FROM project_steps WHERE project_phase_id = ? AND step_key = 'CHANGES'`, [ph.id]);
      const seq = ch ? Number(ch.sequence) + 1 : Number((await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM project_steps WHERE project_phase_id = ?', [ph.id])).n);
      await db.run('UPDATE project_steps SET sequence = sequence + 1 WHERE project_phase_id = ? AND sequence >= ?', [ph.id, seq]);
      await db.run(`INSERT INTO project_steps (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, now(), now())`, [randomUUID(), ph.id, st.key, st.title, st.description, st.completion_criteria, seq, 0, st.importance, st.linked_feature_type]);
    }
  } },
];

export const LATEST_VERSION = migrations[migrations.length - 1].version;

/** Apply schema.sql, then any `up()` newer than the recorded version. Serialized with an advisory lock so two app instances starting together cannot race. */
export async function migrate(db, schemaSql, bindClient) {
  const lock = db.schema ? 'hashtext($1)' : '$1::int';
  const client = await db.pool.connect();
  const upToDate = async () => { try { const r = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations'); return Number(r.rows[0].v) >= LATEST_VERSION; } catch { return false; } };
  try {
    if (await upToDate()) return [];   // nothing to apply → no lock needed (serverless instances boot without touching the lock)
    // A frozen serverless instance can keep a session-level advisory lock forever: fail fast, kick idle holders once, retry.
    await client.query(`SET lock_timeout = '15s'`);
    try { await client.query(`SELECT pg_advisory_lock(${lock})`, [db.schema ? db.schema : 7101]); }
    catch (e) {
      if (!/lock timeout/.test(e.message)) throw e;
      await client.query(`SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid WHERE l.locktype = 'advisory' AND a.state = 'idle' AND a.pid <> pg_backend_pid()`).catch(() => {});
      if (await upToDate()) return [];
      await client.query(`SELECT pg_advisory_lock(${lock})`, [db.schema ? db.schema : 7101]);
    }
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
