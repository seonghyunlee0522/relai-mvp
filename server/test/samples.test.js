/* 샘플 프로젝트 (server/samples/): signup copies 3 consistent example projects; samples are not usage; 삭제 / 추가; dates follow today. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { addSampleProjects, snapshot, weekShift } from '../samples/index.js';
import { workspaceUsage } from '../usage.js';
import { todayKst, addDays, diffDays } from '../../public/app/shared/kst-date.js';

const T = todayKst();
const CUR = { early: 'REQUIREMENTS', mid: 'DEVELOPMENT', done: 'OPERATIONS' };
const ORDER = ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];
const BAD_TEXT = /\bnull\b|\bundefined\b|\bNaN\b|\[object |SAMPLEOWNERNAME|sample-owner@/;
/** Every string value inside a JSON-able object (JSON null itself is fine; the word 'null' inside text is not). */
const texts = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []).join('\n');

async function signup(client, { email = 's@x.com', name = '김하늘', samples = true } = {}) {
  process.env.SAMPLE_PROJECTS = samples ? 'true' : 'false';
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name, email, password: 'passw0rd!' });
  process.env.SAMPLE_PROJECTS = 'false';
  assert.equal(s.status, 201);
  const w = s.json.workspaces[0].id;
  const projects = (await c('GET', `/api/workspaces/${w}/projects`)).json.projects;
  return { c, w, uid: s.json.user.id, projects, by: Object.fromEntries(projects.filter((p) => p.sample_key).map((p) => [p.sample_key, p])), purl: (p) => `/api/workspaces/${w}/projects/${p.id}` };
}

