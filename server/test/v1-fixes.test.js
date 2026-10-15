/* v1 fix batch (Jim v1 final sign-off, research/relai-v1-functional-audit.md): P2-1 sample history has no actor (shown as 샘플) ·
 * P2-2 requirement counts in scope · P2-4 weekly report lists the period's decisions · P2-5 완료보고서 cites the CR behind a push ·
 * P2-7 간트 차트 보기. P1-1 (checklist rows), P2-3 (Home) and P2-6 (phone label) are client-side: scripts/e2e-v1fixes.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { todayKst, addDays } from '../../public/app/shared/kst-date.js';
import { buildCompletionData, completionSections } from '../reports.js';
import { projectActivity } from '../dashboard.js';
import { listComments } from '../comments.js';

const T = todayKst();

test('P2-1: sample history is not attributed to the new user; the feed says 샘플, the user\'s own edits keep their name', async () => {
  const { server, client, db } = await boot();
  process.env.SAMPLE_PROJECTS = 'true';
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '최종검', email: 'p21@x.com', password: 'passw0rd!' });
  process.env.SAMPLE_PROJECTS = 'false';
  const uid = s.json.user.id; const w = s.json.workspaces[0].id;
  const pids = (await db.all('SELECT id FROM projects WHERE workspace_id = ? AND sample_key IS NOT NULL', [w])).map((r) => r.id);
  assert.equal(pids.length, 3);
  for (const [t, col, fk] of [['requirement_history', 'changed_by', 'requirement_id IN (SELECT id FROM requirements WHERE project_id = ANY(?))'],
    ['wbs_history', 'changed_by', 'wbs_item_id IN (SELECT id FROM wbs_items WHERE project_id = ANY(?))'], ['phase_transitions', 'changed_by', 'project_id = ANY(?)'],
    ['project_steps', 'completed_by', 'project_phase_id IN (SELECT id FROM project_phases WHERE project_id = ANY(?))'], ['activity_checklist_items', 'done_by', 'project_id = ANY(?)']]) {
    const n = (await db.get(`SELECT COUNT(*)::int AS n FROM ${t} WHERE ${col} = ? AND ${fk}`, [uid, pids])).n;
    assert.equal(n, 0, `${t}.${col} names the new user`);
  }
  for (const pid of pids) {
    const feed = (await projectActivity(db, pid, { limit: 50 })).items;   // comments included (comments.author_label, migration 44)
    assert.ok(feed.length, 'sample feed has events');
    assert.ok(feed.every((e) => e.actor_name === '샘플'), JSON.stringify(feed.map((e) => e.actor_name)));
  }
  const coms = await db.all('SELECT entity_type, entity_id FROM comments WHERE project_id = ANY(?)', [pids]);
  assert.ok(coms.length, 'samples carry comments');
  const comments = (await Promise.all(coms.map((x) => listComments(db, x.entity_type, x.entity_id)))).flat();
  assert.ok(comments.length && comments.every((x) => x.author_name === '샘플'), JSON.stringify(comments));
  // the user's own edit in a sample shows their name
  const early = (await db.get("SELECT id FROM projects WHERE workspace_id = ? AND sample_key = 'early'", [w])).id;
  const r = (await c('POST', `/api/workspaces/${w}/projects/${early}/requirements`, { title: '내가 추가한 요구사항', scope: 'IN_SCOPE' }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const top = (await projectActivity(db, early, { limit: 1 })).items[0];
  assert.equal(top.actor_name, '최종검');
  server.close();
});

test('P2-2: dashboard requirement counts carry in_scope / in_scope_confirmed (the 02 KPI denominator)', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'p22@x.com');
  const mk = async (scope, confirm) => { const r = (await A.c('POST', A.req, { title: `${scope}-${confirm}`, scope })).json.requirement; if (confirm) await A.c('PATCH', `${A.req}/${r.id}`, { status: 'CONFIRMED' }); };
  await mk('IN_SCOPE', true); await mk('IN_SCOPE', false); await mk('OUT_OF_SCOPE', true);
  const G = (await A.c('GET', A.purl)).json;
  const r = G.requirements;   // what next.js phaseMetric reads
  assert.equal(Number(r.in_scope), 2); assert.equal(Number(r.in_scope_confirmed), 1);
  assert.equal(Number(r.total), 3); assert.equal(Number(r.confirmed), 2);   // the old KPI read 2 / 3; the 02 row reads 1 / 2
  server.close();
});

test('P2-4: the weekly report lists decisions recorded in the period (and only those)', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'p24@x.com');
  const s = (await A.c('GET', A.purl)).json.phases.find((p) => p.phase_key === 'DEVELOPMENT').steps.find((x) => x.step_key === 'DECISIONS');
  const add = (title, due_date) => A.c('POST', `${A.purl}/steps/${s.id}/checklist`, { title, owner: '오지현 고객 PM', due_date, done: true, note: '주간회의' });
  assert.equal((await add('2차 오픈으로 리포트 기능 이월', addDays(T, -1))).status, 201);
  assert.equal((await add('지난달 결정', addDays(T, -40))).status, 201);
  const rep = (await A.c('POST', `${A.purl}/weekly-reports/generate`, { period_start: addDays(T, -6), period_end: T })).json.report;
  const sec = rep.rendered_content.split('확인 및 의사결정 필요사항')[1].split('## ')[0];
  assert.match(sec, /기간 내 결정 1건/);
  assert.match(sec, /2차 오픈으로 리포트 기능 이월 · 오지현 고객 PM · 주간회의/);
  assert.doesNotMatch(sec, /지난달 결정|의사결정이 필요한 항목이 없습니다/);
  server.close();
});

test('P2-5: 완료보고서 일정 cites the approved CR when a push has no typed reason', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client, 'p25@x.com');
  const w = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '정산 화면 개발', planned_start_date: addDays(T, 1), planned_end_date: addDays(T, 10) })).json.item;
  await db.run('UPDATE wbs_items SET original_planned_end_date = ?, planned_end_date = ? WHERE id = ?', [addDays(T, 10), addDays(T, 15), w.id]);   // +5일 applied from the CR
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '정산 항목 추가', reason: '고객 요청' })).json.change;
  assert.equal((await A.c('POST', `${A.purl}/changes/${cr.id}/impacts`, { wbs_item_id: w.id, impact_type: 'SCHEDULE' })).status, 201);
  const project = await db.get('SELECT * FROM projects WHERE id = ?', [A.p.id]);
  let d = await buildCompletionData(db, project);
  assert.equal(d.schedule.pushed, 1); assert.equal(d.schedule.reasons.length, 0, 'a CR under review is no reason yet');
  await db.run("UPDATE change_requests SET status = 'APPROVED' WHERE id = ?", [cr.id]);
  d = await buildCompletionData(db, project);
  const body = completionSections(d).find((x) => x.key === 'schedule').body;
  assert.match(body, new RegExp(`정산 화면 개발 · \\+5일 · 변경 요청 ${cr.display_id} 정산 항목 추가 \\(승인\\)`));
  assert.doesNotMatch(body, /기록된 미룸 사유가 없습니다/);
  server.close();
});

test('P2-7: 03 WBS guidance links say 간트 차트 보기, not Gantt', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['activities.js', 'guidance.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Gantt 보기/, f); assert.match(src, /간트 차트 보기/, f);
  }
});
