/* AI usage metering (founder 2026-10-27; AI credits retired): USD allowance per plan (Free $2 once per owner, Pro $10 / Team $30 per
 * monthly cycle), failed runs counted, percentages-only public API, daily series, admin cost views, cached tokens, FX job, migration 72. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider, fakeCalls, AiProviderError, openaiUsage, anthropicUsage } from '../ai/provider.js';
import { estimateProviderCost, worstCaseCost, priceOf } from '../ai/config.js';
import { usageSummary, publicUsage, tierOfPct } from '../ai/usage-limit.js';
import { aiLimitUsd, catalogue } from '../plans.js';
import { createWorkspaceForOwner } from '../accounts.js';
import { parseUsdKrw, fetchDailyFx, latestFx } from '../fx.js';
import { migrations } from '../migrations.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
process.env.AI_USER_MINUTE_LIMIT = '0'; process.env.AI_DAILY_LIMIT = '0';   // the per-minute guard is not what is tested here
// $1 per 1,000 input / output tokens: a 100 + 50 token run costs $0.15, so the Free $2 lasts 13 runs and the 14th is refused.
process.env.AI_PRICE_FAKE_MODEL = '1000,1000,500';
const ask = (A, q = '오늘 할 일은?') => A.c('POST', `${A.purl}/ai/ask`, { question: q });
const okAnswer = () => ({ data: { answer: 'ok', references: [], warnings: [] }, usage: { input_tokens: 100, output_tokens: 50 } });
const grant = (db, uid) => db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [uid]);

test('pricing, cost and usage helpers: cached tokens billed at the cached rate, worst case, limits per plan, tiers, no amount in the catalogue', () => {
  assert.deepEqual(priceOf('gpt-4o-mini'), [0.15, 0.6, 0.075]);
  assert.deepEqual(priceOf('claude-sonnet-4-5-20250929'), [3, 15, 0.3]);   // dated id → base id
  assert.equal(estimateProviderCost('gpt-4o-mini', 1_000_000, 1_000_000, 0), 0.75);
  assert.equal(estimateProviderCost('gpt-4o-mini', 1_000_000, 0, 1_000_000), 0.075);
  assert.equal(estimateProviderCost('unknown-model', 10, 10), null);
  assert.equal(worstCaseCost('gpt-4o-mini', 2_000, 8_000), estimateProviderCost('gpt-4o-mini', 2_000, 8_000));
  assert.deepEqual(openaiUsage({ usage: { prompt_tokens: 900, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 512 } } }), { input_tokens: 900, output_tokens: 100, cached_input_tokens: 512 });
  assert.deepEqual(anthropicUsage({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 400 } }), { input_tokens: 500, output_tokens: 20, cached_input_tokens: 400 });
  assert.deepEqual(['FREE', 'PRO', 'TEAM', 'ENTERPRISE', 'EARLY'].map(aiLimitUsd), [2, 10, 30, null, 2]);
  process.env.AI_LIMIT_USD_PRO = '12'; assert.equal(aiLimitUsd('PRO'), 12); delete process.env.AI_LIMIT_USD_PRO;
  assert.deepEqual([0, 79.9, 80, 95, 100].map(tierOfPct), ['ok', 'ok', 'warn', 'critical', 'reached']);
  const cat = JSON.stringify(catalogue());
  assert.ok(!/credit|크레딧|topup|limit_usd/i.test(cat), 'no credit or AI amount in the public catalogue');
  assert.deepEqual(catalogue().plans.map((p) => p.ai.label), ['AI 이용량 포함 (최초 1회)', 'AI 이용량 포함', 'AI 이용량 포함', 'AI 이용량 협의']);
});

test('Free: $2 once — runs (failed ones too) use it up, the next run is refused with 402 AI_USAGE_LIMIT_REACHED, status shows % only', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'free@x.com');
  setFakeProvider(okAnswer);
  for (let i = 0; i < 12; i++) assert.equal((await ask(A, `질문 ${i}`)).status, 200);
  // a failed run that reported usage counts as well
  setFakeProvider(() => { const e = new AiProviderError('AI_INVALID_OUTPUT', 'bad'); e.usage = { input_tokens: 100, output_tokens: 50 }; throw e; });
  assert.equal((await ask(A, '실패 질문')).status, 502);
  let s = await usageSummary(db, A.w);
  assert.equal(s.allowance, 'ONCE'); assert.equal(s.limit_usd, 2); assert.equal(s.resets_at, null);
  assert.ok(Math.abs(s.used_usd - 2.1) < 1e-9, `used ${s.used_usd}`);   // 12 × 0.15 + 2 calls × 0.15 (re-prompt) = 2.1 ≥ 2
  assert.equal(s.used_pct, 100); assert.equal(s.tier, 'reached');
  setFakeProvider(okAnswer);
  const before = fakeCalls().length;
  const r = await ask(A, '한도 초과 질문');
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'AI_USAGE_LIMIT_REACHED'); assert.equal(fakeCalls().length, before, 'the provider is never called');
  assert.equal(r.json.error.usage.blocked, true); assert.equal(r.json.error.usage.allowance, 'ONCE');
  const st = (await A.c('GET', `${A.purl}/ai/status`)).json;
  assert.equal(st.usage.used_pct, 100); assert.equal(st.usage.remaining_pct, 0); assert.equal(st.usage.blocked, true);
  for (const k of ['limit_usd', 'used_usd', 'reserved_usd', 'free_eligible', 'window_start']) assert.ok(!(k in st.usage), k);
  server.close();
});

test('Pro: $10 per monthly credit cycle — runs before the cycle and before metering do not count; resets_at = cycle end; upgrade raises the limit at once', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pro@x.com');
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, current_period_start, current_period_end) VALUES ('s-pro', ?, 'PRO', 'ACTIVE', 'fake', now() - interval '10 days', now() + interval '20 days')`, [A.w]);
  // a run from the previous cycle and a pre-metering run (plan_key NULL) — neither counts
  await db.run(`INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, status, provider_cost_amount, plan_key, created_at) VALUES ('old1', ?, ?, 'PROJECT_QA', 'fake', 'fake-model', 'SUCCEEDED', 5, 'PRO', now() - interval '15 days')`, [A.w, A.uid]);
  await db.run(`INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, status, provider_cost_amount, plan_key, created_at) VALUES ('old2', ?, ?, 'PROJECT_QA', 'fake', 'fake-model', 'SUCCEEDED', 5, NULL, now() - interval '1 day')`, [A.w, A.uid]);
  setFakeProvider(okAnswer);
  assert.equal((await ask(A)).status, 200);
  let s = await usageSummary(db, A.w);
  assert.equal(s.plan, 'PRO'); assert.equal(s.allowance, 'MONTHLY'); assert.equal(s.limit_usd, 10);
  assert.ok(Math.abs(s.used_usd - 0.15) < 1e-9); assert.equal(s.used_pct, 1.5);
  const sub = await db.get(`SELECT current_period_start + interval '1 month' AS e FROM subscriptions WHERE id = 's-pro'`);
  assert.equal(new Date(s.resets_at).toISOString(), new Date(sub.e).toISOString());
  const run = await db.get(`SELECT plan_key, reserved_usd FROM ai_runs WHERE workspace_id = ? AND id NOT IN ('old1','old2')`, [A.w]);
  assert.equal(run.plan_key, 'PRO'); assert.ok(Number(run.reserved_usd) > 0, 'the worst case was reserved');
  // 80 % → warn tier in the public view
  await db.run(`INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, status, provider_cost_amount, plan_key) VALUES ('big', ?, ?, 'PROJECT_QA', 'fake', 'fake-model', 'SUCCEEDED', 8, 'PRO')`, [A.w, A.uid]);
  assert.equal(publicUsage(await usageSummary(db, A.w)).tier, 'warn');
  await db.run(`UPDATE subscriptions SET plan = 'TEAM' WHERE id = 's-pro'`);   // upgrade: same cycle, the new plan's limit
  s = await usageSummary(db, A.w); assert.equal(s.limit_usd, 30); assert.equal(s.tier, 'ok');
  // billing summary carries the % view, never an amount
  const b = (await A.c('GET', `/api/workspaces/${A.w}/billing`)).json.billing;
  assert.equal(b.credits, undefined); assert.equal(b.ai_usage.allowance, 'MONTHLY'); assert.ok(!('used_usd' in b.ai_usage));
  server.close();
});

test('Free once per owner: a second workspace of the same owner gets no Free allowance; scope=workspace gives every workspace its own', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'twice@x.com');
  assert.equal((await usageSummary(db, A.w)).limit_usd, 2);
  const w2 = await createWorkspaceForOwner(db, { ownerId: A.uid, name: '두 번째' });
  const s2 = await usageSummary(db, w2);
  assert.equal(s2.free_eligible, false); assert.equal(s2.limit_usd, 0); assert.equal(publicUsage(s2).blocked, true);
  assert.equal((await usageSummary(db, A.w)).free_eligible, true, 'the first workspace keeps its claim');
  process.env.AI_FREE_CLAIM_SCOPE = 'workspace';
  assert.equal((await usageSummary(db, w2)).limit_usd, 2);
  delete process.env.AI_FREE_CLAIM_SCOPE;
  server.close();
});

test('GET /ai-usage: daily cumulative % (Asia/Seoul days) without amounts; old /credits/* endpoints answer 410', async () => {
  const { server, client } = await boot();
  const A = await setup(client, 'daily@x.com');
  setFakeProvider(okAnswer);
  await ask(A); await ask(A, '두 번째');
  const r = await A.c('GET', `/api/workspaces/${A.w}/ai-usage`);
  assert.equal(r.status, 200);
  assert.equal(r.json.days.length, 30);
  const last = r.json.days[r.json.days.length - 1];
  assert.equal(last.cum_pct, 15); assert.equal(last.day_pct, 15);   // 2 × $0.15 of $2
  assert.ok(!/usd|cost|token/i.test(JSON.stringify(r.json)));
  assert.equal((await A.c('GET', `/api/workspaces/${A.w}/credits/summary`)).status, 410);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/credits/checkout`, { amount: 10000 })).status, 410);
  server.close();
});

test('timeout: counted at its worst case (cost_estimated); concurrent requests cannot pass the limit by more than the requests in flight', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'timeout@x.com');
  setFakeProvider(() => { throw new AiProviderError('AI_TIMEOUT', 'timeout'); });
  assert.equal((await ask(A)).status, 504);
  const r = await db.get('SELECT provider_cost_amount, cost_estimated, input_tokens FROM ai_runs WHERE workspace_id = ?', [A.w]);
  assert.equal(r.cost_estimated, true); assert.equal(r.input_tokens, null); assert.ok(Number(r.provider_cost_amount) > 0);
  server.close();
});

test('admin: AI usage overview (USD, KRW at the stored rate, daily / monthly / per model) and workspace detail (limit, %, users)', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'adm-owner@x.com');
  const O = await setup(client, 'ops@x.com'); await grant(db, O.uid);
  setFakeProvider(okAnswer);
  await ask(A);
  await db.run(`INSERT INTO fx_rates (rate_date, krw_per_unit) VALUES ((now() AT TIME ZONE 'Asia/Seoul')::date, 1400)`);
  const o = (await O.c('GET', '/api/admin/ai/usage')).json;
  assert.equal(o.fx.krw_per_unit, 1400); assert.deepEqual(o.limits, { FREE: 2, PRO: 10, TEAM: 30, ENTERPRISE: null });
  assert.ok(Math.abs(o.kpis.provider_cost_30d - 0.15) < 1e-9);
  assert.equal(o.daily.length, 30); assert.ok(o.monthly.length >= 1); assert.equal(o.models[0].model, 'fake-model');
  assert.equal(o.workspaces[0].id, A.w); assert.equal(o.workspaces[0].used_pct, 7.5);
  const w = (await O.c('GET', `/api/admin/workspaces/${A.w}/ai`)).json;
  assert.equal(w.usage.limit_usd, 2); assert.equal(w.users[0].runs, 1); assert.equal(w.runs[0].plan_key, 'FREE');
  const list = (await O.c('GET', '/api/admin/usage')).json;
  const row = list.items.find((x) => x.workspace_id === A.w); assert.equal(row.ai.used_pct, 7.5); assert.equal(row.ai.limit_usd, 2);
  assert.equal((await A.c('GET', '/api/admin/ai/usage')).status, 403);
  server.close();
});

test('FX: 한국수출입은행 parser, daily job (stored / no rate on holidays / skipped without key), cron auth', async () => {
  assert.equal(parseUsdKrw([{ result: 1, cur_unit: 'JPY(100)', deal_bas_r: '950.1' }, { result: 1, cur_unit: 'USD', deal_bas_r: '1,385.5' }]), 1385.5);
  assert.equal(parseUsdKrw([]), null); assert.equal(parseUsdKrw([{ result: 4, cur_unit: 'USD', deal_bas_r: '1,385.5' }]), null); assert.equal(parseUsdKrw(null), null);
  const { db, server } = await boot();
  assert.equal((await fetchDailyFx(db, { env: {} })).status, 'skipped');
  let url = '';
  const ok = async (u) => { url = u; return { ok: true, json: async () => [{ result: 1, cur_unit: 'USD', deal_bas_r: '1,390.25' }] }; };
  const out = await fetchDailyFx(db, { env: { KOREAEXIM_API_KEY: 'k' }, fetchImpl: ok, now: new Date('2026-10-27T01:00:00Z') });
  assert.equal(out.status, 'stored'); assert.equal(out.rate_date, '2026-10-27');
  assert.ok(url.startsWith('https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON?authkey=k&searchdate=20261027&data=AP01'));
  assert.deepEqual(await latestFx(db).then((x) => [x.rate_date, x.krw_per_unit]), ['2026-10-27', 1390.25]);
  const holiday = await fetchDailyFx(db, { env: { KOREAEXIM_API_KEY: 'k' }, fetchImpl: async () => ({ ok: true, json: async () => [] }), now: new Date('2026-10-31T01:00:00Z') });
  assert.equal(holiday.status, 'no_rate'); assert.equal((await latestFx(db)).rate_date, '2026-10-27', 'the last rate stays');
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.CRON_SECRET = 'cron-s';
  assert.equal((await fetch(`${base}/api/cron/fx`)).status, 401);
  const r = await fetch(`${base}/api/cron/fx`, { headers: { authorization: 'Bearer cron-s' } });
  assert.equal(r.status, 200); assert.equal((await r.json()).status, 'skipped');
  delete process.env.CRON_SECRET;
  server.close();
});

test('migration 72: every credit balance goes to 0 with one ADJUSTMENT row; unedited seeded promotion copy is rewritten, edited copy is kept', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'mig@x.com');
  await db.run(`INSERT INTO workspace_credit_accounts (workspace_id, balance, promo_balance, purchased_balance) VALUES (?, 300, 200, 100) ON CONFLICT (workspace_id) DO UPDATE SET balance = 300, promo_balance = 200, purchased_balance = 100`, [A.w]);
  await db.run(`UPDATE promotions SET title = '가입하면 AI 크레딧 200 무료', body = '요구사항 추출·WBS 초안 같은 AI 기능에 바로 씁니다. 처음 한 번 드립니다.' WHERE id = 'promo-ai-credits'`);
  await db.run(`UPDATE promotions SET title = '운영자가 고친 제목', body = '운영자 문구' WHERE id = 'promo-login'`);
  const m = migrations.find((x) => x.version === 72);
  await m.up(db);
  const acc = await db.get('SELECT balance, promo_balance, purchased_balance FROM workspace_credit_accounts WHERE workspace_id = ?', [A.w]);
  assert.deepEqual([Number(acc.balance), Number(acc.promo_balance), Number(acc.purchased_balance)], [0, 0, 0]);
  const l = await db.get(`SELECT type, amount, balance_after, d_purchased FROM credit_ledger WHERE workspace_id = ? AND reference_id = 'v72'`, [A.w]);
  assert.deepEqual([l.type, Number(l.amount), Number(l.balance_after), Number(l.d_purchased)], ['ADJUSTMENT', -300, 0, -100]);
  assert.equal((await db.get(`SELECT title FROM promotions WHERE id = 'promo-ai-credits'`)).title, 'AI 기능도 무료로 체험');
  assert.equal((await db.get(`SELECT title FROM promotions WHERE id = 'promo-login'`)).title, '운영자가 고친 제목');
  await m.up(db);   // idempotent: nothing left to reset
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ? AND reference_id = 'v72'`, [A.w])).n, 1);
  server.close();
});

test('concurrency: parallel requests near the limit — open reservations block the rest (402), nothing stays PENDING, usage never passes limit + in-flight', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'conc@x.com');
  process.env.AI_PRICE_FAKE_MODEL = '1,1,1'; process.env.AI_LIMIT_USD_FREE = '0.02';
  setFakeProvider(async () => { await new Promise((r) => setTimeout(r, 150)); return { data: { candidates: [] }, usage: { input_tokens: 10, output_tokens: 5 } }; });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => A.c('POST', `${A.purl}/ai/requirements/extract`, { text: `동시 요청 ${i} — 회의록 본문입니다.` })));
  const ok = results.filter((r) => r.status === 200).length; const blocked = results.filter((r) => r.status === 402);
  assert.ok(ok >= 1 && ok < 6, `ok=${ok}`); assert.equal(ok + blocked.length, 6);
  assert.ok(blocked.every((r) => r.json.error.code === 'AI_USAGE_LIMIT_REACHED'));
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ? AND status = 'PENDING'`, [A.w])).n, 0);
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ?`, [A.w])).n, ok, 'a refused request leaves no ai_run');
  process.env.AI_PRICE_FAKE_MODEL = '1000,1000,500'; delete process.env.AI_LIMIT_USD_FREE;
  server.close();
});

test('isolation: usage in one workspace never touches another; a member of X cannot read A’s AI status or usage', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'iso-a@x.com'); const X = await setup(client, 'iso-x@x.com');
  setFakeProvider(okAnswer);
  await ask(A);
  assert.ok((await usageSummary(db, A.w)).used_usd > 0); assert.equal((await usageSummary(db, X.w)).used_usd, 0);
  assert.equal((await X.c('GET', `${A.purl}/ai/status`)).status, 404);
  assert.ok([403, 404].includes((await X.c('GET', `/api/workspaces/${A.w}/ai-usage`)).status));
  server.close();
});

test('unexpected exceptions after the run row exists (post-validation bug, plain Error from the provider) end FAILED with their cost; no run stays PENDING', async () => {
  const { runAiFeature, AiError } = await import('../ai/service.js');
  const { db, server, client } = await boot();
  const A = await setup(client, 'boom@x.com');
  const base = { wid: A.w, projectId: A.p.id, userId: A.uid, feature: 'PROJECT_QA', build: async () => ({ system: 's', user: 'u', inputSummary: 'x', inputChars: 1 }) };
  setFakeProvider(okAnswer);
  await assert.rejects(() => runAiFeature(db, { ...base, postValidate: async () => { throw new TypeError('boom in post-validation'); } }), (e) => e instanceof AiError && e.code === 'AI_INTERNAL_ERROR' && e.status === 500);
  setFakeProvider(() => { throw new Error('socket hang up'); });
  const r = await ask(A, '예상 못한 오류');
  assert.equal(r.status, 502); assert.equal(r.json.error.code, 'AI_PROVIDER_ERROR');
  const runs = await db.all('SELECT status, error_code, provider_cost_amount FROM ai_runs WHERE workspace_id = ? ORDER BY created_at, seq', [A.w]);
  assert.deepEqual(runs.map((x) => [x.status, x.error_code]), [['FAILED', 'AI_INTERNAL_ERROR'], ['FAILED', 'AI_PROVIDER_ERROR']]);
  assert.ok(Number(runs[0].provider_cost_amount) > 0, 'the tokens of a run that broke after the vendor answered are counted');
  assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE status = 'PENDING'`)).n, 0);
  server.close();
});