test('signup: 3 samples (시작 단계 · 구현 단계 · 종료 직전) owned by the user, every earlier phase gate met, 지금 할 일 fits each case', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client);
  assert.deepEqual(A.projects.map((p) => p.sample_key).sort(), ['done', 'early', 'mid']);
  for (const [key, p] of Object.entries(A.by)) {
    const G = (await A.c('GET', A.purl(p))).json;
    assert.equal(G.project.current_phase, CUR[key], key);
    assert.equal(G.project.sample_key, key);
    const cur = ORDER.indexOf(CUR[key]);
    for (const ph of G.phases) {
      const i = ORDER.indexOf(ph.phase_key);
      const req = ph.steps.filter((s) => s.importance === 'REQUIRED');
      if (i < cur) for (const s of req) assert.ok(['COMPLETED', 'SKIPPED'].includes(s.state), `${key} ${ph.phase_key}.${s.step_key} = ${s.state}`);
      if (i > cur) for (const s of ph.steps) assert.equal(s.state, 'NOT_STARTED', `${key} ${ph.phase_key}.${s.step_key} is in the future`);
    }
    const g = (await A.c('GET', `${A.purl(p)}/guidance`)).json.guidance;
    assert.equal(g.current_phase.key, CUR[key], `${key} guidance phase`);
    assert.ok(g.primary_action && g.primary_action.href.includes(p.id), `${key} 지금 할 일 points into the project`);
    assert.doesNotMatch(texts(g), BAD_TEXT, key);
  }
  // A: 02 진행 중 — requirements left to decide; C: everything done, only 종료 left
  let g = (await A.c('GET', `${A.purl(A.by.early)}/guidance`)).json.guidance;
  assert.match(g.rule, /^REQ_/); assert.match(g.primary_action.href, /\/requirements/);
  g = (await A.c('GET', `${A.purl(A.by.mid)}/guidance`)).json.guidance;
  assert.match(g.rule, /^DEV_/);
  g = (await A.c('GET', `${A.purl(A.by.done)}/guidance`)).json.guidance;
  assert.equal(g.rule, 'OPS_CLOSE'); assert.match(g.primary_action.href, /\?close=1$/);
  const done = (await A.c('GET', A.purl(A.by.done))).json;
  for (const s of done.phases.find((x) => x.phase_key === 'OPERATIONS').steps.filter((x) => x.importance === 'REQUIRED')) assert.equal(s.state, 'COMPLETED', `07 ${s.step_key}`);
  assert.ok(done.phases.filter((x) => x.phase_key !== 'OPERATIONS').every((x) => x.status === 'COMPLETED'), '01–06 completed');

  // owners: the user only (no fake accounts); every row of the samples belongs to this workspace
  const pids = A.projects.map((p) => p.id);
  for (const t of ['requirements', 'wbs_items', 'issues', 'risks', 'test_cases', 'change_requests']) {
    const owners = await db.all(`SELECT DISTINCT owner_user_id AS u FROM ${t} WHERE project_id = ANY(?) AND owner_user_id IS NOT NULL`, [pids]).catch(() => db.all(`SELECT DISTINCT created_by AS u FROM ${t} WHERE project_id = ANY(?)`, [pids]));
    assert.ok(owners.every((r) => r.u === A.uid), `${t} owners`);
    const creators = await db.all(`SELECT DISTINCT created_by AS u FROM ${t} WHERE project_id = ANY(?)`, [pids]);
    assert.deepEqual(creators.map((r) => r.u), [A.uid], `${t} created_by`);
  }
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM users')).n), 1, 'no extra user accounts');

  // requirements ↔ WBS: every in-scope requirement of B and C is linked; C: tested (last PASS) and in the accepted 검수
  for (const key of ['mid', 'done']) {
    const n = Number((await db.get(`SELECT COUNT(*) n FROM requirements r WHERE r.project_id = ? AND r.scope = 'IN_SCOPE' AND NOT EXISTS (SELECT 1 FROM requirement_wbs_links l WHERE l.requirement_id = r.id)`, [A.by[key].id])).n);
    assert.equal(n, 0, `${key}: unlinked in-scope requirements`);
  }
  const untested = await db.all(`SELECT r.display_id FROM requirements r WHERE r.project_id = ? AND r.scope = 'IN_SCOPE' AND NOT EXISTS (
      SELECT 1 FROM test_links l JOIN test_executions e ON e.test_case_id = l.test_case_id WHERE l.target_id = r.id
      AND e.execution_number = (SELECT MAX(execution_number) FROM test_executions x WHERE x.test_case_id = l.test_case_id) AND e.result = 'PASS')`, [A.by.done.id]);
  assert.deepEqual(untested, []);
  assert.equal((await db.get(`SELECT status FROM acceptances WHERE project_id = ?`, [A.by.done.id])).status, 'ACCEPTED');

  // milestones follow the F3 events: C all done; B 착수보고 · 분석·설계 완료 done, 오픈 not yet
  const ms = async (pid) => Object.fromEntries((await db.all(`SELECT title, status FROM wbs_items WHERE project_id = ? AND item_type = 'MILESTONE'`, [pid])).map((r) => [r.title, r.status]));
  assert.ok(Object.values(await ms(A.by.done.id)).every((s) => s === 'COMPLETED'), 'C milestones');
  const b = await ms(A.by.mid.id);
  assert.equal(b['착수보고'], 'COMPLETED'); assert.equal(b['분석·설계 완료'], 'COMPLETED'); assert.notEqual(b['오픈'], 'COMPLETED');

  // weekly reports: Monday–Sunday weeks, finalized, no null / placeholder text, the user's name where the owner was
  const reps = await db.all(`SELECT period_start, period_end, status, report_type, rendered_content, structured_content FROM weekly_reports WHERE project_id = ANY(?)`, [pids]);
  assert.ok(reps.filter((r) => r.report_type !== 'COMPLETION').length >= 6);
  for (const r of reps) {
    assert.equal(r.status, 'FINAL');
    if (r.report_type !== 'COMPLETION') { assert.equal(new Date(`${r.period_start}T00:00:00Z`).getUTCDay(), 1, 'Monday'); assert.equal(diffDays(r.period_start, r.period_end), 6); }
    assert.doesNotMatch(r.rendered_content, BAD_TEXT); assert.doesNotMatch(texts(JSON.parse(r.structured_content)), BAD_TEXT);
  }
  assert.ok(reps.some((r) => r.rendered_content.includes('김하늘')), 'owner name replaced');
  // facts never dated after today: go-live, handover, approvals, test runs, history
  const defs = await db.all(`SELECT go_live, handover, approval, req_approval FROM project_definitions WHERE project_id = ANY(?)`, [pids]);
  for (const d of defs) for (const col of ['go_live', 'handover', 'approval', 'req_approval']) { const v = JSON.parse(d[col] || '{}'); if (v.date) assert.ok(v.date <= T, `${col} ${v.date}`); }
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ANY(?) AND (e.performed_on > ? OR e.executed_at > now())`, [pids, T])).n), 0);
  for (const t of ['requirement_history', 'wbs_history']) assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM ${t} WHERE changed_at > now()`)).n), 0, t);
  const act = (await A.c('GET', `${A.purl(A.by.mid)}/activity?limit=50`)).json.items;
  assert.ok(act.length >= 20, 'B has history'); assert.ok(act.every((x) => x.at <= new Date().toISOString()));
  assert.doesNotMatch(texts(act), BAD_TEXT);

  // C: the one remaining action — 프로젝트 종료 — goes through
  const r = await A.c('POST', `${A.purl(A.by.done)}/close`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.project.status, 'COMPLETED');
  server.close();
});

