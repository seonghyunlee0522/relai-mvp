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

/* ---------- Phase 11 final stabilization ---------- */
import { ensureAccount, reserveRun, settleRun, SETTLEMENT_CONFLICT } from '../ai/credits.js';
import { runAiFeature, AiError } from '../ai/service.js';
const ledgerSum = async (db, wid) => (await db.get('SELECT COALESCE(SUM(amount), 0) AS s, (SELECT balance_after FROM credit_ledger WHERE workspace_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1) AS last FROM credit_ledger WHERE workspace_id = ?', [wid, wid]));
const consistent = async (db, wid) => { const acc = await account(db, wid); const l = await ledgerSum(db, wid); assert.equal(acc.balance, l.s, 'balance == sum(ledger)'); assert.equal(acc.balance, l.last ?? 0, 'balance == last balance_after'); assert.ok(acc.balance >= 0); };

test('initial grant policy: production trial (PROMOTION 100, once) vs DEV_INITIAL (PLAN_GRANT, replaces trial); re-touching an account never grants again; trial can be 0', async () => {
  const { db, server, client } = await boot();
  delete process.env.DEV_INITIAL_AI_CREDITS; delete process.env.AI_INITIAL_TRIAL_CREDITS;
  const P = await setup(client, 'prod@x.com');
  let led = await ledgerOf(db, P.w);
  assert.equal(led.length, 1); assert.equal(led[0].type, 'PROMOTION'); assert.equal(led[0].amount, 100); assert.equal(led[0].reason, '신규 Workspace AI 시작 Credit'); assert.equal(led[0].reference_id, 'AI_INITIAL_TRIAL_CREDITS');
  assert.equal((await status(P)).credits.balance, 100);
  // re-reads / explicit ensureAccount with any policy → no second grant
  await ensureAccount(db, P.w); await ensureAccount(db, P.w, { devInitial: 500, trial: 999 }); await status(P);
  process.env.DEV_INITIAL_AI_CREDITS = '500'; await status(P);
  led = await ledgerOf(db, P.w); assert.equal(led.length, 1); assert.equal((await account(db, P.w)).balance, 100); assert.equal((await account(db, P.w)).lifetime_granted, 100);
  // DEV_INITIAL set → PLAN_GRANT only, trial NOT added on top
  const D = await setup(client, 'dev@x.com');
  led = await ledgerOf(db, D.w); assert.equal(led.length, 1); assert.equal(led[0].type, 'PLAN_GRANT'); assert.equal(led[0].amount, 500); assert.equal((await account(db, D.w)).balance, 500);
  // trial disabled, no dev grant → 0
  delete process.env.DEV_INITIAL_AI_CREDITS; process.env.AI_INITIAL_TRIAL_CREDITS = '0';
  const Z = await setup(client, 'zero@x.com');
  assert.equal((await ledgerOf(db, Z.w)).length, 0); assert.equal((await account(db, Z.w)).balance, 0);
  const r = await Z.c('POST', `${Z.purl}/ai/ask`, { question: '잔액 0에서 질문' }); assert.equal(r.status, 402);
  // concurrent first touch of a brand-new account (no signup path) → exactly one grant
  process.env.AI_INITIAL_TRIAL_CREDITS = '100';
  const wid = (await db.get(`INSERT INTO workspaces (id, name, owner_id) VALUES (gen_random_uuid()::text, 'raw', ?) RETURNING id`, [P.uid])).id;
  await Promise.all([1, 2, 3, 4].map(() => ensureAccount(db, wid)));
  assert.equal((await ledgerOf(db, wid)).length, 1); assert.equal((await account(db, wid)).balance, 100);
  for (const w of [P.w, D.w, Z.w, wid]) await consistent(db, w);
  process.env.DEV_INITIAL_AI_CREDITS = '100'; delete process.env.AI_INITIAL_TRIAL_CREDITS;
  server.close();
});

