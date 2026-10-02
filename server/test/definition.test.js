/* 프로젝트 정의: partial save, section completion = INITIATION step status, change-after-completion + confirm/reopen,
 * legacy step notes preserved, home (guide) reflects, archived/tenant guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';

test('definition: save partial, complete needs content, step status is the single source, changed-after-completion → confirm, reopen', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const D = `${A.purl}/definition`;
  let r = await A.c('GET', D); assert.equal(r.status, 200);
  assert.deepEqual(r.json.sections.map((s) => s.key), ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS']);
  assert.ok(r.json.sections.every((s) => s.status === 'TODO' && !s.ready && s.missing.length === 1 && s.step_id));
  assert.deepEqual(r.json.progress, { done: 0, total: 5, percent: 0 });
  // completing an empty section is refused
  r = await A.c('POST', `${D}/sections/GOALS/complete`, {}); assert.equal(r.status, 400); assert.match(r.json.error.fields.section, /목표/);
  // partial save: goal only
  r = await A.c('PUT', D, { goal: '  계약 검토 리드타임 50% 단축  ' }); assert.equal(r.status, 200);
  assert.equal(r.json.definition.goal, '계약 검토 리드타임 50% 단축'); assert.equal(r.json.sections[0].ready, true); assert.equal(r.json.sections[0].status, 'TODO');
  assert.ok(r.json.definition.section_updated.GOALS && !r.json.definition.section_updated.SCOPE);
  // lists: strings or {text}; blanks dropped; ids kept
  r = await A.c('PUT', D, { success_criteria: ['평균 2영업일 이내', { text: '' }, { id: 'keep-1', text: '만족도 4.5 이상' }], scope_in: [{ text: '국문 표준계약 5종' }], scope_out: ['영문 계약'] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.definition.success_criteria.map((x) => x.text), ['평균 2영업일 이내', '만족도 4.5 이상']);
  assert.equal(r.json.definition.success_criteria[1].id, 'keep-1'); assert.equal(r.json.definition.goal, '계약 검토 리드타임 50% 단축');   // untouched field kept
  // stakeholders: multiple, name-or-org required, authority enum
  r = await A.c('PUT', D, { stakeholders: [{ name: '김부장', org: '고객사 법무팀', role: '고객 PM', area: '요구사항 확정', authority: 'DECIDER' }, { org: '당사', role: '개발 리드' }, { name: '', org: '', role: '빈 행' }] });
  assert.equal(r.status, 400); assert.match(r.json.error.fields.stakeholders, /이름 또는 조직/);
  r = await A.c('PUT', D, { stakeholders: [{ name: '김부장', org: '고객사 법무팀', role: '고객 PM', area: '요구사항 확정', authority: 'DECIDER' }, { org: '당사', role: '개발 리드' }, { name: '', org: '', role: '' }] });
  assert.equal(r.status, 200); assert.equal(r.json.definition.stakeholders.length, 2); assert.equal(r.json.definition.stakeholders[0].authority, 'DECIDER');
  assert.equal((await A.c('PUT', D, { stakeholders: [{ name: 'x', authority: 'KING' }] })).status, 400);
  // key dates: title required when date given; sorted by date
  r = await A.c('PUT', D, { key_dates: [{ title: '최종 검수', date: '2026-12-20' }, { title: '킥오프', date: '2026-11-03' }, { title: '', date: '2026-11-05' }] }); assert.equal(r.status, 400);
  r = await A.c('PUT', D, { key_dates: [{ title: '최종 검수', date: '2026-12-20' }, { title: '킥오프', date: '2026-11-03' }] });
  assert.deepEqual(r.json.definition.key_dates.map((x) => x.title), ['킥오프', '최종 검수']);
  r = await A.c('PUT', D, { operations: { meetings: '주간 정례 월 10시', reporting: '', communication: 'Slack', decisions: '' }, memo: '참고' });
  assert.equal(r.json.definition.operations.meetings, '주간 정례 월 10시'); assert.equal(r.json.definition.memo, '참고');
  assert.ok(r.json.sections.every((s) => s.ready), JSON.stringify(r.json.sections.map((s) => [s.key, s.missing])));
  assert.equal((await A.c('PUT', D, {})).status, 400);
  // complete GOALS → INITIATION step COMPLETED (guide reads it)
  r = await A.c('POST', `${D}/sections/GOALS/complete`, {}); assert.equal(r.status, 200);
  assert.equal(r.json.sections[0].status, 'COMPLETED'); assert.equal(r.json.progress.done, 1);
  const g = r.json.guide; const init = g.phases.find((p) => p.phase_key === 'INITIATION');
  assert.equal(init.steps.find((s) => s.step_key === 'GOALS').status, 'COMPLETED'); assert.equal(init.progress.done, 1);
  assert.equal(g.definition.progress.done, 1); assert.deepEqual(g.definition.needs_review, []);
  // edit after completion → stays completed, flagged; confirm clears; reopen → TODO
  await new Promise((res) => setTimeout(res, 20));
  r = await A.c('PUT', D, { goal: '수정된 목표' });
  assert.equal(r.json.sections[0].status, 'COMPLETED'); assert.equal(r.json.sections[0].changed_after_completion, true); assert.deepEqual(r.json.needs_review, ['GOALS']);
  r = await A.c('GET', A.purl); assert.deepEqual(r.json.definition.needs_review, ['GOALS']);
  r = await A.c('POST', `${D}/sections/GOALS/confirm`, {}); assert.equal(r.json.sections[0].changed_after_completion, false); assert.deepEqual(r.json.needs_review, []);
  r = await A.c('POST', `${D}/sections/GOALS/reopen`, {}); assert.equal(r.json.sections[0].status, 'TODO'); assert.equal(r.json.progress.done, 0);
  assert.equal(r.json.definition.goal, '수정된 목표');   // reopen keeps content
  // MILESTONES is also ready via WBS milestones alone
  r = await A.c('PUT', D, { key_dates: [] }); assert.equal(r.json.sections[3].ready, false);
  await A.c('POST', A.wbs, { item_type: 'MILESTONE', title: '오픈', milestone_date: '2026-12-30' });
  r = await A.c('GET', D); assert.equal(r.json.sections[3].ready, true); assert.equal(r.json.wbs_milestones.length, 1);
  assert.equal((await A.c('POST', `${D}/sections/NOPE/complete`, {})).status, 404);
  server.close();
});

test('definition: legacy step notes are preserved and surfaced read-only; step completion done the old way shows up too', async () => {
  const { server, client } = await boot();
  const A = await setup(client);
  const g = (await A.c('GET', A.purl)).json; const init = g.phases.find((p) => p.phase_key === 'INITIATION');
  const scope = init.steps.find((s) => s.step_key === 'SCOPE');
  await A.c('PATCH', `${A.purl}/steps/${scope.id}`, { note: '기존 메모: 범위는 계약서 기준', status: 'COMPLETED' });
  const d = (await A.c('GET', `${A.purl}/definition`)).json; const sec = d.sections.find((s) => s.key === 'SCOPE');
  assert.equal(sec.legacy_note, '기존 메모: 범위는 계약서 기준'); assert.equal(sec.status, 'COMPLETED'); assert.equal(sec.changed_after_completion, false);
  assert.deepEqual(d.definition.scope_in, []);   // never auto-filled from the note
  await A.c('PUT', `${A.purl}/definition`, { scope_in: ['A'] });
  const g2 = (await A.c('GET', A.purl)).json;
  assert.equal(g2.phases.find((p) => p.phase_key === 'INITIATION').steps.find((s) => s.step_key === 'SCOPE').note, '기존 메모: 범위는 계약서 기준');   // note untouched
  server.close();
});

test('definition: archived project read-only; other workspace cannot read', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const B = await setup(client, 'b@x.com');
  assert.equal((await B.c('GET', `${A.purl}/definition`)).status, 404);
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', `${A.purl}/definition`)).status, 200);
  assert.equal((await A.c('PUT', `${A.purl}/definition`, { goal: 'x' })).status, 409);
  assert.equal((await A.c('POST', `${A.purl}/definition/sections/GOALS/complete`, {})).status, 409);
  server.close();
});
