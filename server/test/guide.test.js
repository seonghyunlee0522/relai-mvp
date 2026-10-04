import { DEFAULT_PHASES } from '../templates/default-phases.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb, TEST_DATABASE_URL } from './helpers.js';
import { openDb, schemaSql, bindTx } from '../db.js';
import { migrate, LATEST_VERSION } from '../migrations.js';
import { createApp } from '../app.js';

async function boot(db = null) {
  db = db || await testDb();
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.clone().json(); } catch {}
      return { status: res.status, json };
    };
  };
  return { db, server, client };
}
const STEPS_PER_PROJECT = DEFAULT_PHASES.reduce((n, p) => n + p.steps.length, 0);
const project = (o = {}) => ({ name: 'P', project_type: 'SI', current_situation: 'NOT_STARTED', planned_start_date: '2026-11-01', planned_end_date: '2027-02-28', ...o });

async function userWithProject(client, email = 'u@x.com') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { name: 'n', email, password: 'passw0rd!' });
  const w = s.json.workspaces[0].id;
  const r = await c('POST', `/api/workspaces/${w}/projects`, project());
  return { c, w, p: r.json.project, url: `/api/workspaces/${w}/projects/${r.json.project.id}` };
}

test('new project (Lifecycle V2): 7 phases with importance-tagged activities, first phase current, history has creation entry', async () => {
  const { server, client } = await boot();
  const { c, url } = await userWithProject(client);
  const g = (await c('GET', url)).json;
  assert.equal(g.phases.length, 7);
  assert.deepEqual(g.phases.map((p) => p.phase_key), ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS']);
  assert.deepEqual(g.phases.map((p) => p.name), ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환 및 오픈', '운영 및 유지보수']);
  assert.ok(g.phases.every((p) => p.steps.length >= 5 && p.steps.every((s) => s.completion_criteria && ['REQUIRED', 'RECOMMENDED', 'OPTIONAL'].includes(s.importance) && ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'].includes(s.state))));
  assert.ok(g.phases.every((p) => p.steps.some((s) => s.importance === 'REQUIRED')), 'every phase has a REQUIRED gate');
  // 검수 / 인수 승인 is the first activity of 06 전환 및 오픈 (§6)
  const tr = g.phases.find((p) => p.phase_key === 'TRANSITION_GO_LIVE'); assert.equal(tr.steps[0].step_key, 'ACCEPTANCE'); assert.equal(tr.steps[0].title, '검수 / 인수 승인'); assert.equal(tr.steps[0].importance, 'REQUIRED');
  // summary is REQUIRED-based, never a percentage
  assert.deepEqual(Object.keys(g.phases[0].summary).sort(), ['completed', 'gate_met', 'required_done', 'required_open', 'required_total', 'skipped', 'total']);
  assert.ok(!('progress' in g) && !('progress' in g.phases[0]) && !('percent' in g.phases[0].summary));
  assert.equal(g.current_phase.phase_key, 'INITIATION');
  assert.equal(g.current_phase.status, 'IN_PROGRESS');
  assert.equal(g.phases[1].status, 'NOT_STARTED');
  assert.equal(g.next_phase.phase_key, 'REQUIREMENTS');
  assert.equal(g.history.length, 1); assert.equal(g.history[0].reason, 'PROJECT_CREATED'); assert.equal(g.history[0].from_key, null);
  server.close();
});

test('activity complete / skip / undo / note; derived state wins over stored marks; REQUIRED summary', async () => {
  const { server, client } = await boot();
  const { c, url } = await userWithProject(client);
  let g = (await c('GET', url)).json;
  const steps = g.phases[0].steps;
  for (const s of steps.slice(0, 3)) assert.equal((await c('PATCH', `${url}/steps/${s.id}`, { status: 'COMPLETED' })).status, 200);
  g = (await c('PATCH', `${url}/steps/${steps[0].id}`, { note: '  목표: 상담 자동화  ' })).json;
  assert.equal(g.step.note, '목표: 상담 자동화'); assert.equal(g.step.status, 'COMPLETED'); assert.ok(g.step.completed_at);
  assert.equal(g.phases[0].summary.completed, 3); assert.equal(g.phases[0].summary.required_done, 3); assert.equal(g.phases[0].summary.required_open, 1);
  assert.ok(g.phases[0].steps.slice(0, 3).every((s) => s.state === 'COMPLETED'));
  g = (await c('PATCH', `${url}/steps/${steps[0].id}`, { status: 'TODO' })).json;
  assert.equal(g.step.completed_at, null); assert.equal(g.phases[0].summary.completed, 2);
  // SKIPPED is a stored mark; it counts toward the REQUIRED gate and shows as state SKIPPED
  const opt = g.phases[1].steps.find((s) => s.importance === 'OPTIONAL');
  g = (await c('PATCH', `${url}/steps/${opt.id}`, { status: 'SKIPPED' })).json;
  assert.equal(g.phases[1].steps.find((s) => s.id === opt.id).state, 'SKIPPED'); assert.equal(g.phases[1].summary.skipped, 1);
  // derived state from live data: a requirement makes 요구사항 수집 COMPLETED without any stored mark
  assert.equal(g.phases[1].steps.find((s) => s.step_key === 'COLLECT').state, 'NOT_STARTED');
  await c('POST', `${url}/requirements`, { title: 'R1' });
  g = (await c('GET', url)).json;
  const collect = g.phases[1].steps.find((s) => s.step_key === 'COLLECT'); assert.equal(collect.status, 'TODO'); assert.equal(collect.state, 'COMPLETED'); assert.equal(collect.derived, 'COMPLETED');
  assert.equal(g.phases[1].steps.find((s) => s.step_key === 'CLASSIFY').state, 'IN_PROGRESS');
  assert.ok(g.phases[1].steps.find((s) => s.step_key === 'CLASSIFY').cta.label.endsWith('→'));
  assert.equal((await c('PATCH', `${url}/steps/${steps[0].id}`, { status: 'NOPE' })).status, 400);
  assert.equal((await c('PATCH', `${url}/steps/does-not-exist`, { status: 'TODO' })).status, 404);
  // reload persists
  g = (await c('GET', url)).json; assert.equal(g.phases[0].steps[0].note, '목표: 상담 자동화');
  server.close();
});

test('transitions: next with REQUIRED gate met → COMPLETED; incomplete → stays IN_PROGRESS; back to earlier; history', async () => {
  const { server, client } = await boot();
  const { c, url } = await userWithProject(client);
  let g = (await c('GET', url)).json;
  for (const s of g.phases[0].steps.filter((x) => x.importance === 'REQUIRED')) await c('PATCH', `${url}/steps/${s.id}`, { status: 'COMPLETED' });   // RECOMMENDED may stay open
  g = (await c('POST', `${url}/phases/${g.phases[1].id}/activate`, { reason: 'NEXT' })).json;
  assert.equal(g.project.current_phase, 'REQUIREMENTS');
  assert.equal(g.phases[0].status, 'COMPLETED'); assert.ok(g.phases[0].completed_at);
  assert.equal(g.phases[1].status, 'IN_PROGRESS'); assert.ok(g.phases[1].started_at);
  // skip ahead with incomplete steps: allowed, leaving phase stays IN_PROGRESS
  g = (await c('POST', `${url}/phases/${g.phases[2].id}/activate`, {})).json;
  assert.equal(g.phases[1].status, 'IN_PROGRESS'); assert.equal(g.phases[1].completed_at, null);
  assert.equal(g.current_phase.phase_key, 'ANALYSIS_DESIGN');
  // explicit move back to a completed phase re-opens it
  g = (await c('POST', `${url}/phases/${g.phases[0].id}/activate`, {})).json;
  assert.equal(g.current_phase.phase_key, 'INITIATION'); assert.equal(g.phases[0].status, 'IN_PROGRESS');
  assert.equal((await c('POST', `${url}/phases/${g.phases[0].id}/activate`, {})).status, 409);
  assert.deepEqual(g.history.map((h) => [h.from_key, h.to_key, h.reason]), [
    [null, 'INITIATION', 'PROJECT_CREATED'], ['INITIATION', 'REQUIREMENTS', 'NEXT'], ['REQUIREMENTS', 'ANALYSIS_DESIGN', 'MANUAL'], ['ANALYSIS_DESIGN', 'INITIATION', 'MANUAL']]);
  // list view carries progress + phase name
  const list = (await c('GET', url.replace(/\/[^/]+$/, ''))).json.projects[0];
  assert.equal(list.current_phase_name, '착수'); assert.equal(typeof list.progress, 'number');
  server.close();
});

test('archived project: guide readable, steps/phases immutable', async () => {
  const { server, client } = await boot();
  const { c, url } = await userWithProject(client);
  let g = (await c('GET', url)).json;
  await c('POST', `${url}/archive`, {});
  assert.equal((await c('GET', url)).status, 200);
  assert.equal((await c('PATCH', `${url}/steps/${g.phases[0].steps[0].id}`, { status: 'COMPLETED' })).status, 409);
  assert.equal((await c('POST', `${url}/phases/${g.phases[1].id}/activate`, {})).status, 409);
  server.close();
});

test('tenant isolation holds for step/phase routes (ids from another workspace)', async () => {
  const { server, client } = await boot();
  const A = await userWithProject(client, 'a@x.com');
  const B = await userWithProject(client, 'b@x.com');
  const ga = (await A.c('GET', A.url)).json;
  const stepA = ga.phases[0].steps[0].id; const phaseA = ga.phases[1].id;
  // B via A's workspace → 404; B via own workspace with A's project/step/phase ids → 404
  assert.equal((await B.c('PATCH', `${A.url}/steps/${stepA}`, { status: 'COMPLETED' })).status, 404);
  assert.equal((await B.c('POST', `${A.url}/phases/${phaseA}/activate`, {})).status, 404);
  assert.equal((await B.c('PATCH', `/api/workspaces/${B.w}/projects/${A.p.id}/steps/${stepA}`, { status: 'COMPLETED' })).status, 404);
  assert.equal((await B.c('PATCH', `${B.url}/steps/${stepA}`, { status: 'COMPLETED' })).status, 404);
  assert.equal((await B.c('POST', `${B.url}/phases/${phaseA}/activate`, {})).status, 404);
  assert.equal((await A.c('GET', A.url)).json.phases[0].steps[0].status, 'TODO');
  server.close();
});

test('migration: database recorded at an older version gets Lifecycle V2 phases seeded once (v21 reset); re-run is a no-op', async () => {
  // Fresh schema with the current tables, but bookkeeping says only v1 was applied and no phases exist (what a SQLite-era import looks like).
  const db = await openDb({ url: TEST_DATABASE_URL, schema: 't_mig_' + Date.now(), createSchema: true, max: 2, applyMigrations: false });
  const c = await db.pool.connect();
  try {
    await c.query(schemaSql);
    await c.query(`INSERT INTO users (id,email,name,password_hash) VALUES ('u1','a@x.com','A','x');
      INSERT INTO workspaces (id,name,owner_id) VALUES ('w1','W','u1');
      INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('w1','u1','OWNER');
      INSERT INTO projects (id,workspace_id,name,project_type,current_situation,planned_start_date,planned_end_date,created_by) VALUES ('p1','w1','Old','SI','NOT_STARTED','2026-01-01','2026-06-01','u1');
      INSERT INTO projects (id,workspace_id,name,project_type,current_situation,planned_start_date,planned_end_date,created_by,status) VALUES ('p2','w1','Old archived','SI','NOT_STARTED','2026-01-01','2026-06-01','u1','ARCHIVED');
      INSERT INTO schema_migrations (version, name) VALUES (1, 'v1');`);
  } finally { c.release(); }
  const applied = await migrate(db, schemaSql, (client) => bindTx(client, db));
  assert.equal(applied.length, LATEST_VERSION - 1); // everything after v1
  assert.equal((await db.get('SELECT MAX(version) AS v FROM schema_migrations')).v, LATEST_VERSION);
  assert.equal((await db.get('SELECT COUNT(*) n FROM project_phases')).n, 14);
  assert.equal((await db.get('SELECT COUNT(*) n FROM project_steps')).n, 2 * STEPS_PER_PROJECT);
  assert.equal((await db.get("SELECT COUNT(*) n FROM project_phases WHERE phase_key IN ('SCHEDULE','EXECUTION','ACCEPTANCE','LAUNCH')")).n, 0, 'no legacy phase keys');
  assert.equal((await db.get("SELECT status FROM project_phases WHERE project_id='p1' AND phase_key='INITIATION'")).status, 'IN_PROGRESS');
  assert.equal((await db.get("SELECT COUNT(*) n FROM phase_transitions WHERE project_id='p1'")).n, 1);
  assert.ok(await db.get("SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_creator_is_member'"));
  // re-running is a no-op
  assert.equal((await migrate(db, schemaSql, (client) => bindTx(client, db))).length, 0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM project_phases')).n, 14);
  // the migrated DB serves the app
  const { server } = await boot(db);
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/me`); assert.equal(r.status, 401);
  server.close(); await db.close(); await db.dropSchema();
});