test('samples are not usage: plan usage counts 0 projects, the first real project still records the onboarding first, Home lists samples after real work', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client);
  const u = await workspaceUsage(db, A.w);
  for (const k of ['projects', 'requirements', 'wbs', 'weekly_reports']) assert.equal(u.dims.find((d) => d.key === k).used, 0, k);
  const prev = process.env.PLAN_LIMITS; process.env.PLAN_LIMITS = 'on';
  const p = await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: '실제 프로젝트', client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: T, planned_end_date: addDays(T, 90) });
  process.env.PLAN_LIMITS = prev;
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.json.project.sample_key, null);
  assert.ok(await db.get(`SELECT 1 FROM admin_audit_logs WHERE action = 'FIRST_PROJECT_CREATED' AND target_id = ?`, [p.json.project.id]), 'the first real project is the first project (samples do not count)');
  const home = (await A.c('GET', `/api/workspaces/${A.w}/projects/home`)).json;
  assert.equal(home.projects.length, 4); assert.ok(home.projects.filter((c) => c.sample_key).length === 3);
  server.close();
});

test('삭제 / 추가: one sample, all samples (no orphan history), real projects are never deleted, 추가 brings back only what is missing; env off → no samples', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client);
  const real = (await A.c('POST', `/api/workspaces/${A.w}/projects`, { name: '실제', client_name: '고객사', project_type: 'NEW_BUILD', planned_start_date: T, planned_end_date: addDays(T, 30) })).json.project;
  let r = await A.c('DELETE', `/api/workspaces/${A.w}/projects/${real.id}`);
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'not_sample');
  r = await A.c('DELETE', `/api/workspaces/${A.w}/projects/${A.by.mid.id}`);
  assert.equal(r.status, 200); assert.equal(r.json.deleted, 1);
  r = await A.c('POST', `/api/workspaces/${A.w}/samples`, {});
  assert.equal(r.status, 201); assert.deepEqual(r.json.projects.map((p) => p.sample_key), ['mid']);
  r = await A.c('POST', `/api/workspaces/${A.w}/samples`, {});
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'samples_exist');
  r = await A.c('DELETE', `/api/workspaces/${A.w}/samples`);
  assert.equal(r.status, 200); assert.equal(r.json.deleted, 3);
  const left = (await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects;
  assert.deepEqual(left.map((p) => p.id), [real.id]);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM raid_history h WHERE NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = h.entity_id) AND NOT EXISTS (SELECT 1 FROM risks x WHERE x.id = h.entity_id)`)).n), 0);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM qa_history h WHERE NOT EXISTS (SELECT 1 FROM test_cases t WHERE t.id = h.entity_id) AND NOT EXISTS (SELECT 1 FROM acceptances a WHERE a.id = h.entity_id)`)).n), 0);
  assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM wbs_items w WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = w.project_id)`)).n), 0);
  // a MEMBER cannot add or delete samples
  const M = client(); await M('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '멤버', email: 'm@x.com', password: 'passw0rd!' });
  await A.c('POST', `/api/workspaces/${A.w}/members`, { email: 'm@x.com', role: 'MEMBER' });
  assert.equal((await M('POST', `/api/workspaces/${A.w}/samples`, {})).status, 403);
  // SAMPLE_PROJECTS=false → a plain empty workspace (legacy behaviour)
  const B = await signup(client, { email: 'off@x.com', samples: false });
  assert.equal(B.projects.length, 0);
  server.close();
});

test('dates follow the signup day in whole weeks: weekdays, report weeks and text dates move together; nothing done lands after today', async () => {
  const { db, server, client } = await boot();
  const A = await signup(client, { samples: false });
  const snap = snapshot();
  const later = addDays(snap.t0, 45);
  assert.equal(weekShift(snap.t0, later), 42); assert.equal(weekShift(snap.t0, snap.t0), 0); assert.equal(weekShift(snap.t0, addDays(snap.t0, 6)), 0);
  const created = await addSampleProjects(db, { workspaceId: A.w, userId: A.uid, userName: '김하늘', today: later });
  assert.equal(created.length, 3);
  const mid = created.find((p) => p.sample_key === 'mid');
  const reps = await db.all(`SELECT period_start, period_end, rendered_content FROM weekly_reports WHERE project_id = ? ORDER BY period_start`, [mid.id]);
  const orig = snap.tables.find((t) => t.name === 'weekly_reports'); const ps = orig.columns.indexOf('period_start'); const pc = orig.columns.indexOf('project_id');
  const first = orig.rows.filter((r) => r[pc] === snap.cases.find((c) => c.key === 'mid').project_id).map((r) => r[ps]).sort()[0];
  assert.equal(reps[0].period_start, addDays(first, 42));
  assert.equal(new Date(`${reps[0].period_start}T00:00:00Z`).getUTCDay(), 1);
  assert.ok(reps[0].rendered_content.includes(`(${reps[0].period_start} ~ ${reps[0].period_end})`), 'title dates shifted with the period');
  const done = created.find((p) => p.sample_key === 'done');
  const gl = JSON.parse((await db.get(`SELECT go_live FROM project_definitions WHERE project_id = ?`, [done.id])).go_live);
  assert.ok(gl.date <= later && gl.date > addDays(later, -60), gl.date);
  server.close();
});