test('settlement race: a reservation that expired (TTL) and was overtaken by other runs settles as AI_CREDIT_SETTLEMENT_CONFLICT — no charge, no negative balance, ledger == balance', async () => {
  const { db, server, client } = await boot();
  process.env.DEV_INITIAL_AI_CREDITS = '25';
  const A = await setup(client, 'race@x.com');
  process.env.DEV_INITIAL_AI_CREDITS = '100';
  // run A: reserved (cost 10) but "forgotten" → pretend it is older than the reservation TTL
  const runA = await reserveRun(db, { wid: A.w, projectId: A.p.id, userId: A.uid, feature: 'REQUIREMENT_EXTRACTION', provider: 'fake', model: 'fake-model', inputSummary: 'stale', cost: 10 });
  await db.run(`UPDATE ai_runs SET created_at = now() - interval '11 minutes' WHERE id = ?`, [runA.id]);
  // two other runs now see 25 available (A's reservation expired) and spend 20
  setFakeProvider(() => ({ data: { candidates: [] } }));
  assert.equal((await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '첫 번째 회의록 본문입니다.' })).status, 200);
  assert.equal((await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '두 번째 회의록 본문입니다.' })).status, 200);
  assert.equal((await account(db, A.w)).balance, 5);
  // the stale run finally settles "successfully": balance 5 < cost 10 → conflict, nothing charged
  const s = await settleRun(db, runA.id, { success: true, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 700000 });
  assert.deepEqual(s, { balance: 5, credit_status: 'RELEASED', conflict: true });
  const run = await db.get('SELECT * FROM ai_runs WHERE id = ?', [runA.id]);
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.credit_status, 'RELEASED'); assert.equal(run.error_code, SETTLEMENT_CONFLICT); assert.ok(run.error_message.includes('5'));
  assert.equal((await account(db, A.w)).balance, 5);
  assert.deepEqual((await ledgerOf(db, A.w)).map((l) => l.amount), [25, -10, -10]);
  await consistent(db, A.w);
  // settling again is a no-op (already settled)
  assert.equal(await settleRun(db, runA.id, { success: true }), null);
  assert.equal(await settleRun(db, runA.id, { success: false }), null);
  // partial case: balance 5 and a late run costing exactly 5 still charges normally (>= rule)
  const runB = await reserveRun(db, { wid: A.w, projectId: A.p.id, userId: A.uid, feature: 'PROJECT_QA', provider: 'fake', model: 'fake-model', inputSummary: 'x', cost: 5 });
  const s2 = await settleRun(db, runB.id, { success: true }); assert.equal(s2.credit_status, 'CHARGED'); assert.equal(s2.balance, 0);
  await consistent(db, A.w);
  // admin surfaces the conflict
  const OPS = await setup(client, 'ops2@x.com', '운영자'); await grantAdmin(db, OPS.uid);
  const ov = (await OPS.c('GET', '/api/admin/ai/usage')).json;
  assert.equal(ov.kpis.settlement_conflicts_30d, 1); assert.ok(ov.recent_failures.some((f) => f.id === runA.id && f.error_code === SETTLEMENT_CONFLICT));
  const wu = (await OPS.c('GET', `/api/admin/workspaces/${A.w}/ai`)).json;
  assert.ok(wu.runs.some((r) => r.id === runA.id && r.status === 'SUCCEEDED' && r.credit_status === 'RELEASED' && r.error_code === SETTLEMENT_CONFLICT));
  server.close();
});

test('unexpected exceptions after reservation (post-validation bug, provider throwing a plain Error) always end FAILED/RELEASED; no run stays PENDING; settle is not duplicated', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'boom@x.com');
  const before = (await account(db, A.w)).balance;
  const base = { wid: A.w, projectId: A.p.id, userId: A.uid, feature: 'PROJECT_QA', build: async () => ({ system: 's', user: 'u', inputSummary: 'x', inputChars: 1 }) };
  // 1. postValidate throws a non-AI error
  setFakeProvider(() => ({ data: { answer: 'ok', references: [], warnings: [] } }));
  await assert.rejects(() => runAiFeature(db, { ...base, postValidate: async () => { throw new TypeError('boom in post-validation'); } }), (e) => e instanceof AiError && e.code === 'AI_INTERNAL_ERROR' && e.status === 500);
  // 2. provider throws a plain Error (not AiProviderError)
  setFakeProvider(() => { throw new Error('socket hang up'); });
  const r = await A.c('POST', `${A.purl}/ai/ask`, { question: '예상 못한 오류' });
  assert.equal(r.status, 502); assert.equal(r.json.error.code, 'AI_PROVIDER_ERROR');
  // 3. schema failure path and 4. AI post-validation rejection still release
  setFakeProvider(() => ({ data: { nope: true } }));
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '스키마 오류' })).status, 502);
  setFakeProvider(() => ({ data: { items: [], notes: [] } }));
  const q = (await A.c('POST', A.req, { title: 'r' })).json.requirement;
  assert.equal((await A.c('POST', `${A.purl}/ai/wbs/generate`, { requirement_ids: [q.id] })).status, 502);   // "AI가 WBS 항목을 제안하지 않았습니다"
  const runs = await db.all('SELECT status, credit_status, error_code FROM ai_runs WHERE workspace_id = ? ORDER BY created_at, seq', [A.w]);
  assert.equal(runs.length, 4);
  assert.deepEqual(runs.map((x) => [x.status, x.credit_status]), Array(4).fill(['FAILED', 'RELEASED']));
  assert.deepEqual(runs.map((x) => x.error_code), ['AI_INTERNAL_ERROR', 'AI_PROVIDER_ERROR', 'AI_INVALID_OUTPUT', 'AI_INVALID_OUTPUT']);
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE status = 'PENDING' OR credit_status = 'RESERVED'`)).n, 0);
  assert.equal((await account(db, A.w)).balance, before); assert.equal((await ledgerOf(db, A.w)).length, 1);
  await consistent(db, A.w);
  assert.equal((await status(A)).credits.reserved, 0);
  server.close();
});
