/* batch7 T1 server halves: B5 the guidance carries the top-bar strip fields (short_title ≤ 30 chars, cta_label, href) and #22 the
 * 활동 기록 page pages back with ?before=<ISO>. The UI halves live in scripts/e2e-batch7-shell.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGuidance, shortTitle } from '../guidance.js';
import { boot, setup } from './api-helpers.js';

test('B5: shortTitle keeps ≤ 30 characters (… when cut); every guidance answer carries short_title / cta_label / href', () => {
  assert.equal(shortTitle('요구사항을 수집하고 정리하세요'), '요구사항을 수집하고 정리하세요');
  const long = '가'.repeat(40); const cut = shortTitle(long);
  assert.equal([...cut].length, 30); assert.ok(cut.endsWith('…'));
  const g = projectGuidance({ project: { id: 'p1', current_phase: 'REQUIREMENTS', status: 'ACTIVE' }, phase: { phase_key: 'REQUIREMENTS', name: '요구사항 정의', sequence: 2 }, next_phase: { name: '분석·설계', sequence: 3 }, stats: { requirements: { total: 0 } } });
  assert.equal(g.short_title, shortTitle(g.title));
  assert.equal(g.cta_label, g.primary_action.label);
  assert.equal(g.href, g.primary_action.href);
  assert.ok([...g.short_title].length <= 30);
});

test('#22: GET …/activity?before= returns only older events; more says whether something older exists', async () => {
  const { client } = await boot();
  const A = await setup(client, 'act@x.com', '기록자');
  for (let i = 1; i <= 5; i++) assert.equal((await A.c('POST', A.req, { title: `요구사항 ${i}` })).status, 201);
  const url = `/api/workspaces/${A.w}/projects/${A.p.id}/activity`;
  const all = (await A.c('GET', `${url}?limit=200`)).json;
  assert.ok(all.items.length >= 5); assert.equal(all.more, false);
  const first = (await A.c('GET', `${url}?limit=2`)).json;
  assert.equal(first.items.length, 2); assert.equal(first.more, true);
  const next = (await A.c('GET', `${url}?limit=200&before=${encodeURIComponent(first.items[1].at)}`)).json;
  assert.ok(next.items.length >= 1);
  assert.ok(next.items.every((x) => x.at < first.items[1].at), 'only strictly older events');
  const bad = await A.c('GET', `${url}?before=not-a-date`);
  assert.equal(bad.status, 200); assert.equal(bad.json.items.length, all.items.length);   // an invalid before is ignored
});
