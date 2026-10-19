/* AI on with OpenAI (AI_PROVIDER=openai, default model) — every feature through the real OpenAI adapter against a mocked
 * api.openai.com (server/test/openai-mock.js; no network, no real key): strict-schema acceptance, schema-valid output, exact
 * credit charge at the current prices, per-feature token caps, and timeout / 429 / 5xx / invalid JSON / truncated / refusal
 * → Korean message, credits released. Also: AI off stays graceful, and the privacy page names OpenAI as an overseas processor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { openaiMock, strictProblems } from './openai-mock.js';
import { openaiSchema } from '../ai/provider.js';
import { SCHEMAS, PLANNER_SCHEMAS, validateSchema } from '../ai/schemas.js';
import { aiConfig, featureCreditCost, maxOutputTokensFor, FEATURES } from '../ai/config.js';
import { privacyMarkdown } from '../legal.js';

Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-NOT-REAL', AI_ENABLED: 'true', DEV_INITIAL_AI_CREDITS: '1000', AI_MODEL: '', AI_REQUEST_TIMEOUT_MS: '1000' });
for (const f of FEATURES) delete process.env[`AI_CREDIT_COST_${f}`];
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT; delete process.env.AI_MAX_OUTPUT_TOKENS;

const mock = openaiMock();
const realFetch = globalThis.fetch;
globalThis.fetch = mock.fetch(realFetch);
test.after(() => { globalThis.fetch = realFetch; });

const HANGUL = /[가-힣]/;
const status = async (A) => (await A.c('GET', `${A.purl}/ai/status`)).json;
const bal = async (A) => (await status(A)).credits.available;
const lastRun = (db, wid) => db.get('SELECT * FROM ai_runs WHERE workspace_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1', [wid]);

test('config: openai + key → enabled, default model gpt-4o-mini, sane per-feature output caps (≤ 8,000)', () => {
  const c = aiConfig();
  assert.equal(c.enabled, true); assert.equal(c.provider, 'openai'); assert.equal(c.model, 'gpt-4o-mini');
  for (const f of FEATURES) { const n = maxOutputTokensFor(f); assert.ok(n >= 1000 && n <= 8000, `${f} ${n}`); }
  assert.equal(maxOutputTokensFor('PROJECT_QA'), 1500);
  process.env.AI_MAX_OUTPUT_TOKENS = '2000'; assert.equal(maxOutputTokensFor('WBS_GENERATION'), 2000); assert.equal(maxOutputTokensFor('PROJECT_QA'), 1500); delete process.env.AI_MAX_OUTPUT_TOKENS;
});

test('every schema sent to OpenAI passes strict mode (no size keywords, all properties required, additionalProperties:false)', () => {
  for (const [k, s] of Object.entries({ ...SCHEMAS, ...PLANNER_SCHEMAS })) {
    assert.deepEqual(strictProblems(openaiSchema(s)), [], k);
    assert.ok(strictProblems(s).length > 0, `${k}: the raw schema has maxLength etc. (why openaiSchema exists)`);
  }
});

test('all AI features through the OpenAI adapter: valid output per schemas.js, exact credit charge, model + token cap per call', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'oa1@x.com');
  const st = await status(A);
  assert.equal(st.enabled, true); assert.equal(st.provider, 'openai'); assert.equal(st.model, 'gpt-4o-mini');
  const reqs = []; for (const t of ['로그인 기능', '권한 관리', '주문 조회']) reqs.push((await A.c('POST', A.req, { title: t, status: 'CONFIRMED', scope: 'IN_SCOPE' })).json.requirement);
  const cr = (await A.c('POST', `${A.purl}/changes`, { title: '결제 수단 추가' })).json.change;

  const run = async (label, feature, schema, call) => {
    const before = await bal(A); mock.calls = [];
    const r = await call();
    assert.equal(r.status, label === 'planner questions' ? 201 : 200, `${label}: ${JSON.stringify(r.json?.error || '')}`);
    assert.deepEqual(validateSchema(schema, mock.lastData), [], `${label}: mock output valid`);
    const c = mock.calls.at(-1);
    assert.equal(c.model, 'gpt-4o-mini', label); assert.equal(c.max_completion_tokens, maxOutputTokensFor(feature), label);
    assert.equal(before - await bal(A), featureCreditCost(feature), `${label}: charged ${featureCreditCost(feature)}`);
    const ar = await lastRun(db, A.w);
    assert.equal(ar.provider, 'openai'); assert.equal(ar.status, 'SUCCEEDED'); assert.ok(ar.input_tokens > 0);
    return r.json;
  };
  const ex = await run('extract', 'REQUIREMENT_EXTRACTION', SCHEMAS.REQUIREMENT_EXTRACTION, () => A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '회원은 이메일로 로그인할 수 있어야 한다. 관리자는 권한을 부여할 수 있어야 한다. 응답 속도는 2초 이내여야 한다.' }));
  assert.ok(ex.candidates.length >= 2); assert.equal(ex.run.credit_cost, 30);
  const wb = await run('wbs draft', 'WBS_GENERATION', SCHEMAS.WBS_GENERATION, () => A.c('POST', `${A.purl}/ai/wbs/generate`, { requirement_ids: reqs.map((r) => r.id) }));
  assert.ok(wb.items.length > 0); assert.equal(wb.run.credit_cost, 50);
  const im = await run('impact', 'CHANGE_IMPACT', SCHEMAS.CHANGE_IMPACT, () => A.c('POST', `${A.purl}/changes/${cr.id}/ai/impact`, {}));
  assert.equal(typeof im.summary, 'string'); assert.equal(im.run.credit_cost, 20);
  const qa = await run('ask', 'PROJECT_QA', SCHEMAS.PROJECT_QA, () => A.c('POST', `${A.purl}/ai/ask`, { question: '이번 주 확인할 일은?' }));
  assert.ok(qa.answer); assert.equal(qa.run.credit_cost, 10);
  const pl = await run('planner questions', 'WBS_PLAN_QUESTIONS', PLANNER_SCHEMAS.wbs_planning_questions, () => A.c('POST', `${A.purl}/ai/wbs-plans`, { all: true }));
  const plan = pl.plan;
  mock.transform = (name, d) => (name === 'project_wbs_draft' ? { ...d, items: d.items.filter((i) => !['TESTING', 'UAT'].includes(i.project_area)) } : d);   // leave a gap for 보완
  const g = await run('planner draft', 'WBS_GENERATION', PLANNER_SCHEMAS.project_wbs_draft, () => A.c('POST', `${A.purl}/ai/wbs-plans/${plan.id}/generate`, {}));
  mock.transform = null; assert.ok(g.plan);
  await run('planner fix', 'WBS_PLAN_FIX', PLANNER_SCHEMAS.wbs_plan_fix, () => A.c('POST', `${A.purl}/ai/wbs-plans/${plan.id}/fix`, {}));
  assert.equal(await bal(A), 1000 - 30 - 50 - 20 - 10 - 50);
  server.close();
});

test('failures: 429 / 5xx / timeout / invalid JSON / truncated / refusal → Korean message, no vendor text, credits released; one transient retry; oversize output clamped', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'oa2@x.com');
  const ask = () => A.c('POST', `${A.purl}/ai/ask`, { question: '비밀 질문 내용 ZQX' });
  const failsKorean = async (label, script, httpStatus, code) => {
    const before = await bal(A); mock.script = script; mock.calls = [];
    const r = await ask();
    assert.equal(r.status, httpStatus, `${label}: ${JSON.stringify(r.json)}`); assert.equal(r.json.error.code, code, label);
    const msg = r.json.error.message;
    assert.ok(HANGUL.test(msg), `${label}: Korean (${msg})`);
    assert.ok(!/org-TEST|Rate limit|server had an error|sk-test|schema/i.test(msg), `${label}: no vendor text (${msg})`);
    assert.equal(await bal(A), before, `${label}: credits released`);
    const run = await lastRun(db, A.w);
    assert.equal(run.status, 'FAILED'); assert.equal(run.credit_status, 'RELEASED'); assert.equal(run.error_code, code);
    assert.ok(!String(run.error_message).includes('ZQX') && !String(run.input_summary || '').includes('sk-test'), `${label}: no prompt text / key on the run`);
    mock.script = [];
    return { run, calls: mock.calls.length };
  };
  let x = await failsKorean('429 twice', ['429', '429'], 502, 'AI_PROVIDER_ERROR');
  assert.equal(x.calls, 2, '429 retried once'); assert.ok(x.run.error_message.includes('HTTP 429'), 'operators still see the vendor status');
  x = await failsKorean('500 twice', ['500', '500'], 502, 'AI_PROVIDER_ERROR'); assert.equal(x.calls, 2);
  x = await failsKorean('timeout', ['hang'], 504, 'AI_TIMEOUT'); assert.equal(x.calls, 1, 'timeout not retried');
  x = await failsKorean('invalid JSON twice', ['invalid_json', 'invalid_json'], 502, 'AI_INVALID_OUTPUT'); assert.equal(x.calls, 2, 're-prompted once');
  await failsKorean('truncated (finish_reason length) twice', ['length', 'length'], 502, 'AI_INVALID_OUTPUT');
  await failsKorean('refusal twice', ['refusal', 'refusal'], 502, 'AI_INVALID_OUTPUT');

  // one transient failure, then success → charged once
  let before = await bal(A); mock.script = ['429'];
  let r = await ask(); assert.equal(r.status, 200); assert.equal(before - await bal(A), 10);
  // one invalid JSON, then success → charged once
  before = await bal(A); mock.script = ['invalid_json'];
  r = await ask(); assert.equal(r.status, 200); assert.equal(before - await bal(A), 10);
  // the model overshoots maxLength (strict mode cannot enforce it) → clamped, not failed
  mock.script = ['oversize'];
  r = await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '회원은 이메일로 로그인할 수 있어야 한다. 관리자는 권한을 부여할 수 있어야 한다.' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(r.json.candidates.every((c) => c.title.length <= 200 && c.description.length <= 5000));
  server.close();
});

test('AI off (AI_ENABLED=false or no key): status enabled:false, no provider/model exposed, features 503 AI_DISABLED in Korean, provider never called', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'oa3@x.com');
  for (const [k, v] of [['AI_ENABLED', 'false'], ['OPENAI_API_KEY', '']]) {
    const keep = process.env[k]; process.env[k] = v; mock.calls = [];
    const st = await status(A);
    assert.equal(st.enabled, false, k); assert.equal(st.provider, null); assert.equal(st.model, null); assert.equal(st.credits, null);
    const r = await A.c('POST', `${A.purl}/ai/ask`, { question: '안녕' });
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'AI_DISABLED'); assert.ok(HANGUL.test(r.json.error.message));
    assert.equal(mock.calls.length, 0);
    process.env[k] = keep;
  }
  server.close();
});

test('privacy: OpenAI (US) listed as AI processor and overseas recipient with the items, purpose and retention', () => {
  const p = privacyMarkdown();
  const row = p.split('\n').find((l) => l.startsWith('| OpenAI, L.L.C. (privacy@openai.com)'));
  assert.ok(row, 'overseas transfer row');
  for (const s of ['미국', 'AI 기능 사용 시 입력한 프로젝트 내용', 'AI 생성', 'OpenAI의 API 데이터 정책', '모델 학습에 이용하지 않습니다']) assert.ok(row.includes(s), s);
  assert.ok(p.includes('| OpenAI, L.L.C.(AI 기능을 사용하는 경우) | AI 기능 처리'), 'processor (위탁) row');
});
