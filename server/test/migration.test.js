/* SQLite → PostgreSQL data migration: IDs, display IDs, history order, junctions preserved; counts + orphan validation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from './helpers.js';
import { migrateData, validate, TABLES } from '../../scripts/migrate-sqlite-to-postgres.js';
import { createApp } from '../app.js';

const legacy = readFileSync(new URL('../../docs/schema.sqlite.legacy.sql', import.meta.url), 'utf8');

function buildLegacySqlite() {
  const file = join(mkdtempSync(join(tmpdir(), 'relai-mig-')), 'legacy.db');
  const s = new DatabaseSync(file); s.exec(legacy);
  const T = '2026-09-01T00:00:00.000Z';
  s.exec(`
    INSERT INTO users (id,email,name,password_hash,created_at) VALUES ('u1','a@x.com','A','scrypt$16384$c2FsdA==$aGFzaA==','${T}'),('u2','b@x.com','B','x','${T}');
    INSERT INTO workspaces (id,name,owner_id,created_at) VALUES ('w1','W','u1','${T}');
    INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES ('w1','u1','OWNER','${T}'),('w1','u2','MEMBER','${T}');
    INSERT INTO projects (id,workspace_id,name,project_type,current_situation,status,planned_start_date,planned_end_date,current_phase,created_by,created_at,updated_at)
      VALUES ('p1','w1','Legacy','SI','IN_PROGRESS','ACTIVE','2026-09-01','2027-03-31','EXECUTION','u1','${T}','${T}');
    INSERT INTO project_phases (id,project_id,template_key,phase_key,name,sequence,status,created_at,updated_at) VALUES ('ph1','p1','default','INITIATION','착수',1,'COMPLETED','${T}','${T}'),('ph4','p1','default','EXECUTION','실행',4,'IN_PROGRESS','${T}','${T}');
    INSERT INTO project_steps (id,project_phase_id,step_key,title,sequence,status,created_at,updated_at) VALUES ('st1','ph1','GOALS','목표',1,'COMPLETED','${T}','${T}');
    INSERT INTO phase_transitions (id,project_id,from_phase_id,to_phase_id,reason,changed_by,changed_at) VALUES ('t1','p1',NULL,'ph1','PROJECT_CREATED','u1','${T}'),('t2','p1','ph1','ph4','MANUAL','u1','2026-09-02T00:00:00.000Z');
    INSERT INTO project_counters VALUES ('p1','REQ',2),('p1','CR',1),('p1','ISS',1),('p1','RSK',1),('p1','TC',1),('p1','ACC',1);
    INSERT INTO requirements (id,project_id,sequence_number,display_id,title,scope,status,owner_user_id,created_by,created_at,updated_at) VALUES ('r1','p1',1,'REQ-001','SSO','IN_SCOPE','CONFIRMED','u2','u1','${T}','${T}'),('r2','p1',2,'REQ-002','Archived','IN_SCOPE','DRAFT',NULL,'u1','${T}','${T}');
    UPDATE requirements SET archived_at='2026-09-03T00:00:00.000Z' WHERE id='r2';
    INSERT INTO requirement_criteria (id,requirement_id,content,sequence) VALUES ('c1','r1','로그인 성공',1);
    INSERT INTO change_requests (id,project_id,sequence_number,display_id,title,status,requested_at,created_by,created_at,updated_at) VALUES ('cr1','p1',1,'CR-001','MFA','APPROVED','2026-09-05','u1','${T}','${T}');
    INSERT INTO requirement_history (id,requirement_id,action_type,field_name,old_value,new_value,changed_by,changed_at,source_change_request_id) VALUES
      ('h1','r1','CREATED',NULL,NULL,NULL,'u1','${T}',NULL),('h2','r1','UPDATED','status','DRAFT','REVIEWING','u1','${T}',NULL),('h3','r1','UPDATED','status','REVIEWING','CONFIRMED','u1','${T}','cr1');
    INSERT INTO wbs_items (id,project_id,parent_id,sequence,wbs_code,item_type,title,status,progress,planned_start_date,planned_end_date,created_by,created_at,updated_at) VALUES
      ('w1','p1',NULL,1,'1','SUMMARY','설계','IN_PROGRESS',0,NULL,NULL,'u1','${T}','${T}'),('w2','p1','w1',1,'1.1','TASK','로그인','IN_PROGRESS',40,'2026-09-01','2026-09-20','u1','${T}','${T}'),('w3','p1',NULL,2,'2','MILESTONE','오픈','NOT_STARTED',0,NULL,NULL,'u1','${T}','${T}');
    UPDATE wbs_items SET milestone_date='2026-10-30' WHERE id='w3';
    INSERT INTO wbs_dependencies (id,project_id,predecessor_id,successor_id) VALUES ('d1','p1','w2','w3');
    INSERT INTO requirement_wbs_links (id,project_id,requirement_id,wbs_item_id,link_type) VALUES ('l1','p1','r1','w2','IMPLEMENTS');
    INSERT INTO change_request_requirements (id,change_request_id,requirement_id) VALUES ('crr1','cr1','r1');
    INSERT INTO change_request_wbs_impacts (id,change_request_id,wbs_item_id,impact_type) VALUES ('crw1','cr1','w2','REWORK');
    INSERT INTO change_request_history (id,change_request_id,action_type,changed_by,changed_at) VALUES ('ch1','cr1','CREATED','u1','${T}'),('ch2','cr1','STATUS_CHANGED','u1','${T}');
    INSERT INTO risks (id,project_id,sequence_number,display_id,title,probability,impact,risk_level,status,review_date,created_by,created_at,updated_at) VALUES ('k1','p1',1,'RSK-001','데이터 품질','HIGH','HIGH','CRITICAL','OPEN','2026-10-10','u1','${T}','${T}');
    INSERT INTO issues (id,project_id,sequence_number,display_id,title,status,severity,due_date,source_risk_id,created_by,created_at,updated_at) VALUES ('i1','p1',1,'ISS-001','API 미제공','OPEN','CRITICAL','2026-09-15','k1','u1','${T}','${T}');
    INSERT INTO raid_links (id,project_id,source_type,source_id,target_type,target_id) VALUES ('rl1','p1','ISSUE','i1','WBS','w2'),('rl2','p1','RISK','k1','REQUIREMENT','r1');
    INSERT INTO raid_history (id,entity_type,entity_id,action_type,changed_by,changed_at) VALUES ('rh1','ISSUE','i1','CREATED','u1','${T}'),('rh2','RISK','k1','CREATED','u1','${T}');
    INSERT INTO test_cases (id,project_id,sequence_number,display_id,title,steps,status,created_by,created_at,updated_at) VALUES ('tc1','p1',1,'TC-001','로그인 정상','[{"instruction":"입력","expected":"성공"}]','READY','u1','${T}','${T}');
    INSERT INTO test_executions (id,test_case_id,execution_number,result,executed_by,executed_at) VALUES ('ex1','tc1',1,'FAIL','u1','${T}');
    UPDATE issues SET source_test_execution_id='ex1' WHERE id='i1';
    INSERT INTO test_links (id,project_id,test_case_id,target_type,target_id) VALUES ('tl1','p1','tc1','REQUIREMENT','r1'),('tl2','p1','tc1','WBS','w2');
    INSERT INTO acceptances (id,project_id,sequence_number,display_id,title,status,requested_at,due_date,created_by,created_at,updated_at) VALUES ('a1','p1',1,'ACC-001','1차 검수','REQUESTED','${T}','2026-10-10','u1','${T}','${T}');
    INSERT INTO acceptance_links (id,project_id,acceptance_id,target_type,target_id) VALUES ('al1','p1','a1','REQUIREMENT','r1'),('al2','p1','a1','TEST','tc1');
    INSERT INTO qa_history (id,entity_type,entity_id,action_type,changed_by,changed_at) VALUES ('q1','TEST','tc1','CREATED','u1','${T}'),('q2','ACCEPTANCE','a1','STATUS_CHANGED','u1','${T}');
    INSERT INTO weekly_reports (id,project_id,period_start,period_end,title,status,structured_content,rendered_content,generated_at,created_by,created_at,updated_at)
      VALUES ('wr1','p1','2026-09-28','2026-10-02','주간보고','FINAL','{"period":{"start":"2026-09-28","end":"2026-10-02"},"data":{},"sections":[{"key":"status","title":"프로젝트 현황","body":"- ok"}]}','# 주간보고','${T}','u1','${T}','${T}');
    UPDATE weekly_reports SET finalized_at='2026-10-02T09:00:00.000Z' WHERE id='wr1';
    INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ('abc','u1','2099-01-01T00:00:00.000Z');`);
  s.close();
  return file;
}

test('SQLite → PostgreSQL migration: every table copied with identical counts, IDs and display IDs kept, history order kept, validation finds no orphans, app serves the data', async () => {
  const file = buildLegacySqlite();
  const pg = await testDb();
  const logs = [];
  const r = await migrateData(file, pg, { log: (l) => logs.push(l) });
  assert.equal(r.ok, true, logs.join('\n'));
  for (const t of TABLES) assert.equal(r.after.counts[t], r.before[t], t);
  assert.deepEqual(r.after.orphans, []);
  // identity preserved
  assert.deepEqual((await pg.all("SELECT display_id FROM requirements ORDER BY sequence_number")).map((x) => x.display_id), ['REQ-001', 'REQ-002']);
  assert.equal((await pg.get("SELECT value FROM project_counters WHERE project_id = 'p1' AND key = 'REQ'")).value, 2);
  // types converted: timestamptz → ISO, date → YYYY-MM-DD, archived_at kept
  const req = await pg.get("SELECT created_at, archived_at FROM requirements WHERE id = 'r2'"); assert.equal(req.created_at, '2026-09-01T00:00:00.000Z'); assert.equal(req.archived_at, '2026-09-03T00:00:00.000Z');
  assert.equal((await pg.get("SELECT planned_end_date FROM wbs_items WHERE id = 'w2'")).planned_end_date, '2026-09-20');
  // history order reproduced via seq (same changed_at on all three rows)
  assert.deepEqual((await pg.all("SELECT id FROM requirement_history WHERE requirement_id = 'r1' ORDER BY seq")).map((x) => x.id), ['h1', 'h2', 'h3']);
  assert.equal((await pg.get("SELECT source_change_request_id FROM requirement_history WHERE id = 'h3'")).source_change_request_id, 'cr1');
  // new history rows continue after the migrated ones
  await pg.run("INSERT INTO requirement_history (id, requirement_id, action_type, changed_by) VALUES ('h4','r1','ARCHIVED','u1')");
  assert.ok((await pg.get("SELECT seq FROM requirement_history WHERE id = 'h4'")).seq > (await pg.get("SELECT seq FROM requirement_history WHERE id = 'h3'")).seq);
  // running again against a non-empty target refuses unless --truncate; truncate path yields the same result
  await assert.rejects(() => migrateData(file, pg, { log() {} }), /not empty/);
  const r2 = await migrateData(file, pg, { truncate: true, log() {} }); assert.equal(r2.ok, true);
  // the migrated data serves the API: requirement detail with history + source CR, issue with source risk/test, snapshot
  const server = createApp(pg).listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const u = await pg.get("SELECT id FROM users WHERE id = 'u1'"); assert.ok(u);
  await pg.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'u1', '2099-01-01T00:00:00Z')", [(await import('../security.js')).sha256('tok')]);
  const get = async (p) => { const res = await fetch(base + p, { headers: { cookie: 'relai_sid=tok' } }); return { status: res.status, json: await res.json() }; };
  const detail = await get('/api/workspaces/w1/projects/p1/requirements/r1'); assert.equal(detail.status, 200);
  assert.equal(detail.json.requirement.history[0].id, 'h3'); assert.equal(detail.json.requirement.history[0].source_change_display_id, 'CR-001'); assert.equal(detail.json.requirement.links.length, 1);
  const issue = await get('/api/workspaces/w1/projects/p1/issues/i1'); assert.equal(issue.json.issue.source_risk_display_id, 'RSK-001'); assert.equal(issue.json.issue.source_test_label, 'TC-001 #1');
  const snap = await get('/api/workspaces/w1/projects/p1/snapshot'); assert.equal(snap.status, 200); assert.equal(snap.json.health.status, 'CRITICAL'); assert.ok(snap.json.attention_total >= 3);
  const rep = await get('/api/workspaces/w1/projects/p1/weekly-reports/wr1'); assert.equal(rep.json.report.status, 'FINAL'); assert.equal(rep.json.report.structured_content.sections[0].body, '- ok');
  server.close();
  // standalone validator
  const v = await validate(pg); assert.equal(v.counts.requirements, 2); assert.deepEqual(v.orphans, []);
});
