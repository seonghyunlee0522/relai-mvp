/* batch7 #18 / B8: AI 테스트 시나리오 (TEST_GENERATION) — 30 credits, refund on failure, ≤ 20 requirements, default selection,
 * out-of-scope ids dropped, commit creates tests + REQUIREMENT links with test_data / environment, nothing written by the AI call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider, fakeCalls, AiProviderError, autoReply } from '../ai/provider.js';
import { environmentLines } from '../ai/test-gen.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.DEV_INITIAL_AI_CREDITS = '100'; process.env.AI_MODEL = '';
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT; delete process.env.AI_CREDIT_COST_TEST_GENERATION;

const balance = async (db, wid) => (await db.get('SELECT balance FROM workspace_credit_accounts WHERE workspace_id = ?', [wid])).balance;
async function project(client, email) {
  const A = await setup(client, email);
  const ids = [];
  for (const t of ['청구 조회', '청구 접수', '알림 발송']) {
    const r = (await A.c('POST', A.req, { title: t, scope: 'IN_SCOPE', status: 'CONFIRMED', criteria: [`${t} 결과가 화면에 보인다`] })).json.requirement;
    ids.push(r);
  }
  return { A, reqs: ids };
}

test('generate: 30 credits, scenarios grouped per requirement with test_data / environment / steps; default = 확정·범위 내·미연결; nothing saved', async () => {
  const { db, server, client } = await boot();
  const { A, reqs } = await project(client, 'tg1@x.com');
  setFakeProvider((req) => ({ data: autoReply(req), usage: { input_tokens: 800, output_tokens: 600 } }));
  const r = await A.c('POST', `${A.purl}/ai/tests/generate`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.run.credit_cost, 30); assert.equal(await balance(db, A.w), 70);
  assert.deepEqual(r.json.requirements.map((g) => g.requirement.display_id), reqs.map((x) => x.display_id));
  const sc = r.json.requirements[0].scenarios[0];
  assert.deepEqual(Object.keys(sc).sort(), ['environment', 'expected_result', 'precondition', 'steps', 'temp_id', 'test_data', 'title', 'type']);
  assert.ok(sc.steps.length && sc.steps[0].expected); assert.ok(r.json.requirements.every((g) => g.scenarios.length >= 1 && g.scenarios.length <= 3));
  assert.match(fakeCalls()[0].user, /REQ-001 \[UNSPECIFIED · UNSPECIFIED\] 청구 조회/); assert.match(fakeCalls()[0].user, /완료 조건:/);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM test_cases WHERE project_id = ?', [A.p.id])).n, 0, 'the AI call writes nothing');
  // explicit selection; > 20 refused (400, no charge)
  const one = await A.c('POST', `${A.purl}/ai/tests/generate`, { requirement_ids: [reqs[1].id] });
  assert.deepEqual(one.json.requirements.map((g) => g.requirement.id), [reqs[1].id]);
  assert.equal((await A.c('POST', `${A.purl}/ai/tests/generate`, { requirement_ids: Array.from({ length: 21 }, (_, i) => `x${i}`) })).status, 400);
  assert.equal(await balance(db, A.w), 40);
  server.close();
});

test('generate: ids outside the selection are dropped with a warning; provider failure refunds (no charge)', async () => {
  const { db, server, client } = await boot();
  const { A, reqs } = await project(client, 'tg2@x.com');
  setFakeProvider(() => ({ data: { requirements: [{ requirement_id: 'REQ-999', scenarios: [{ title: 'x', type: '정상', precondition: '', test_data: '', environment: '', steps: [], expected_result: '' }] },
    { requirement_id: reqs[0].display_id, scenarios: [{ title: '정상 조회', type: '정상', precondition: 'p', test_data: 'd', environment: '', steps: [{ instruction: 'a', expected: 'b' }], expected_result: 'ok' }] }], notes: [] } }));
  const r = await A.c('POST', `${A.purl}/ai/tests/generate`, { requirement_ids: [reqs[0].id] });
  assert.equal(r.json.requirements.length, 1); assert.ok(r.json.warnings.some((w) => w.includes('REQ-999')));
  const before = await balance(db, A.w);
  setFakeProvider(() => { throw new AiProviderError('AI_TIMEOUT', 'timeout'); });
  assert.equal((await A.c('POST', `${A.purl}/ai/tests/generate`, { requirement_ids: [reqs[0].id] })).status, 504);
  assert.equal(await balance(db, A.w), before, 'failure → released, nothing charged');
  server.close();
});

test('commit: ticked scenarios → tests (DRAFT, test_data, environment, steps) + REQUIREMENT links + history; archived project refused', async () => {
  const { db, server, client } = await boot();
  const { A, reqs } = await project(client, 'tg3@x.com');
  const body = { scenarios: [
    { requirement_id: reqs[0].id, title: '정상 조회', type: '정상', precondition: '로그인', test_data: '일반 사용자 계정', environment: 'PC Chrome', steps: [{ instruction: '조회', expected: '목록' }], expected_result: '결과 표시' },
    { requirement_id: reqs[0].id, title: '빈 결과', type: '경계', precondition: '', test_data: '', environment: '', steps: [], expected_result: '안내 문구' },
  ] };
  const c = await A.c('POST', `${A.purl}/ai/tests/commit`, body);
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.deepEqual(c.json.created.map((t) => t.title), [`${reqs[0].display_id} 정상 조회`, `${reqs[0].display_id} 빈 결과`]);
  const t = (await A.c('GET', `${A.purl}/tests/${c.json.created[0].id}`)).json.test;
  assert.equal(t.test_data, '일반 사용자 계정'); assert.equal(t.environment, 'PC Chrome'); assert.equal(t.status, 'DRAFT'); assert.equal(t.steps.length, 1);
  assert.deepEqual(t.links.requirements.map((l) => l.target_id), [reqs[0].id]);
  assert.ok(t.history.some((h) => h.action_type === 'GENERATED' && h.new_value === 'AI 시나리오에서 생성'));
  assert.equal(c.json.tests.target_tested, 1);
  assert.equal((await A.c('POST', `${A.purl}/ai/tests/commit`, { scenarios: [{ requirement_id: 'nope', title: 'x' }] })).status, 400);
  assert.equal((await A.c('POST', `${A.purl}/ai/tests/commit`, { scenarios: [] })).status, 400);
  await db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE id = ?`, [A.p.id]);
  assert.equal((await A.c('POST', `${A.purl}/ai/tests/commit`, body)).status, 409);
  server.close();
});

test('environmentLines: any shape of 적용 환경 (T2 contract) becomes short lines', () => {
  assert.deepEqual(environmentLines(null), []);
  assert.deepEqual(environmentLines('- PC Chrome\n- 모바일 Safari'), ['PC Chrome', '모바일 Safari']);
  assert.deepEqual(environmentLines(JSON.stringify([{ label: '브라우저', value: 'Chrome, Edge' }, 'iOS 17'])), ['브라우저: Chrome, Edge', 'iOS 17']);
  assert.deepEqual(environmentLines({ pc: ['Chrome'], mobile: [] }), ['pc: Chrome']);
});
