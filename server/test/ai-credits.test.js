/* Phase 11 credit metering: account creation, admin grant + audit, ledger, charge on success / release on failure,
 * concurrency (never negative), insufficient credit response, isolation, feature cost config, token + provider cost capture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider, AiProviderError } from '../ai/provider.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.DEV_INITIAL_AI_CREDITS = '100'; process.env.AI_MODEL = '';
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT;
const grantAdmin = (db, uid) => db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [uid]);
const answer = () => ({ data: { answer: 'ok', references: [], warnings: [] }, usage: { input_tokens: 1000, output_tokens: 500 } });
const ledgerOf = (db, wid) => db.all('SELECT * FROM credit_ledger WHERE workspace_id = ? ORDER BY created_at, seq', [wid]);
const account = (db, wid) => db.get('SELECT * FROM workspace_credit_accounts WHERE workspace_id = ?', [wid]);
const status = async (A) => (await A.c('GET', `${A.purl}/ai/status`)).json;

test('account: created at signup with DEV_INITIAL_AI_CREDITS through a PLAN_GRANT ledger row; balance exposed on /ai/status; ledger is the audit source', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'a@x.com');
  const acc = await account(db, A.w);
  assert.equal(acc.balance, 100); assert.equal(acc.lifetime_granted, 100); assert.equal(acc.lifetime_used, 0);
  const led = await ledgerOf(db, A.w);
  assert.equal(led.length, 1); assert.equal(led[0].type, 'PLAN_GRANT'); assert.equal(led[0].amount, 100); assert.equal(led[0].balance_after, 100); assert.ok(led[0].reason.includes('DEV_INITIAL_AI_CREDITS'));
  const s = await status(A);
  assert.deepEqual(s.credits, { balance: 100, reserved: 0, available: 100, lifetime_granted: 100, lifetime_used: 0 });
  assert.deepEqual(s.costs, { REQUIREMENT_EXTRACTION: 10, WBS_GENERATION: 15, CHANGE_IMPACT: 8, PROJECT_QA: 3 });
  server.close();
});

test('AI success charges exactly the feature cost (ledger AI_USAGE linked to the run); failure releases without any ledger row; tokens + provider cost recorded', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'b@x.com');
  setFakeProvider(answer);
  const r = await A.c('POST', `${A.purl}/ai/ask`, { question: '오늘 할 일은?' });
  assert.equal(r.status, 200); assert.equal(r.json.run.credit_cost, 3); assert.equal(r.json.run.balance, 97);
  let led = await ledgerOf(db, A.w);
  assert.equal(led.length, 2); assert.equal(led[1].type, 'AI_USAGE'); assert.equal(led[1].amount, -3); assert.equal(led[1].balance_after, 97); assert.equal(led[1].ai_run_id, r.json.run.id); assert.equal(led[1].reason, 'PROJECT_QA');
  let acc = await account(db, A.w); assert.equal(acc.balance, 97); assert.equal(acc.lifetime_used, 3);
  const run = await db.get('SELECT * FROM ai_runs WHERE id = ?', [r.json.run.id]);
  assert.equal(run.input_tokens, 1000); assert.equal(run.output_tokens, 500); assert.equal(run.credit_cost, 3); assert.equal(run.credit_status, 'CHARGED'); assert.equal(run.provider_cost_amount, 0);   // fake-model price = 0
  // priced model (cost estimate from the internal table), still the fake transport
  process.env.AI_MODEL = 'gpt-4o-mini';
  const r2 = await A.c('POST', `${A.purl}/ai/ask`, { question: '오늘 할 일은?' });
  const run2 = await db.get('SELECT * FROM ai_runs WHERE id = ?', [r2.json.run.id]);
  assert.equal(run2.model, 'gpt-4o-mini'); assert.equal(run2.provider_cost_amount, 0.00045); assert.equal(run2.provider_cost_currency, 'USD');
  process.env.AI_MODEL = '';
  // failure → RELEASED, no ledger row, balance unchanged
  setFakeProvider(() => { throw new AiProviderError('AI_TIMEOUT', 'timeout'); });
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '오늘 할 일은?' })).status, 504);
  led = await ledgerOf(db, A.w); assert.equal(led.length, 3);
  acc = await account(db, A.w); assert.equal(acc.balance, 94);
  assert.deepEqual((await db.all('SELECT credit_status FROM ai_runs WHERE workspace_id = ? ORDER BY created_at, seq', [A.w])).map((x) => x.credit_status), ['CHARGED', 'CHARGED', 'RELEASED']);
  assert.equal((await status(A)).credits.reserved, 0);
  server.close();
});

test('insufficient credit: AI_CREDIT_INSUFFICIENT with balance/required/feature, provider never called, no ai_run charged', async () => {
  const { db, server, client } = await boot();
  process.env.DEV_INITIAL_AI_CREDITS = '4';
  const A = await setup(client, 'c@x.com');
  process.env.DEV_INITIAL_AI_CREDITS = '100';
  let called = 0; setFakeProvider(() => { called++; return answer(); });
  const r = await A.c('POST', `${A.purl}/ai/wbs/generate`, { requirement_ids: [(await A.c('POST', A.req, { title: 'r' })).json.requirement.id] });
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'AI_CREDIT_INSUFFICIENT');
  assert.equal(r.json.error.balance, 4); assert.equal(r.json.error.required, 15); assert.equal(r.json.error.feature, 'WBS_GENERATION');
  assert.equal(called, 0); assert.equal((await db.get('SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ?', [A.w])).n, 0);
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '3 credit 질문은 가능' })).status, 200);
  assert.equal((await account(db, A.w)).balance, 1);
  server.close();
});

test('concurrency: parallel requests against a small balance — only as many as the balance covers succeed, balance never goes negative', async () => {
  const { db, server, client } = await boot();
  process.env.DEV_INITIAL_AI_CREDITS = '25';
  const A = await setup(client, 'd@x.com');
  process.env.DEV_INITIAL_AI_CREDITS = '100';
  setFakeProvider(async () => { await new Promise((r) => setTimeout(r, 150)); return { data: { candidates: [] }, usage: { input_tokens: 10, output_tokens: 5 } }; });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => A.c('POST', `${A.purl}/ai/requirements/extract`, { text: `동시 요청 ${i} — 회의록 본문입니다.` })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 402, 402, 402, 402]);   // cost 10 each, balance 25 → exactly two succeed
  const acc = await account(db, A.w);
  assert.equal(acc.balance, 5); assert.equal(acc.lifetime_used, 20);
  const led = await ledgerOf(db, A.w);
  assert.deepEqual(led.map((l) => l.amount), [25, -10, -10]); assert.deepEqual(led.map((l) => l.balance_after), [25, 15, 5]);
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ? AND status = 'PENDING'`, [A.w])).n, 0);
  server.close();
});

test('admin: SYSTEM_ADMIN grants/adjusts credits with a required reason → ledger + admin audit in one transaction; non-admin 403; adjustment below zero refused; workspace AI usage view', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'e@x.com');
  const OPS = await setup(client, 'ops@x.com', '운영자'); await grantAdmin(db, OPS.uid);
  assert.equal((await A.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: 500, reason: 'x' })).status, 403);
  assert.equal((await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: 500 })).status, 400);              // reason required
  assert.equal((await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: 0, reason: 'zero' })).status, 400);
  assert.equal((await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: 1.5, reason: 'frac' })).status, 400);
  const g = await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: 500, reason: '파일럿 고객 지원' });
  assert.equal(g.status, 200, JSON.stringify(g.json)); assert.equal(g.json.balance, 600);
  const led = await ledgerOf(db, A.w);
  assert.equal(led[1].type, 'ADMIN_GRANT'); assert.equal(led[1].amount, 500); assert.equal(led[1].balance_after, 600); assert.equal(led[1].reason, '파일럿 고객 지원'); assert.equal(led[1].created_by, OPS.uid); assert.equal(led[1].reference_type, 'ADMIN_AUDIT');
  const audit = await db.get(`SELECT * FROM admin_audit_logs WHERE id = ?`, [led[1].reference_id]);
  assert.equal(audit.action, 'GRANT_AI_CREDITS'); assert.equal(audit.target_id, A.w); assert.equal(audit.metadata.amount, 500); assert.equal(audit.metadata.reason, '파일럿 고객 지원');
  const adj = await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: -100, reason: '오지급 정정' });
  assert.equal(adj.json.balance, 500); assert.equal((await ledgerOf(db, A.w))[2].type, 'ADJUSTMENT');
  const tooMuch = await OPS.c('POST', `/api/admin/workspaces/${A.w}/ai/credits`, { amount: -10000, reason: '불가' });
  assert.equal(tooMuch.status, 409); assert.equal((await account(db, A.w)).balance, 500);
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM admin_audit_logs WHERE target_id = ?`, [A.w])).n, 2, 'refused adjustment leaves no audit row');
  assert.equal((await OPS.c('POST', `/api/admin/workspaces/00000000-0000-0000-0000-000000000000/ai/credits`, { amount: 5, reason: 'x' })).status, 404);
  // audit list shows the new action with a readable summary
  const al = (await OPS.c('GET', `/api/admin/audit?action=GRANT_AI_CREDITS`)).json;
  assert.equal(al.items.length, 1); assert.ok(al.items[0].summary.includes('+500'));
  // usage views
  setFakeProvider(answer);
  await A.c('POST', `${A.purl}/ai/ask`, { question: '사용량 테스트' });
  const wu = (await OPS.c('GET', `/api/admin/workspaces/${A.w}/ai`)).json;
  assert.equal(wu.account.balance, 497); assert.equal(wu.kpis.runs_30d, 1); assert.equal(wu.kpis.success_rate_30d, 100); assert.equal(wu.kpis.input_tokens_30d, 1000);
  assert.equal(wu.features.find((f) => f.feature === 'PROJECT_QA').credits, 3); assert.equal(wu.features.length, 4); assert.equal(wu.ledger.length, 4); assert.equal(wu.runs.length, 1); assert.equal(wu.users[0].runs, 1);
  const ov = (await OPS.c('GET', '/api/admin/ai/usage')).json;
  assert.equal(ov.kpis.runs_today, 1); assert.equal(ov.kpis.credits_30d, 3); assert.equal(ov.workspaces[0].id, A.w); assert.equal(ov.config.enabled, true);
  assert.ok(!JSON.stringify(ov).includes('사용량 테스트'), 'admin usage never carries prompt text');
  assert.equal((await A.c('GET', '/api/admin/ai/usage')).status, 403);
  server.close();
});

test('workspace isolation: usage in one workspace never touches another; members of X cannot read A credit status; feature cost env override', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'g@x.com'); const X = await setup(client, 'h@x.com');
  process.env.AI_CREDIT_COST_PROJECT_QA = '7';
  assert.equal((await status(A)).costs.PROJECT_QA, 7);
  setFakeProvider(answer);
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '격리 테스트' })).json.run.credit_cost, 7);
  delete process.env.AI_CREDIT_COST_PROJECT_QA;
  assert.equal((await account(db, A.w)).balance, 93); assert.equal((await account(db, X.w)).balance, 100);
  assert.equal((await ledgerOf(db, X.w)).length, 1);
  assert.equal((await X.c('GET', `${A.purl}/ai/status`)).status, 404);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ?', [X.w])).n, 0);
  server.close();
});
