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
import { PHASE_BY_KEY, ANALYSIS_DESIGN_DESCRIPTION, ANALYSIS_DESIGN_DESCRIPTION_V1, TEST_PLAN_TITLE, TEST_PLAN_DESCRIPTION, TEST_PLAN_CRITERIA, ACCEPTANCE_DESCRIPTION, ACCEPTANCE_CRITERIA, ACCEPTANCE_DESCRIPTION_V1, ACCEPTANCE_TITLE, ACCEPTANCE_TITLE_V1, TRANSITION_DESCRIPTION, TRANSITION_DESCRIPTION_V1, CHECK_STEP_COPY,
  OPERATIONS_DESCRIPTION, HANDOVER_CRITERIA, MAINTENANCE_DESCRIPTION, SLA_DESCRIPTION, RELEASE_PLAN_DESCRIPTION, CLOSE_DESCRIPTION, CLOSE_CRITERIA, LESSONS_ITEM_V1, LESSONS_ITEM } from './templates/default-phases.js';

/** Migration 39 (K32): note left on a legacy hand-✓ step that was reset because its record is missing. */
export const LEGACY_RESET_NOTE = '예전 완료 표시에 기록(승인·오픈일·인수자·완료보고서)이 없어 다시 진행 중으로 바꿨습니다. 기록을 남기면 완료됩니다.';

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
    // 최초 종료일: projects already at/after 04 take the end date as it stood when 04 began (first entry into DEVELOPMENT — or into any
    // later phase when 04 was skipped): the old value of the first planned_end_date / milestone_date change after that entry, else the
    // last change recorded before it, else the current value (never changed). Creation is a CREATED row without a value, so an item
    // dated in 03 and first pushed in 04 is only recoverable from the first post-04 UPDATED row's old value.
    // Projects before 04 stay NULL: the value is frozen when they enter 04 (guide.js transitionTo).
    const entry = `(SELECT MIN(t.changed_at) FROM phase_transitions t JOIN project_phases ph ON ph.id = t.to_phase_id
            WHERE t.project_id = w.project_id AND ph.sequence >= (SELECT sequence FROM project_phases d WHERE d.project_id = w.project_id AND d.phase_key = 'DEVELOPMENT'))`;
    const dateRows = `FROM wbs_history h WHERE h.wbs_item_id = w.id AND h.action_type = 'UPDATED'
          AND h.field_name = CASE WHEN w.item_type = 'MILESTONE' THEN 'milestone_date' ELSE 'planned_end_date' END`;
    await db.run(`UPDATE wbs_items w SET original_planned_end_date = COALESCE(
        (SELECT (h.old_value)::date ${dateRows} AND h.old_value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.changed_at > ${entry}
          ORDER BY h.changed_at ASC, h.seq ASC LIMIT 1),
        (SELECT (h.new_value)::date ${dateRows} AND h.new_value ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.changed_at <= ${entry}
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
  { version: 36, name: 'Phase 5 시험: requirements.test_exclusion_reason, test_executions.performer_* / performed_on (schema.sql) + 05 TEST_PLAN → 필수 \'요구사항별 테스트 준비\' + WEEKLY_REPORT (주간보고 작성·공유) added to every project\'s 05 right after DEFECTS as TODO', async up(db) {
    await db.run(`UPDATE project_steps SET is_required = 1, importance = 'REQUIRED', title = ?, description = ?, completion_criteria = ?, updated_at = now()
      WHERE step_key = 'TEST_PLAN' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TESTING')`, [TEST_PLAN_TITLE, TEST_PLAN_DESCRIPTION, TEST_PLAN_CRITERIA]);
    const tp = PHASE_BY_KEY.TESTING.steps; const st = tp.find((x) => x.key === 'WEEKLY_REPORT'); const df = tp.find((x) => x.key === 'DEFECTS');
    await db.run(`UPDATE project_steps SET description = ?, completion_criteria = ?, updated_at = now() WHERE step_key = 'DEFECTS' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TESTING')`, [df.description, df.completion_criteria]);
    await db.run(`UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = 'RUN' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TESTING')`, [tp.find((x) => x.key === 'RUN').description]);
    for (const ph of await db.all(`SELECT id FROM project_phases WHERE phase_key = 'TESTING'`)) {
      if (await db.get(`SELECT 1 FROM project_steps WHERE project_phase_id = ? AND step_key = 'WEEKLY_REPORT'`, [ph.id])) continue;
      const d = await db.get(`SELECT sequence FROM project_steps WHERE project_phase_id = ? AND step_key = 'DEFECTS'`, [ph.id]);
      const seq = d ? Number(d.sequence) + 1 : Number((await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM project_steps WHERE project_phase_id = ?', [ph.id])).n);
      await db.run('UPDATE project_steps SET sequence = sequence + 1 WHERE project_phase_id = ? AND sequence >= ?', [ph.id, seq]);
      await db.run(`INSERT INTO project_steps (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, now(), now())`, [randomUUID(), ph.id, st.key, st.title, st.description, st.completion_criteria, seq, 0, st.importance, st.linked_feature_type]);
    }
  } },
  { version: 37, name: 'Phase 6 전환 및 오픈: acceptances.customer_approval, project_definitions.go_live, activity_checklist_items.owner_user_id / owner_stakeholder_id (schema.sql) + 06 ACCEPTANCE 설명·완료 기준 (범위 전체 검수) + WEEKLY_REPORT (주간보고 작성·공유) added to every project\'s 06 right before GO_LIVE as TODO + stored old copy (Go-Live → 오픈, Issue/Fail → 이슈/실패) refreshed unless PM-edited', async up(db) {
    await db.run(`UPDATE project_steps SET description = ?, completion_criteria = ?, updated_at = now()
      WHERE step_key = 'ACCEPTANCE' AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TRANSITION_GO_LIVE')`, [ACCEPTANCE_DESCRIPTION, ACCEPTANCE_CRITERIA]);
    // Acceptance MUST (J-A3 rule): stored old English copy → Korean, only where it still equals the old template text (PM-edited text stays).
    const gl = PHASE_BY_KEY.TRANSITION_GO_LIVE.steps.find((x) => x.key === 'GO_LIVE'); const is = PHASE_BY_KEY.DEVELOPMENT.steps.find((x) => x.key === 'ISSUES');
    const inPhase = (k) => `project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = '${k}')`;
    await db.run(`UPDATE project_steps SET title = ?, updated_at = now() WHERE step_key = 'GO_LIVE' AND title = 'Go-Live' AND ${inPhase('TRANSITION_GO_LIVE')}`, [gl.title]);
    await db.run(`UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = 'GO_LIVE' AND description IN (?, ?) AND ${inPhase('TRANSITION_GO_LIVE')}`,
      [gl.description, '계획한 시점에 서비스를 오픈합니다. 오픈 전 열려 있는 Issue, Fail 테스트, 미반영 변경을 확인합니다.', '계획한 시점에 서비스를 오픈합니다. 오픈 전 열려 있는 이슈, 실패 테스트, 미반영 변경을 확인합니다.']);
    await db.run(`UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = 'ISSUES' AND description = '진행을 막거나 늦추는 문제를 Issue로 기록하고 처리합니다.' AND ${inPhase('DEVELOPMENT')}`, [is.description]);
    await db.run(`UPDATE project_steps SET completion_criteria = ?, updated_at = now() WHERE step_key = 'ISSUES' AND completion_criteria = '열려 있는 Issue가 없습니다.' AND ${inPhase('DEVELOPMENT')}`, [is.completion_criteria]);
    const st = PHASE_BY_KEY.TRANSITION_GO_LIVE.steps.find((x) => x.key === 'WEEKLY_REPORT');
    for (const ph of await db.all(`SELECT id FROM project_phases WHERE phase_key = 'TRANSITION_GO_LIVE'`)) {
      if (await db.get(`SELECT 1 FROM project_steps WHERE project_phase_id = ? AND step_key = 'WEEKLY_REPORT'`, [ph.id])) continue;
      const gl = await db.get(`SELECT sequence FROM project_steps WHERE project_phase_id = ? AND step_key = 'GO_LIVE'`, [ph.id]);
      const seq = gl ? Number(gl.sequence) : Number((await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM project_steps WHERE project_phase_id = ?', [ph.id])).n);
      await db.run('UPDATE project_steps SET sequence = sequence + 1 WHERE project_phase_id = ? AND sequence >= ?', [ph.id, seq]);
      await db.run(`INSERT INTO project_steps (id, project_phase_id, step_key, title, description, completion_criteria, sequence, is_required, importance, linked_feature_type, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, now(), now())`, [randomUUID(), ph.id, st.key, st.title, st.description, st.completion_criteria, seq, 0, st.importance, st.linked_feature_type]);
    }
  } },
  { version: 38, name: 'Phase 7 운영 및 유지보수: weekly_reports.report_type (+ 완료보고서 1건 unique index), projects.closed_on / warranty_end_on, project_definitions.handover (schema.sql) + 07 단계·업무 설명 (CLOSE = 완료보고서 확정, HANDOVER = 인수자·인수일, SLA·정기 배포 \'운영 계약이 있으면\') + 체크리스트 \'교훈(Lessons Learned) 정리\' → \'교훈 정리\'', async up(db) {
    const OPS = `project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'OPERATIONS')`;
    await db.run(`UPDATE project_phases SET description = ?, updated_at = now() WHERE phase_key = 'OPERATIONS'`, [OPERATIONS_DESCRIPTION]);
    await db.run(`UPDATE project_steps SET completion_criteria = ?, updated_at = now() WHERE step_key = 'HANDOVER' AND ${OPS}`, [HANDOVER_CRITERIA]);
    for (const [key, desc] of [['MAINTENANCE', MAINTENANCE_DESCRIPTION], ['SLA', SLA_DESCRIPTION], ['RELEASE_PLAN', RELEASE_PLAN_DESCRIPTION]])
      await db.run(`UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = ? AND ${OPS}`, [desc, key]);
    await db.run(`UPDATE project_steps SET description = ?, completion_criteria = ?, updated_at = now() WHERE step_key = 'CLOSE' AND ${OPS}`, [CLOSE_DESCRIPTION, CLOSE_CRITERIA]);
    // items the PM renamed keep their title (same rule as migration 34)
    await db.run(`UPDATE activity_checklist_items SET title = ?, updated_at = now() WHERE title = ?`, [LESSONS_ITEM, LESSONS_ITEM_V1]);
  } },
  { version: 39, name: 'Polish K32: legacy hand-✓ on 06 ACCEPTANCE / GO_LIVE and 07 HANDOVER / CLOSE with no backing record (승인된 검수 · 오픈 기록 · 인수 기록 · 확정 완료보고서 / 외부 완료보고서 사유) → back to TODO, on projects that are not COMPLETED; COMPLETED projects and history untouched', async up(db) {
    const steps = (phase, key) => `step_key = '${key}' AND status = 'COMPLETED' AND project_phase_id IN (SELECT ph.id FROM project_phases ph JOIN projects p ON p.id = ph.project_id WHERE ph.phase_key = '${phase}' AND p.status <> 'COMPLETED'`;
    const pidOf = '(SELECT project_id FROM project_phases WHERE id = project_steps.project_phase_id)';
    const rec = (col) => `(SELECT 1 FROM project_definitions d WHERE d.project_id = ${pidOf} AND COALESCE(NULLIF(d.${col}, ''), '{}')::jsonb ->> 'date' IS NOT NULL)`;
    const reset = (where) => db.run(`UPDATE project_steps SET status = 'TODO', completed_at = NULL, completed_by = NULL,
      note = CASE WHEN COALESCE(note, '') = '' THEN ? ELSE note || E'\n' || ? END, updated_at = now() WHERE ${where}`, [LEGACY_RESET_NOTE, LEGACY_RESET_NOTE]);   // Q17-3: a PM memo is kept, the reason goes on a new line
    await reset(`${steps('TRANSITION_GO_LIVE', 'ACCEPTANCE')}) AND NOT EXISTS (SELECT 1 FROM acceptances a WHERE a.project_id = ${pidOf} AND a.status = 'ACCEPTED' AND a.archived_at IS NULL AND COALESCE(NULLIF(a.customer_approval, ''), '{}') <> '{}')`);
    await reset(`${steps('TRANSITION_GO_LIVE', 'GO_LIVE')}) AND NOT EXISTS ${rec('go_live')}`);
    await reset(`${steps('OPERATIONS', 'HANDOVER')}) AND NOT EXISTS ${rec('handover')}`);
    await reset(`${steps('OPERATIONS', 'CLOSE')}) AND note NOT LIKE '%[외부 완료보고서]%' AND NOT EXISTS (SELECT 1 FROM weekly_reports w WHERE w.project_id = ${pidOf} AND w.report_type = 'COMPLETION' AND w.status = 'FINAL')`);
  } },
  { version: 40, name: 'B9 signup consent: users.terms_agreed_at/terms_version/privacy_agreed_at/privacy_version + auth_oauth_states.consent — DDL in schema.sql', up() {} },
  { version: 41, name: 'AI-credits-only billing: workspaces.early_access_until (+ 30/7-day notice stamps), billing_orders CREDIT_PACK (credits, refunded_amount/credits, receipt_url), credit_ledger PURCHASE, low_balance_notified_at (schema.sql) + backfill early access = max(created_at, launch) + 12 months for workspaces created before the cut-off + starter credits topped up to 500 once', async up(db) {
    const [{ grantEarlyAccess }, { topUpStarterCredits }] = await Promise.all([import('./billing/subscriptions.js'), import('./ai/credits.js')]);
    await grantEarlyAccess(db);
    await topUpStarterCredits(db);
  } },
  { version: 42, name: 'Sample projects: projects.sample_key (schema.sql) — example projects for new users, excluded from usage and plan limits', up() {} },
  { version: 43, name: 'Jira requirement links: integration_entity_links.requirement_id + link_role REQUIREMENT (wbs_item_id nullable), WBS-only unique index, integration_project_mappings.auto_mark_requirements, requirements.jira_done_at (columns/indexes in schema.sql)', async up(db) {
    await db.run('ALTER TABLE integration_entity_links DROP CONSTRAINT IF EXISTS integration_entity_links_link_role_check');
    await db.run(`ALTER TABLE integration_entity_links ADD CONSTRAINT integration_entity_links_link_role_check CHECK (link_role IN ('EXECUTION','EPIC','REQUIREMENT'))`);
    await db.run('DROP INDEX IF EXISTS uq_iel_external_live');   // replaced by uq_iel_external_live_wbs (schema.sql)
  } },
  { version: 44, name: 'v1 fixes: comments.author_label (schema.sql) — sample comments show 샘플, not the user who received the samples', up() {} },
  { version: 46, name: 'Product analytics: analytics_events (+ once-per-user milestone index) and analytics_active_days — first-party, ids only (schema.sql)', up() {} },
  { version: 47, name: 'Promotions: promotions table + launch-offer seed (schema.sql) — display only, edited in 관리자 › 프로모션', up() {} },
  { version: 48, name: 'In-app feedback: feedback table (schema.sql) — 의견 남기기 in the app rail, triaged in 관리자 › 의견', up() {} },
  { version: 49, name: 'batch7 T2: project_definitions.environments + deliverable_catalog (seeded) / project_deliverables (schema.sql); open 01 APPROVAL steps → RECOMMENDED; seed promotion copy without ₩', async up(db) {
    // 착수 결과 승인 is 권장 now (APPROVAL_IMPORTANCE). Completed ones keep their record untouched; live code reads importance from the row.
    await db.run(`UPDATE project_steps SET importance = 'RECOMMENDED', is_required = 0, updated_at = now() WHERE step_key = 'APPROVAL' AND status <> 'COMPLETED' AND importance = 'REQUIRED'
      AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'INITIATION')`);
    // #7: the launch-offer seed rows (migration 47) spoke in won. Only rows the operator never edited are rewritten.
    for (const [id, from, to] of PROMO_COPY_49) await db.run('UPDATE promotions SET body = ?, updated_at = now() WHERE id = ? AND body = ?', [to, id, from]);
  } },
  { version: 50, name: 'batch7 T3: wbs_items.system_key + uq_wbs_system_key (WBS 고정 최상위 뼈대), public_holidays + 2026–2027 seed (schema.sql) — additive; existing projects get their fixed nodes when the WBS is first opened', up() {} },
  { version: 51, name: 'Batch7 T4: requirements.owner_stakeholder_id, test_executions.step_results, test_cases.test_data + environment (schema.sql, additive)', up() {} },
  { version: 52, name: 'Batch7 T5 plan limits + paywall: 500 free AI credits once per WORKSPACE — accounts that never got a starter grant are topped up to a 500 balance (credit_ledger PROMOTION STARTER_WORKSPACE_52, idempotent, additive). Early access → FREE limits is code only; no rows changed or deleted', async up(db) {
    const { grantMissingWorkspaceStarter } = await import('./ai/credits.js');
    await grantMissingWorkspaceStarter(db);
  } },
  { version: 53, name: 'Early access retired for everyone (founder 2026-10-20): seeded promotions that promise 12개월 무료 / 얼리 액세스 get Free-plan copy, the {until} rows (promo-home, promo-credits) are deactivated — only rows an operator never edited; data update only, nothing deleted', async up(db) {
    for (const [id, from, to] of PROMO_COPY_53) {
      await db.run('UPDATE promotions SET title = ?, body = ?, badge = ?, updated_at = now() WHERE id = ? AND title = ? AND body = ANY(?::text[]) AND badge IS NOT DISTINCT FROM ?',
        [to.title, to.body, to.badge, id, from.title, from.bodies, from.badge]);
    }
    for (const [id, title] of PROMO_OFF_53) await db.run('UPDATE promotions SET active = false, updated_at = now() WHERE id = ? AND title = ? AND active', [id, title]);
  } },
  { version: 54, name: 'RELAI service payments: service_orders (standalone /pricing page; buyer info, server-side catalogue amount; schema.sql, additive)', up() {} },
  { version: 55, name: "service_orders.status may be APPROVING (the return handler claims an order before approving; payment review P1-2; additive, widens the CHECK)", async up(db) {
    await db.run('ALTER TABLE service_orders DROP CONSTRAINT IF EXISTS service_orders_status_check');
    await db.run(`ALTER TABLE service_orders ADD CONSTRAINT service_orders_status_check CHECK (status IN ('PENDING','APPROVING','PAID','FAILED','REFUNDED'))`);
  } },
  { version: 56, name: '회원 탈퇴 = users row deleted (founder 2026-10-20): author columns nullable, withdrawn_actor / withdrawn_ref / billing_orders buyer fields, account_withdrawals (schema.sql, additive); data: every DEACTIVATED tombstone is hard-deleted by the same hardDeleteUser() as self-service withdrawal (idempotent: none left → nothing to do)', async up(db) {
    const { hardDeleteDeactivated } = await import('./auth/user-delete.js');
    await hardDeleteDeactivated(db);
  } },
  { version: 57, name: "Pricing v3 T1: subscriptions.plan accepts FREE/PRO/TEAM/ENTERPRISE; subscriptions extra_users / extra_projects / project_limit / price_version / renewal_amount / retry_count / over_limit_since; billing_orders kinds ADDON / UPGRADE / CREDIT_TOPUP + addon_* / period_* / client_key / refund_tid_seq / price_version (schema.sql, additive). Paid rows bought before v3 are marked price_version 'v2' so they keep what they bought until their period ends; nothing else changes", async up(db) {
    await db.run(`UPDATE subscriptions SET price_version = 'v2' WHERE price_version IS NULL AND plan <> 'FREE'`);
    await db.run(`UPDATE billing_orders SET price_version = 'v2' WHERE price_version IS NULL AND kind IN ('ONE_TIME','RECURRING_FIRST','RECURRING_RENEWAL')`);
  } },
  { version: 61, name: 'Pricing v3 T1: idx_projects_ws_active (active = DRAFT/ACTIVE/ON_HOLD, samples excluded; schema.sql, index only)', up() {} },
  { version: 62, name: 'Pricing v3 T2: AI credit buckets (workspace_credit_accounts plan / promo / purchased + plan_expires_at, credit_ledger d_* + type EXPIRY), free_credit_claims, workspaces.enterprise_topup (schema.sql, additive). Data: balances split without changing any total (purchased = unused purchased, rest = promo, plan = 0); owners who already got a starter grant are recorded as Free-claimed. Idempotent', async up(db) {
    const { backfillCreditBuckets } = await import('./ai/credits.js');
    await backfillCreditBuckets(db);
  } },
  { version: 63, name: 'Pricing v3 T3: subscription_changes (scheduled downgrade / cycle / add-on reduction at renewal), subscription_refunds (해지 환불 · 청약철회, unused days prorated, no penalty), subscriptions ended_at / data_retention_until / last_failed_at (schema.sql, additive)', up() {} },
  { version: 64, name: 'Pricing v3 T3: billing_consents (정기결제 · 추가 구매 · 증액 동의, disclosure hash, append-only) and price_change_notices (schema.sql, additive). Data: the seeded launch promotions still on v2 copy (프로젝트 2개, 크레딧 500, 월 기본료 없이) get v3 copy (Free 1 project · 3 users · 100 credits once, Pro 1,000 / Team 3,000 a month) — only rows an operator never edited; nothing deleted', async up(db) {
    for (const [id, from, to] of PROMO_COPY_64) {
      await db.run('UPDATE promotions SET title = ?, body = ?, badge = ?, updated_at = now() WHERE id = ? AND title = ? AND body = ?', [to.title, to.body, to.badge, id, from.title, from.body]);
    }
  } },
  { version: 65, name: 'Personal-data retention (relai-retention-legal.md G-1..G-6, G-8): users.inactive_notice_at (1-year inactivity notice), admin_access_logs (operator access log, 안전성 확보조치 기준 §8), purge indexes (schema.sql, additive; nothing deleted by the migration — the daily purge does it)', up() {} },
  { version: 66, name: 'Free starter credits 100 → 200 (founder 2026-10-21 "200으로 올리고 다른 메시지도 모두 200으로 통일"): the seeded v3 promotions that say AI 크레딧 100 get 200 — only rows an operator never edited; data update only, nothing deleted. Existing credit balances are not changed', async up(db) {
    for (const [id, from, to] of PROMO_COPY_66) {
      await db.run('UPDATE promotions SET title = ?, body = ?, updated_at = now() WHERE id = ? AND title = ? AND body = ?', [to.title, to.body, id, from.title, from.body]);
    }
  } },
  { version: 67, name: 'Integrity: ai_runs.request_hash (identical AI request while one is PENDING → 409, no double charge) (schema.sql, additive, nullable; nothing rewritten)', up() {} },
  { version: 68, name: 'Prompt admin: ai_prompts (operator overrides of the AI prompts; no row = code default) + ai_prompt_versions (history) (schema.sql, additive; nothing rewritten)', up() {} },
  { version: 69, name: 'No approvals (founder 2026-10-21): 01 APPROVAL / 02 BASELINE_APPROVAL become 진행 여부 체크 (권장) — seeded title/description/criteria rewritten unless PM-edited, open BASELINE_APPROVAL → RECOMMENDED; 06 ACCEPTANCE + phase copy without 인수 승인. Data only, no schema change', async up(db) {
    for (const [key, from, to] of CHECK_STEP_COPY) {
      await db.run('UPDATE project_steps SET title = ?, updated_at = now() WHERE step_key = ? AND title = ?', [to.title, key, from.title]);
      await db.run('UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = ? AND description = ?', [to.description, key, from.description]);
      await db.run('UPDATE project_steps SET completion_criteria = ?, updated_at = now() WHERE step_key = ? AND completion_criteria = ?', [to.criteria, key, from.criteria]);
    }
    await db.run(`UPDATE project_steps SET importance = 'RECOMMENDED', is_required = 0, updated_at = now() WHERE step_key = 'BASELINE_APPROVAL' AND importance = 'REQUIRED'
      AND project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'REQUIREMENTS')`);
    const acc = `project_phase_id IN (SELECT id FROM project_phases WHERE phase_key = 'TRANSITION_GO_LIVE')`;
    await db.run(`UPDATE project_steps SET title = ?, updated_at = now() WHERE step_key = 'ACCEPTANCE' AND title = ? AND ${acc}`, [ACCEPTANCE_TITLE, ACCEPTANCE_TITLE_V1]);
    await db.run(`UPDATE project_steps SET description = ?, updated_at = now() WHERE step_key = 'ACCEPTANCE' AND description = ? AND ${acc}`, [ACCEPTANCE_DESCRIPTION, ACCEPTANCE_DESCRIPTION_V1]);
    await db.run(`UPDATE project_phases SET description = ?, updated_at = now() WHERE phase_key = 'TRANSITION_GO_LIVE' AND description = ?`, [TRANSITION_DESCRIPTION, TRANSITION_DESCRIPTION_V1]);
  } },
  { version: 70, name: 'Integrity: billing_orders.charge_claimed_at — one charge per order (concurrent add-on / upgrade / first subscription with the same client_key, or a replayed payment-window return, charged the card twice) (schema.sql, additive, nullable; nothing rewritten)', up() {} },
];

/** Migration 49: launch-offer promotion bodies [id, seeded text, text without ₩] — credits are a usage unit on every user screen (batch7 #7). */
const PROMO_COPY_49 = [
  ['promo-ai-credits', '₩5,000 상당. 요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다.', '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다.'],
  ['promo-ai-payg', '1 크레딧 = ₩10 (부가세 포함). 월 기본료 없이 쓴 만큼만 냅니다.', '월 기본료 없이 쓴 만큼만 크레딧이 차감됩니다.'],
  ['promo-login', 'AI 크레딧 500 (₩5,000)도 함께 드립니다.', 'AI 크레딧 500도 함께 드립니다.'],
  ['promo-credits', 'AI는 쓴 만큼만 크레딧으로 냅니다 (1 크레딧 = ₩10).', 'AI는 쓴 만큼만 크레딧이 차감됩니다.'],
];

/** Migration 53: [id, seeded {title, bodies (before/after 49), badge}, Free-plan copy] and the {until} rows to switch off ([id, seeded title]). */
const PROMO_COPY_53 = [
  ['promo-early-access', { title: '12개월 동안 전체 기능 무료', bodies: ['가입한 날부터 12개월 동안 RELAI의 모든 기능을 요금 없이 씁니다.'], badge: '얼리 액세스' },
    { title: '무료 플랜으로 시작', body: '프로젝트 2개까지 결제 정보 없이 바로 씁니다.', badge: '무료 플랜' }],
  ['promo-login', { title: '지금 가입하면 12개월 무료', bodies: ['AI 크레딧 500도 함께 드립니다.', 'AI 크레딧 500 (₩5,000)도 함께 드립니다.'], badge: '얼리 액세스' },
    { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 500도 함께 드립니다.', badge: '무료 플랜' }],
];
const PROMO_OFF_53 = [['promo-home', '얼리 액세스 {until}까지 무료'], ['promo-credits', '{until}까지 RELAI 전체 기능 무료']];

/** Migration 64: [id, seeded v2 copy { title, body } (after 49/53), v3 copy] — pricing v3 (Free 100 once; Pro 1,000 / Team 3,000 a month). */
const PROMO_COPY_64 = [
  ['promo-early-access', { title: '무료 플랜으로 시작', body: '프로젝트 2개까지 결제 정보 없이 바로 씁니다.' },
    { title: '무료 플랜으로 시작', body: '활성 프로젝트 1개, 사용자 3명까지 결제 정보 없이 바로 씁니다.', badge: '무료 플랜' }],
  ['promo-ai-credits', { title: '가입하면 AI 크레딧 500 무료', body: '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다.' },
    { title: '가입하면 AI 크레딧 100 무료', body: '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다. 처음 한 번 드립니다.', badge: 'AI 크레딧' }],
  ['promo-ai-payg', { title: '이후 AI는 쓴 만큼만', body: '월 기본료 없이 쓴 만큼만 크레딧이 차감됩니다.' },
    { title: 'Pro · Team은 매월 AI 크레딧', body: 'Pro는 매월 1,000, Team은 매월 3,000 크레딧을 드립니다. 모자라면 충전해서 씁니다.', badge: '유료 플랜' }],
  ['promo-login', { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 500도 함께 드립니다.' },
    { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 100도 함께 드립니다.', badge: '무료 플랜' }],
];

/** Migration 66: [id, v3 copy after 64, copy with the Free starter at 200]. */
const PROMO_COPY_66 = [
  ['promo-ai-credits', { title: '가입하면 AI 크레딧 100 무료', body: '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다. 처음 한 번 드립니다.' },
    { title: '가입하면 AI 크레딧 200 무료', body: '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다. 처음 한 번 드립니다.' }],
  ['promo-login', { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 100도 함께 드립니다.' },
    { title: '지금 가입하면 무료 플랜으로 시작', body: 'AI 크레딧 200도 함께 드립니다.' }],
];

export const LATEST_VERSION = migrations[migrations.length - 1].version;

/** Apply schema.sql, then any `up()` newer than the recorded version. Serialized with an advisory lock so two app instances starting together cannot race. */
export async function migrate(db, schemaSql, bindClient) {
  const lock = db.schema ? 'hashtext($1)' : '$1::int';
  const client = await db.pool.connect();
  const upToDate = async () => { try { const r = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations'); return Number(r.rows[0].v) >= LATEST_VERSION; } catch { return false; } };
  try {
    if (await upToDate()) return [];   // nothing to apply → no lock needed (serverless instances boot without touching the lock)
    await client.query('SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0');   // a long data migration must not hit the serving timeout (openDb statementTimeoutMs)
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
    await client.query('RESET statement_timeout; RESET idle_in_transaction_session_timeout; RESET lock_timeout').catch(() => {});   // back to the connection's own limits before reuse
    client.release();
  }
}
