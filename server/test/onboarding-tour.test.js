/* Phase 14 — onboarding state, product tour, checklist, feature guides, guidance engine, activation (spec §57). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember, project } from './api-helpers.js';
import { projectGuidance } from '../guidance.js';
import { activationState } from '../activation.js';

const OB = (A) => `/api/workspaces/${A.w}/onboarding`;
const fresh = async (client, email, name = '신규') => { const c = client(); const s = await c('POST', '/api/auth/signup', { name, email, password: 'passw0rd!' }); return { c, w: s.json.workspaces[0].id, uid: s.json.user.id }; };
async function completeDefinition(A) {
  await A.c('PUT', `${A.purl}/definition`, { goal: '목표', success_criteria: ['기준'], scope_in: ['범위'], stakeholders: [{ name: '김', org: 'ACME', org_type: '고객사' }], key_dates: [{ title: '오픈', date: '2027-01-01' }], operations: { meetings: '주간' } });
  for (const k of ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']) assert.equal((await A.c('POST', `${A.purl}/definition/sections/${k}/complete`, {})).status, 200, k);
}

test('onboarding: new OWNER eligibility (0 projects) vs existing customer backfill; MEMBER never gets owner setup; isolation per user and workspace', async () => {
  const { server, client, db } = await boot();
  // 1. new OWNER with 0 projects
  const N = await fresh(client, 'new@x.com');
  let o = (await N.c('GET', OB(N))).json;
  assert.equal(o.audience, 'OWNER_NEW'); assert.equal(o.welcome.status, 'NOT_STARTED'); assert.equal(o.tour.status, 'NOT_STARTED'); assert.equal(o.checklist.done, 1); assert.equal(o.checklist.visible, true);
  assert.ok(o.tour.steps.some((s) => s.key === 'CREATE_PROJECT' && s.target === 'create-project'));
  assert.equal(o.tour.steps.find((s) => s.key === 'PROJECT_HOME').available, false, 'project steps unavailable without a project');
  assert.ok(o.tour.steps.every((s) => s.fallback === undefined || s.fallback === 'center'), 'fallback config for missing targets');
  // 33. existing user backfill: a workspace with data never sees the first-project tour
  const A = await setup(client, 'old@x.com');
  o = (await A.c('GET', OB(A))).json;
  assert.equal(o.audience, 'OWNER'); assert.equal(o.tour.status, 'COMPLETED'); assert.equal(o.tour.meta.backfilled, true); assert.equal(o.welcome.status, 'COMPLETED');
  assert.equal(o.checklist.steps.find((s) => s.key === 'PROJECT').done, true, '3. project exists → step done');
  assert.equal(o.checklist.visible, true, 'checklist still shown while requirements/WBS missing');
  // 2. MEMBER: no owner setup, no checklist
  const M = await addMember(client, A, 'm@x.com', '멤버', 'MEMBER');
  const om = (await M.c('GET', OB(A))).json;
  assert.equal(om.audience, 'MEMBER'); assert.equal(om.checklist, null); assert.ok(!om.tour.steps.some((s) => s.key === 'CREATE_PROJECT' || s.key === 'MEMBERS'));
  assert.equal(om.tour.status, 'NOT_STARTED', 'member gets its own (member) tour state');
  // 12/13. isolation: N's state unaffected by A/M; N cannot read A's workspace onboarding
  assert.equal((await N.c('GET', OB(N))).json.tour.status, 'NOT_STARTED');
  assert.equal((await N.c('GET', OB(A))).status, 404);
  // 34. no duplicate rows on repeated/concurrent reads
  await Promise.all([N.c('GET', OB(N)), N.c('GET', OB(N)), N.c('GET', OB(N))]);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM user_onboarding WHERE user_id = ?', [N.uid])).n), 3, 'WELCOME + PRODUCT_TOUR + CHECKLIST only');
  // 35. one endpoint, bounded queries: a single GET answers everything (no per-project calls)
  assert.ok(o.workspace && 'project_count' in o.workspace && Array.isArray(o.guides_seen));
  server.close();
});

test('onboarding: start/step/complete/skip/replay; checklist auto-completes from data (4/5); suspended user & workspace blocked', async () => {
  const { server, client, db } = await boot();
  const N = await fresh(client, 'flow@x.com');
  // 7. start  8. step
  let r = (await N.c('POST', `${OB(N)}/product_tour/start`, { step: 'HOME' })).json.product_tour;
  assert.equal(r.status, 'IN_PROGRESS'); assert.equal(r.current_step, 'HOME'); assert.ok(r.started_at);
  r = (await N.c('POST', `${OB(N)}/product_tour/step`, { step: 'CREATE_PROJECT' })).json.product_tour;
  assert.equal(r.current_step, 'CREATE_PROJECT'); assert.deepEqual(r.completed_steps, ['HOME']);
  assert.equal((await N.c('POST', `${OB(N)}/product_tour/step`, {})).status, 400);
  // refresh keeps position
  assert.equal((await N.c('GET', OB(N))).json.tour.current_step, 'CREATE_PROJECT');
  // 10. skip → not repeated
  r = (await N.c('POST', `${OB(N)}/product_tour/skip`, {})).json.product_tour;
  assert.equal(r.status, 'SKIPPED'); assert.ok(r.skipped_at); assert.equal(r.current_step, null);
  assert.equal((await N.c('GET', OB(N))).json.tour.status, 'SKIPPED');
  // 11. replay: explicit, counted, does not erase history
  r = (await N.c('POST', `${OB(N)}/product_tour/replay`, { step: 'HOME' })).json.product_tour;
  assert.equal(r.status, 'IN_PROGRESS'); assert.equal(r.meta.replays, 1); assert.ok(r.skipped_at, 'history kept');
  // 9. complete
  r = (await N.c('POST', `${OB(N)}/product_tour/complete`, {})).json.product_tour;
  assert.equal(r.status, 'COMPLETED'); assert.ok(r.completed_at); assert.ok(r.completed_steps.includes('HOME'));
  assert.equal((await N.c('POST', `${OB(N)}/welcome/complete`, {})).json.welcome.status, 'COMPLETED');
  assert.equal((await N.c('POST', `${OB(N)}/nope/start`, {})).status, 404);
  assert.equal((await N.c('POST', `${OB(N)}/product_tour/dance`, {})).status, 404);
  // checklist progression from real data: project → definition → requirement → leaf WBS
  const p = (await N.c('POST', `/api/workspaces/${N.w}/projects`, project())).json.project; const purl = `/api/workspaces/${N.w}/projects/${p.id}`;
  let o = (await N.c('GET', OB(N))).json; assert.equal(o.checklist.done, 2); assert.equal(o.workspace.first_project_id, p.id);
  assert.equal(o.tour.steps.find((s) => s.key === 'PROJECT_HOME').route, `/app/projects/${p.id}`, 'tour routes resolve to the first project');
  await completeDefinition({ c: N.c, purl });
  o = (await N.c('GET', OB(N))).json; assert.equal(o.checklist.done, 3); assert.equal(o.checklist.steps.find((s) => s.key === 'DEFINITION').done, true);
  await N.c('POST', `${purl}/requirements`, { title: 'REQ-001 로그인' });
  o = (await N.c('GET', OB(N))).json; assert.equal(o.checklist.done, 4, '4. requirement exists → step done');
  assert.equal(o.checklist.status, 'NOT_STARTED');
  await N.c('POST', `${purl}/wbs`, { title: '로그인 기능', item_type: 'TASK' });
  o = (await N.c('GET', OB(N))).json; assert.equal(o.checklist.done, 5, '5. leaf WBS → step done'); assert.equal(o.checklist.status, 'COMPLETED'); assert.equal(o.checklist.visible, false);
  // a group task (has children) is not a leaf, but the leaf child counts
  // 56. analytics events exist (actor_kind USER; invisible in the default operator audit)
  const ev = await db.all(`SELECT action FROM admin_audit_logs WHERE admin_user_id = ? AND actor_kind = 'USER' ORDER BY created_at`, [N.uid]);
  const acts = ev.map((e) => e.action);
  for (const a of ['ONBOARDING_STARTED', 'ONBOARDING_SKIPPED', 'ONBOARDING_COMPLETED', 'FIRST_PROJECT_CREATED', 'FIRST_REQUIREMENT_CREATED', 'FIRST_WBS_CREATED']) assert.ok(acts.includes(a), a);
  assert.equal(acts.filter((a) => a === 'FIRST_PROJECT_CREATED').length, 1);
  // 14. suspended user → 403 on onboarding; 15. suspended workspace → 403
  await db.run(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, [N.uid]);
  assert.equal((await N.c('GET', OB(N))).status, 403);
  await db.run(`UPDATE users SET status = 'ACTIVE' WHERE id = ?`, [N.uid]);
  const N2 = await fresh(client, 'flow2@x.com');
  await db.run(`UPDATE workspaces SET status = 'SUSPENDED' WHERE id = ?`, [N2.w]);
  assert.equal((await N2.c('GET', OB(N2))).status, 403);
  server.close();
});

test('feature guides: seen once → hidden; reset shows again; unknown key 404; per-user', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'g@x.com');
  assert.deepEqual((await A.c('GET', OB(A))).json.guides_seen, []);
  let r = await A.c('POST', '/api/guides/testing_intro/seen', {}); assert.equal(r.status, 200); assert.deepEqual(r.json.guides_seen, ['TESTING_INTRO']);
  r = await A.c('POST', '/api/guides/TESTING_INTRO/seen', {}); assert.deepEqual(r.json.guides_seen, ['TESTING_INTRO'], '18. repeated → still one, hidden');
  await A.c('POST', '/api/guides/PHASE_INTRO_TESTING/seen', {});
  assert.equal((await A.c('GET', OB(A))).json.guides_seen.length, 2);
  assert.equal((await A.c('POST', '/api/guides/NOPE/seen', {})).status, 404);
  const M = await addMember(client, A, 'g2@x.com', '멤버');
  assert.deepEqual((await M.c('GET', OB(A))).json.guides_seen, [], 'per-user');
  r = await A.c('POST', '/api/guides/reset', {}); assert.deepEqual(r.json.guides_seen, []);
  assert.deepEqual((await A.c('GET', OB(A))).json.guides_seen, []);
  server.close();
});

test('guidance engine (pure rules, Lifecycle V2): INITIATION / REQUIREMENTS / ANALYSIS_DESIGN / DEVELOPMENT / TESTING / TRANSITION_GO_LIVE / OPERATIONS; task-centred CTAs; Jira & AI never required', () => {
  const base = { project: { id: 'p1', current_phase: 'INITIATION' }, next_phase: { name: '요구사항 정의', sequence: 2 }, stats: {} };
  const g = (over) => projectGuidance({ ...base, ...over });
  const arrow = (a) => a && a.label.endsWith('→') && !/로 이동/.test(a.label);
  // INITIATION
  let r = g({ phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: { progress: { done: 0, total: 5 }, needs_review: [] } });
  assert.equal(r.rule, 'INIT_DEFINE'); assert.equal(r.primary_action.href, '/app/projects/p1/definition'); assert.ok(arrow(r.primary_action)); assert.ok(r.why && r.next_preview);
  r = g({ phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: { progress: { done: 5, total: 5 }, needs_review: [] }, stats: { requirements: { total: 0 } } });
  assert.equal(r.rule, 'INIT_DONE'); assert.equal(r.primary_action.href, '/app/projects/p1?move=next'); assert.equal(r.secondary_action.label, '요구사항 입력 시작 →');
  r = g({ phase: { phase_key: 'INITIATION', name: '착수', sequence: 1 }, definition: { progress: { done: 5, total: 5 }, needs_review: ['SCOPE'] } });
  assert.equal(r.rule, 'INIT_REVIEW');
  // REQUIREMENTS: empty → classify → scope → confirm → done
  const RQ = { phase: { phase_key: 'REQUIREMENTS', name: '요구사항 정의', sequence: 2 }, next_phase: { name: '분석·설계', sequence: 3 } };
  r = g({ ...RQ, stats: { requirements: { total: 0 } } }); assert.equal(r.rule, 'REQ_EMPTY'); assert.equal(r.primary_action.label, '요구사항 입력 시작 →'); assert.equal(r.primary_action.href, '/app/projects/p1/requirements?new=1'); assert.equal(r.secondary_action, null, 'Excel import is chosen inside Requirements, not from What’s Next');
  r = g({ ...RQ, stats: { requirements: { total: 3, type_unspecified: 2 } } }); assert.equal(r.rule, 'REQ_CLASSIFY'); assert.equal(r.primary_action.label, '요구사항 분류 →');
  r = g({ ...RQ, stats: { requirements: { total: 3, type_unspecified: 0, scope_undecided: 1 } } }); assert.equal(r.rule, 'REQ_SCOPE');
  r = g({ ...RQ, stats: { requirements: { total: 3, in_scope: 3, in_scope_confirmed: 0, type_unspecified: 0, priority_unspecified: 0, scope_undecided: 0 } } }); assert.equal(r.rule, 'REQ_CONFIRM'); assert.equal(r.primary_action.label, '요구사항 확정 →');
  r = g({ ...RQ, stats: { requirements: { total: 3, in_scope: 3, in_scope_confirmed: 3 }, wbs: { tasks: 0 } } }); assert.equal(r.rule, 'REQ_DONE'); assert.equal(r.primary_action.href, '/app/projects/p1?move=next');
  // ANALYSIS_DESIGN: WBS empty → trace → assign → plan → done
  const AD = { phase: { phase_key: 'ANALYSIS_DESIGN', name: '분석·설계', sequence: 3 }, next_phase: { name: '구현', sequence: 4 } };
  r = g({ ...AD, stats: { wbs: { tasks: 0 } } }); assert.equal(r.rule, 'WBS_EMPTY'); assert.equal(r.primary_action.label, 'WBS 작성 시작 →'); assert.equal(r.primary_action.href, '/app/projects/p1/wbs?new=1');
  r = g({ ...AD, stats: { wbs: { tasks: 4 }, requirements: { in_scope: 3, in_scope_unlinked: 1 } } }); assert.equal(r.rule, 'WBS_TRACE');
  r = g({ ...AD, stats: { wbs: { tasks: 4, tasks_without_owner: 2, tasks_without_dates: 0 } } }); assert.equal(r.rule, 'WBS_ASSIGN'); assert.equal(r.primary_action.label, '담당자 지정 →');
  r = g({ ...AD, stats: { wbs: { tasks: 4, tasks_without_owner: 0, tasks_without_dates: 1 } } }); assert.equal(r.rule, 'WBS_PLAN'); assert.equal(r.primary_action.label, '일정 입력 →');
  r = g({ ...AD, stats: { wbs: { tasks: 4, tasks_without_owner: 0, tasks_without_dates: 0, milestones: 1, tasks_unlinked: 1 } } }); assert.equal(r.rule, 'WBS_DONE'); assert.ok(r.warnings.some((w) => /연결되지 않은 작업/.test(w)));
  // DEVELOPMENT: blocker > overdue > critical > change > status/done
  const DV = { phase: { phase_key: 'DEVELOPMENT', name: '구현', sequence: 4 }, next_phase: { name: '시험', sequence: 5 } };
  r = g({ ...DV, stats: { wbs: { tasks: 5 }, issues: {} }, overdue_tasks: 2 }); assert.equal(r.rule, 'DEV_OVERDUE'); assert.equal(r.primary_action.href, '/app/projects/p1/wbs?f=overdue');
  r = g({ ...DV, stats: { wbs: { tasks: 5 }, issues: { blocked: 1 } }, overdue_tasks: 2 }); assert.equal(r.rule, 'DEV_BLOCKED', 'blocker outranks overdue');
  r = g({ ...DV, stats: { wbs: { tasks: 5, in_progress: 2, tasks_completed: 1, progress: 30 }, issues: {} } }); assert.equal(r.rule, 'DEV_STATUS'); assert.equal(r.primary_action.label, '진행 상태 갱신 →');
  r = g({ ...DV, stats: { wbs: { tasks: 5, tasks_completed: 5, progress: 100 }, issues: {} } }); assert.equal(r.rule, 'DEV_DONE');
  // TESTING
  const TS = { phase: { phase_key: 'TESTING', name: '시험', sequence: 5 }, next_phase: { name: '전환 및 오픈', sequence: 6 } };
  r = g({ ...TS, stats: { tests: { total: 0 } } }); assert.equal(r.rule, 'TEST_EMPTY'); assert.equal(r.primary_action.label, '테스트 케이스 작성 →'); assert.match(r.why, /요구사항을 충족/);
  r = g({ ...TS, stats: { tests: { total: 5, executed: 5, last_fail: 2 } } }); assert.equal(r.rule, 'TEST_FAIL'); assert.equal(r.primary_action.href, '/app/projects/p1/tests?last_result=FAIL');
  r = g({ ...TS, stats: { tests: { total: 5, executed: 3, last_fail: 0 } } }); assert.equal(r.rule, 'TEST_RUN');
  r = g({ ...TS, stats: { tests: { total: 5, executed: 5, last_fail: 0 } } }); assert.equal(r.rule, 'TEST_DONE'); assert.equal(r.primary_action.href, '/app/projects/p1?move=next');
  // TRANSITION_GO_LIVE: acceptance is the first gate, then open items, then transition activities
  const TR = { phase: { phase_key: 'TRANSITION_GO_LIVE', name: '전환 및 오픈', sequence: 6 }, next_phase: { name: '운영 및 유지보수', sequence: 7 } };
  r = g({ ...TR, stats: { acceptances: { total: 0 } } }); assert.equal(r.rule, 'ACC_EMPTY'); assert.equal(r.primary_action.label, '검수 항목 작성 →');
  r = g({ ...TR, stats: { acceptances: { total: 2, requested: 1 } } }); assert.equal(r.rule, 'ACC_PENDING');
  r = g({ ...TR, stats: { acceptances: { total: 2, rework: 1, requested: 1 } } }); assert.equal(r.rule, 'ACC_REWORK');
  r = g({ ...TR, stats: { acceptances: { total: 2, accepted: 2 }, issues: { active: 1 } } }); assert.equal(r.rule, 'GO_LIVE_OPEN');
  r = g({ ...TR, stats: { acceptances: { total: 2, accepted: 2 } } }); assert.equal(r.rule, 'TRANSITION_RUN');
  // OPERATIONS
  const OP = { phase: { phase_key: 'OPERATIONS', name: '운영 및 유지보수', sequence: 7 }, next_phase: null };
  r = g({ ...OP, stats: { issues: { active: 1 } } }); assert.equal(r.rule, 'OPS_ISSUES');
  r = g({ ...OP, stats: {} }); assert.equal(r.rule, 'OPS_HANDOVER');
  // Jira and AI never appear as required actions; every navigation CTA is task-centred (ends with →, no "…로 이동")
  const all = [RQ, AD, DV, TS, TR, OP].flatMap((ph) => [g({ ...ph, stats: {} }), g({ ...ph, stats: { wbs: { tasks: 3 }, requirements: { total: 2 }, tests: { total: 1, executed: 1 }, acceptances: { total: 1, accepted: 1 } } })]);
  for (const x of all) { assert.ok(!/jira/i.test(x.primary_action.label), x.rule); assert.ok(!/^AI/.test(x.primary_action.label), x.rule); assert.ok(arrow(x.primary_action), `${x.rule}: ${x.primary_action.label}`); if (x.secondary_action) assert.ok(arrow(x.secondary_action), x.rule); }
  // determinism
  assert.deepEqual(g({ ...TS, stats: { tests: { total: 0 } } }), g({ ...TS, stats: { tests: { total: 0 } } }));
});

test('guidance via API: embedded in project GET, standalone endpoint, follows real data; member isolation', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'gd@x.com');
  let g = (await A.c('GET', A.purl)).json;
  assert.equal(g.guidance.rule, 'INIT_DEFINE'); assert.equal(g.guidance.current_phase.key, 'INITIATION');
  await completeDefinition(A);
  g = (await A.c('GET', `${A.purl}/guidance`)).json.guidance; assert.equal(g.rule, 'INIT_DONE');
  const ph = (await A.c('GET', A.purl)).json.phases.find((x) => x.phase_key === 'REQUIREMENTS');
  await A.c('POST', `${A.purl}/phases/${ph.id}/activate`, { reason: 'NEXT' });
  g = (await A.c('GET', `${A.purl}/guidance`)).json.guidance; assert.equal(g.rule, 'REQ_EMPTY');
  await A.c('POST', A.req, { title: 'R1', scope: 'IN_SCOPE', status: 'CONFIRMED', type: 'FUNCTIONAL', priority: 'HIGH' });
  g = (await A.c('GET', `${A.purl}/guidance`)).json.guidance; assert.equal(g.rule, 'REQ_DONE');
  const B = await setup(client, 'gd2@x.com');
  assert.equal((await B.c('GET', `${A.purl}/guidance`)).status, 404);
  server.close();
});

test('activation: project 0 / created / defined / activated / active; admin workspace list + detail carry it; owner endpoint', async () => {
  const { server, client, db } = await boot();
  // pure
  const now = Date.parse('2026-10-03T00:00:00Z'); const f = (o) => ({ has_owner: true, projects: 0, defined_projects: 0, activated_projects: 0, last_login: '2026-10-01', last_active_at: '2026-10-02T00:00:00Z', ...o });
  assert.equal(activationState(f({ has_owner: false }), { now }).state, 'INVITED');
  assert.equal(activationState(f({ last_login: null }), { now }).state, 'SIGNED_UP');
  assert.equal(activationState(f({}), { now }).state, 'WORKSPACE_READY');
  assert.equal(activationState(f({ projects: 1 }), { now }).state, 'PROJECT_CREATED');
  assert.equal(activationState(f({ projects: 1, defined_projects: 1 }), { now }).state, 'PROJECT_DEFINED');
  assert.equal(activationState(f({ projects: 1, defined_projects: 1, activated_projects: 1 }), { now }).state, 'ACTIVE');
  assert.equal(activationState(f({ projects: 1, activated_projects: 1, last_active_at: '2026-08-01T00:00:00Z' }), { now }).state, 'ACTIVATED');
  // via API
  const root = client(); const s = await root('POST', '/api/auth/signup', { name: '운영자', email: 'root@x.com', password: 'passw0rd!' }); await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  const N = await fresh(client, 'act@x.com');
  const ws = async () => (await root('GET', '/api/admin/workspaces?size=100')).json.items.find((w) => w.id === N.w);
  assert.equal((await ws()).activation.state, 'WORKSPACE_READY', '29. project 0');
  assert.equal((await ws()).activation.label, '프로젝트 생성 대기');
  const p = (await N.c('POST', `/api/workspaces/${N.w}/projects`, project())).json.project; const purl = `/api/workspaces/${N.w}/projects/${p.id}`;
  assert.equal((await ws()).activation.state, 'PROJECT_CREATED', '30.');
  await completeDefinition({ c: N.c, purl });
  assert.equal((await ws()).activation.state, 'PROJECT_DEFINED', '31.');
  await N.c('POST', `${purl}/requirements`, { title: 'R' }); await N.c('POST', `${purl}/wbs`, { title: 'T', item_type: 'TASK' });
  assert.equal((await ws()).activation.state, 'ACTIVE', '32. activated + recent activity');
  const d = (await root('GET', `/api/admin/workspaces/${N.w}`)).json.workspace; assert.equal(d.activation.state, 'ACTIVE'); assert.ok(d.last_activity_at);
  // owner endpoint + member forbidden
  const mine = (await N.c('GET', `/api/workspaces/${N.w}/activation`)).json.activation; assert.equal(mine.state, 'ACTIVE'); assert.equal(mine.projects, 1);
  const M = await addMember(client, { c: N.c, w: N.w }, 'actm@x.com', '멤버');
  assert.equal((await M.c('GET', `/api/workspaces/${N.w}/activation`)).status, 403);
  server.close();
});
