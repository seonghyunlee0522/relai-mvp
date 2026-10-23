/* P2 batch — Jim's prod full test 2026-10-21 (hive research/relai-prod-fulltest-2026-10-21.md, P2 #1–#11; #10 is a pricing note, no code).
 *  #1 '… 워크스페이스 워크스페이스' (invite mail, member home)   #2 home counts samples / '무료 제공' balance   #3 requirement count chips after quick-add
 *  #4 가이드 이어보기 pill over drawer buttons   #5 FAQ '한도를 넘으면' = the 10-21 read-only policy   #6 WBS 07 운영 node + schedule phase chip
 *  #7 변경 요청 tab count   #8 new-project form survives the 768px crossing   #9 AI extraction close confirm / keep   #11 FS dependency warning + Gantt links
 * Browser behaviour of #3/#4/#8/#9/#11 is in scripts/e2e-p2-batch.cjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, setup, project } from './api-helpers.js';
import { memberInviteEmail, platformInviteEmail, wsLabel as wsLabelServer, FREE_POLICY } from '../email/templates.js';
import { wsLabel } from '../../public/app/shared/workspace-name.js';
import { homeCreditLine as creditLine } from '../../public/app/shared/ai.js';
import { FAQ } from '../../public/app/shared/pricing.js';
import { FIXED_NODES, inferPlanPhase, allocateSchedule, sameAsNode } from '../../public/app/shared/wbs-structure.js';
import { DOORS } from '../../public/app/shared/lifecycle.js';
import { raidBadges, crOpen } from '../../public/app/shared/badges.js';
import { fsConflict, fsConflicts, fsWarning } from '../../public/app/shared/wbs-deps.js';
import { discardCopy } from '../../public/app/ai/extract.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('#1 workspace label: never "워크스페이스 워크스페이스" (client and server, both invite mails)', () => {
  for (const f of [wsLabel, wsLabelServer]) {
    assert.equal(f('QA 테스트PM님의 워크스페이스'), 'QA 테스트PM님의 워크스페이스');
    assert.equal(f('한빛'), '한빛 워크스페이스');
    assert.equal(f('Hanbit Workspace'), 'Hanbit 워크스페이스');
  }
  const m = memberInviteEmail({ workspaceName: 'QA-20261021 테스트PM님의 워크스페이스', inviterName: '테스트PM', roleLabel: '멤버', link: 'https://x/i', expiresAt: '2026-10-28T00:00:00Z' });
  assert.equal(m.subject, '[RELAI] QA-20261021 테스트PM님의 워크스페이스에 초대되었습니다');
  for (const t of [m.subject, m.html, m.text]) assert.doesNotMatch(t, /워크스페이스 워크스페이스/);
  assert.match(memberInviteEmail({ workspaceName: '한빛', link: 'x', expiresAt: '2026-10-28' }).subject, /한빛 워크스페이스에 초대되었습니다/);
  const pi = platformInviteEmail({ workspaceName: 'A사 워크스페이스', link: 'x', expiresAt: '2026-10-28' });
  for (const t of [pi.subject, pi.html]) assert.doesNotMatch(t, /워크스페이스 워크스페이스/);
  // member home line: the label already ends in 워크스페이스
  assert.match(src('public/app/project/home.js'), /\$\{wsName\(state\.workspace\.name\)\}에 참여 중입니다/);
});

test('#2 home: 진행 중인 프로젝트 counts own projects only; the credit line is the balance, never "무료 제공"', () => {
  const h = src('public/app/project/home.js');
  assert.match(h, /desk && real\.length \? html`진행 중인 프로젝트 \$\{real\.length\}개/);
  assert.doesNotMatch(h, /무료 제공/);
  assert.equal(creditLine({ balance: 40, free_remaining: 40, purchased_remaining: 0 }), 'AI 크레딧 잔액 40');
  assert.equal(creditLine({ balance: 1234 }), 'AI 크레딧 잔액 1,234');
});

test('#3 requirements: quick-add repaints the status segments with the KPI chips (one paint, re-bound)', () => {
  const r = src('public/app/requirements/page.js');
  const paint = r.slice(r.indexOf('const paintKpi = () => {'), r.indexOf('const SEG = ['));
  assert.match(paint, /\[data-status-seg\]/); assert.match(paint, /statusSeg\(/); assert.match(paint, /bindCounts\(nw\)/);
  assert.match(r, /toast\(`\$\{requirement\.display_id\} 추가됨`\); await load\(\); paintKpi\(\);/);
});

test('#4 가이드 이어보기 pill moves off the drawer while one is open (desktop) and hides on a phone', () => {
  const css = src('public/app/app.css');
  assert.match(css, /body:has\(\.rlayout\.has-drawer, #drawer:not\(\[hidden\]\), \.wdrawer, \.aipanel\) \.tourpill\{right:auto;left:calc\(var\(--rail-w,76px\) \+ 16px\)\}/);
});

test('#5 FAQ: 한도를 넘으면 = newest project(s) editable, the rest read-only (10-21 policy, same as 해지 and the terms)', () => {
  const over = FAQ.find(([q]) => q.startsWith('한도를 넘으면'))[1]; const cancel = FAQ.find(([q]) => q.startsWith('해지하면'))[1];
  assert.doesNotMatch(over, /편집이 잠기|새 프로젝트·초대와 편집/);
  assert.match(over, /가장 최근인 프로젝트부터 한도만큼만 편집/); assert.match(over, /조회 전용/); assert.match(over, /삭제되지 않/); assert.match(over, /편집 권한이 돌아와요/);
  assert.match(cancel, /가장 최근인 프로젝트 1개만 편집/);
  assert.match(FREE_POLICY, /가장 최근인 프로젝트 1개만/);
  for (const [, a] of FAQ) assert.doesNotMatch(a, /편집이 잠기/);
});

test('#6 WBS: 07 운영 is a fixed node; 운영 work goes under it; plans without 운영 work are laid out as before', () => {
  assert.deepEqual(FIXED_NODES.filter((n) => !n.optional).map((n) => n.title), ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환·오픈', '운영']);
  assert.equal(inferPlanPhase({ lifecycle_phase: 'OPERATIONS', title: '운영 인수' }), 'OPERATIONS');
  assert.equal(inferPlanPhase({ title: '하자보수 대응' }), 'OPERATIONS');
  assert.equal(inferPlanPhase({ title: '운영 이관 회의' }), 'OPERATIONS');
  assert.equal(inferPlanPhase({ title: '오픈 후 안정화 지원' }), 'TRANSITION_GO_LIVE', '전환·오픈 안정화 stays (skeleton)');
  assert.equal(inferPlanPhase({ title: '데이터 이관' }), 'DATA_MIGRATION');
  assert.equal(sameAsNode('운영'), 'OPERATIONS'); assert.equal(sameAsNode('운영 및 유지보수'), 'OPERATIONS');
  const base = [{ temp_id: 'A', parent_temp_id: null, item_type: 'TASK', title: '화면 설계', project_area: 'ANALYSIS_DESIGN' }];
  const a = allocateSchedule({ items: base, start: '2026-11-02', end: '2027-03-31' });
  assert.deepEqual(a.phases.map((p) => p.title), ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환·오픈']);
  const b = allocateSchedule({ items: [...base, { temp_id: 'O', parent_temp_id: null, item_type: 'TASK', title: '운영 인수인계', phase: 'OPERATIONS' }], start: '2026-11-02', end: '2027-03-31' });
  assert.deepEqual(b.phases.map((p) => p.title), ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환·오픈', '운영']);
  assert.equal(b.phases.at(-1).end, '2027-03-31'); assert.equal(b.phases.reduce((s, p) => s + p.workdays, 0), b.workdays);
  const tr = (r) => r.phases.find((p) => p.plan === 'TRANSITION_GO_LIVE').workdays;
  assert.ok(tr(b) < tr(a), '운영 takes its share from 전환·오픈');
  assert.ok(b.dates.O.planned_start_date >= b.phases.at(-1).start);
});

test('#6 WBS/간트 tabs carry no fixed phase → the chip is the current phase (요구사항 연결 stays 03)', () => {
  const tabs = DOORS('p').find((d) => d.key === 'schedule').tabs;
  assert.equal(tabs.find((t) => t.key === 'wbs').phase, null); assert.equal(tabs.find((t) => t.key === 'gantt').phase, null);
  assert.ok(!tabs.some((t) => t.key === 'wbs-trace'), '일정 › 요구사항 연결 = 요구사항 › 연결 현황 (one screen, founder 2026-10-23)');
  assert.match(src('public/app/frame.js'), /phase: t \? t\.phase \|\| curKey : null/);
});

test('#6 API: opening a WBS creates the 운영 node (8th code with 데이터 이관 off → 7) and 단계 정리 suggests it for 07 work', async () => {
  const { server, client } = await boot();
  try {
    const A = await setup(client, 'p2wbs@x.com');
    const op = await A.c('POST', A.wbs, { item_type: 'TASK', title: '운영 인수 지원', lifecycle_phase: 'OPERATIONS', planned_start_date: '2027-02-01', planned_end_date: '2027-02-10' });
    assert.equal(op.status, 201);
    const tree = (await A.c('GET', A.wbs)).json;
    const nodes = tree.items.filter((i) => i.system_key);
    assert.deepEqual(nodes.map((n) => [n.wbs_code, n.title]), [['1', '착수'], ['2', '요구사항 정의'], ['3', '분석·설계'], ['4', '구현'], ['5', '시험'], ['6', '전환·오픈'], ['7', '운영']]);
    assert.equal(nodes.find((n) => n.title === '운영').lifecycle_phase, 'OPERATIONS');
    const tidy = (await A.c('GET', `${A.wbs}/structure/tidy`)).json;
    assert.equal(tidy.items.find((i) => i.id === op.json.item.id).suggest, 'PHASE:OPERATIONS');
    assert.ok(tidy.nodes.some((n) => n.key === 'PHASE:OPERATIONS'));
  } finally { server.close(); }
});

test('#7 이슈·변경 tabs: 변경 요청 shows its count (작성 중 + 검토 중 + 승인 후 미반영) like 이슈 and 리스크', () => {
  assert.equal(crOpen({ draft: 1, under_review: 2, approved: 1, implemented: 5, rejected: 3 }), 4);
  assert.equal(crOpen(null), 0);
  const b = raidBadges({ active: 4 }, { high_or_critical: 3 }, { draft: 0, under_review: 0, approved: 1 });
  assert.match(b.raid, />4</); assert.match(b.risks, />3</); assert.match(b.changes, />1</);
  assert.equal(raidBadges({ active: 1 }, null, { draft: 0, under_review: 0, approved: 0 }).changes, '');
  assert.match(src('public/app/changes/page.js'), /raidBadges\(g\.issues, g\.risks, summary \|\| g\.changes\)/);
  assert.match(src('public/app/raid/page.js'), /raidBadges\(is, rs, g\.changes\)/);
});

test('#8 new/edit project form is kept across the 768px crossing (draft save/restore covers it)', () => {
  assert.match(src('public/app/core/device.js'), /const OPEN = '[^']*form\[data-keep-draft\]'/);
  assert.match(src('public/app/project/form.js'), /<form class="panel form-panel pform" id="f" novalidate data-keep-draft>/);
});

test('#9 AI extraction: closing with unregistered candidates asks and keeps them; 다시 입력 asks before discarding', () => {
  const c = discardCopy(5, 30);
  assert.match(c.title, /등록하지 않은 요구사항 후보 5건/); assert.match(c.body, /30 크레딧은 이미 차감/); assert.match(c.body, /다시 열면 그대로/);
  assert.equal(c.confirm, '보관하고 닫기'); assert.equal(c.cancel, '계속 검토');
  const e = src('public/app/ai/extract.js'); const ai = src('public/app/shared/ai.js');
  assert.match(e, /d\.setGuard\(/); assert.match(e, /kept\.set\(pid/); assert.match(e, /d\.close\(\{ force: true \}\)/); assert.match(e, /결과 버리고 다시 입력/);
  assert.match(ai, /setGuard\(fn\)/); assert.match(ai, /if \(guard && !force\)/);
});

test('#11 FS rule: successor starting on/before the predecessor end is a conflict; missing dates never are', () => {
  assert.deepEqual(fsConflict({ planned_end_date: '2026-11-20' }, { planned_start_date: '2026-11-16' }), { pred_end: '2026-11-20', succ_start: '2026-11-16' });
  assert.ok(fsConflict({ planned_end_date: '2026-11-20' }, { planned_start_date: '2026-11-20' }), 'same day = before the predecessor finished');
  assert.equal(fsConflict({ planned_end_date: '2026-11-20' }, { planned_start_date: '2026-11-21' }), null);
  assert.equal(fsConflict({ planned_end_date: null }, { planned_start_date: '2026-11-01' }), null);
  assert.ok(fsConflict({ milestone_date: '2026-11-27' }, { planned_start_date: '2026-11-27' }));
  assert.ok(fsConflict({ planned_end: '2026-12-31' }, { planned_start: '2026-12-01' }), 'groups use their roll-up span');
  const m = fsConflicts([{ id: 'a', wbs_code: '2.1', title: '인터뷰', planned_start_date: '2026-11-09', planned_end_date: '2026-11-20', predecessors: [] },
    { id: 'b', wbs_code: '2.2', title: '정의서', planned_start_date: '2026-11-16', planned_end_date: '2026-11-27', predecessors: [{ predecessor_id: 'a' }] }]);
  assert.equal(m.get('b').length, 1); assert.equal(m.has('a'), false);
  assert.match(fsWarning(m.get('b')[0].pred, m.get('b')[0]), /선행 2\.1 인터뷰 종료\(11\/20\) 전에 시작\(11\/16\)/);
  assert.match(src('public/app/wbs/page.js'), /ganttLinks\(rows\.filter/);
});

test('#11 API: adding an FS link that the dates break answers 201 + warning; the item lists dep_conflicts; fixing dates clears it', async () => {
  const { server, client } = await boot();
  try {
    const A = await setup(client, 'p2fs@x.com');
    const a = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '현업 인터뷰', planned_start_date: '2026-11-09', planned_end_date: '2026-11-20' })).json.item;
    const b = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '요구사항 정의서 작성', planned_start_date: '2026-11-16', planned_end_date: '2026-11-27' })).json.item;
    const r = await A.c('POST', `${A.wbs}/${b.id}/dependencies`, { predecessor_id: a.id });
    assert.equal(r.status, 201); assert.match(r.json.warning, /종료\(11\/20\) 전에 시작\(11\/16\)/);
    assert.equal(r.json.item.dep_conflicts.length, 1); assert.equal(r.json.item.dep_conflicts[0].predecessor_id, a.id);
    const ok = await A.c('PATCH', `${A.wbs}/${b.id}`, { planned_start_date: '2026-11-23', planned_end_date: '2026-11-27' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual((await A.c('GET', `${A.wbs}/${b.id}`)).json.item.dep_conflicts, []);
    const c = (await A.c('POST', A.wbs, { item_type: 'TASK', title: '설계', planned_start_date: '2026-12-01', planned_end_date: '2026-12-10' })).json.item;
    const r2 = await A.c('POST', `${A.wbs}/${c.id}/dependencies`, { predecessor_id: b.id });
    assert.equal(r2.status, 201); assert.equal(r2.json.warning, null);
  } finally { server.close(); }
});

test('project fixture helper still matches (guards the shared helper import)', () => { assert.equal(project().project_type, 'NEW_BUILD'); });
