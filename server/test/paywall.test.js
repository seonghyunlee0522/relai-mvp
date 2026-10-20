/* batch7 T5 plan limits + paywall (founder decisions 2026-10-20):
 *   FREE = 2 projects (other FREE limits unchanged), early access is no longer unlimited (FREE limits), existing data over a
 *   limit is never deleted or made read-only, every refusal is a 402 pointing at /app/billing/plans, and the 500 free AI credits
 *   are granted ONCE per workspace (migration 52 tops up only workspaces that never got a starter grant). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, project } from './api-helpers.js';
import { PLANS, PLANS_URL } from '../plans.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { ensureAccount, applyCredits, grantMissingWorkspaceStarter } from '../ai/credits.js';
import { migrations, LATEST_VERSION } from '../migrations.js';
import { setFakeProvider } from '../ai/provider.js';

process.env.PLAN_LIMITS = 'on';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
for (const k of ['DEV_INITIAL_AI_CREDITS', 'AI_INITIAL_TRIAL_CREDITS', 'EARLY_ACCESS_CUTOFF', 'EARLY_ACCESS_LAUNCH', 'AI_CREDIT_COST_PROJECT_QA']) delete process.env[k];

const ws = (w) => `/api/workspaces/${w}`;
const starterRows = (db, w) => db.all(`SELECT amount, reference_id FROM credit_ledger WHERE workspace_id = ? AND type IN ('PROMOTION','PLAN_GRANT') ORDER BY seq`, [w]);
const bal = async (db, w) => Number((await db.get('SELECT balance FROM workspace_credit_accounts WHERE workspace_id = ?', [w])).balance);

test('catalogue: FREE = 2 projects, other FREE limits unchanged; EARLY carries the FREE limits', () => {
  assert.deepEqual({ ...PLANS.FREE.limits }, { projects: 2, members: 3, requirements: 50, wbs: 100, weekly_reports: 8 });
  assert.deepEqual({ ...PLANS.EARLY.limits }, { ...PLANS.FREE.limits });
  assert.equal(PLANS_URL, '/app/billing/plans');
});

test('2-project limit: the 3rd project is 402 with the upsell target; early access (future early_access_until) is on FREE limits', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw1@x.com');
  assert.equal((await db.get('SELECT early_access_until FROM workspaces WHERE id = ?', [A.w])).early_access_until, null);   // b7-fix: signup grants no early access
  await db.run(`UPDATE workspaces SET early_access_until = now() + interval '1 year' WHERE id = ?`, [A.w]);   // an old stamped account …
  assert.equal(await effectivePlan(db, A.w), 'FREE');         // … is on the Free limits too
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' }))).status, 201);
  const r = await A.c('POST', `${ws(A.w)}/projects`, project({ name: '셋째' }));
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'plan_limit_reached');
  assert.equal(r.json.error.limit.dimension, 'projects'); assert.equal(r.json.error.limit.limit, 2); assert.equal(r.json.error.limit.plan, 'FREE');
  assert.equal(r.json.error.upgrade.url, '/app/billing/plans');
  assert.match(r.json.error.message, /무료 플랜의 진행 중 프로젝트 한도\(2\)에 도달했습니다/);
  assert.doesNotMatch(r.json.error.message, /₩/);
  // samples do not count
  assert.equal((await A.c('GET', `${ws(A.w)}/billing`)).json.billing.usage.dims.find((d) => d.key === 'projects').used, 2);
  server.close();
});

test('101st WBS item is blocked (402 → plans page); the 100 kept', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw2@x.com');
  const rows = Array.from({ length: 100 }, (_, i) => ({ row: i + 2, values: { code: String(i + 1), title: `w${i}` } }));
  assert.equal((await A.c('POST', `${A.wbs}/import`, { rows })).status, 200);
  const r = await A.c('POST', A.wbs, { title: '101번째', item_type: 'TASK' });
  assert.equal(r.status, 402); assert.equal(r.json.error.limit.dimension, 'wbs'); assert.equal(r.json.error.limit.used, 100);
  assert.equal(r.json.error.upgrade.url, PLANS_URL);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND system_key IS NULL', [A.p.id])).n), 100);
  server.close();
});

test('over-limit existing data is untouched: kept, readable and editable; only NEW rows are refused', async () => {
  const { db, server, client } = await boot();
  process.env.PLAN_LIMITS = 'off';   // build a workspace that was unlimited (former early access)
  const A = await setup(client, 'pw3@x.com');
  for (const n of ['2', '3', '4']) assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: `p${n}` }))).status, 201);
  for (let i = 0; i < 55; i++) assert.equal((await A.c('POST', A.req, { title: `R${i}` })).status, 201);
  process.env.PLAN_LIMITS = 'on';
  const list = (await A.c('GET', `${ws(A.w)}/projects`)).json.projects.filter((p) => !p.sample_key);
  assert.equal(list.length, 4);
  const reqs = (await A.c('GET', A.req)).json.requirements;
  assert.equal(reqs.length, 55);
  const upd = await A.c('PATCH', `${A.req}/${reqs[0].id}`, { title: '수정 가능' });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal((await A.c('POST', A.req, { title: '새 항목' })).status, 402);
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: 'p5' }))).status, 402);
  assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND sample_key IS NULL AND status != 'ARCHIVED'`, [A.w])).n), 4);
  const u = (await A.c('GET', `${ws(A.w)}/billing`)).json.billing.usage;
  assert.equal(u.dims.find((d) => d.key === 'projects').used, 4); assert.equal(u.dims.find((d) => d.key === 'requirements').used, 55);
  server.close();
});

test('AI with insufficient credits: 402 AI_CREDIT_INSUFFICIENT carrying the plans page', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw4@x.com');
  await applyCredits(db, { wid: A.w, amount: -495, type: 'ADJUSTMENT', reason: 'drain' });
  setFakeProvider(() => ({ data: { answer: 'ok', references: [], warnings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }));
  const r = await A.c('POST', `${A.purl}/ai/ask`, { question: '진행 상황은?' });
  assert.equal(r.status, 402); assert.equal(r.json.error.code, 'AI_CREDIT_INSUFFICIENT'); assert.equal(r.json.error.upgrade.url, PLANS_URL);
  server.close();
});

test('500 free credits once per WORKSPACE: a 2nd project grants nothing; migration 52 tops up only never-granted workspaces, idempotently', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pw5@x.com');
  assert.equal((await A.c('POST', `${ws(A.w)}/projects`, project({ name: '둘째' }))).status, 201);
  assert.deepEqual((await starterRows(db, A.w)).map((r) => [Number(r.amount), r.reference_id]), [[500, 'AI_INITIAL_TRIAL_CREDITS']]);
  assert.equal((await A.c('GET', `${ws(A.w)}/billing`)).json.billing.starter_credits, 500);

  const mk = async (name) => {
    const id = (await db.get(`INSERT INTO workspaces (id, name, owner_id) VALUES (gen_random_uuid()::text, ?, ?) RETURNING id`, [name, A.uid])).id;
    await db.run(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'OWNER')`, [id, A.uid]);
    return id;
  };
  const none = await mk('무지급');            // account created while the trial was 0 → never got a starter grant
  await ensureAccount(db, none, { trial: 0, devInitial: 0 });
  const rich = await mk('관리자 지급');        // no starter, but an admin grant already above 500 → nothing added
  await ensureAccount(db, rich, { trial: 0, devInitial: 0 });
  await applyCredits(db, { wid: rich, amount: 700, type: 'ADMIN_GRANT', reason: 'ops' });
  const part = await mk('일부 사용');          // no starter, 120 left from an admin grant → topped up to 500
  await ensureAccount(db, part, { trial: 0, devInitial: 0 });
  await applyCredits(db, { wid: part, amount: 120, type: 'ADMIN_GRANT', reason: 'ops' });

  const bare = await mk('계정 없음');          // review P2-2: no credit account at all → opened by the migration and counted
  assert.deepEqual(await grantMissingWorkspaceStarter(db), { granted: 3 });
  assert.equal(await bal(db, bare), 500);
  assert.equal(await bal(db, none), 500); assert.equal(await bal(db, part), 500); assert.equal(await bal(db, rich), 700);
  assert.equal(await bal(db, A.w), 500);   // already had its grant → untouched
  // idempotent: spending and re-running never grants twice
  await applyCredits(db, { wid: none, amount: -300, type: 'ADJUSTMENT', reason: 'used' });
  assert.deepEqual(await grantMissingWorkspaceStarter(db), { granted: 0 });
  assert.equal(await bal(db, none), 200);
  assert.deepEqual((await starterRows(db, none)).map((r) => [Number(r.amount), r.reference_id]), [[500, 'STARTER_WORKSPACE_52']]);
  // registered as the additive migration 52
  assert.ok(migrations.some((m) => m.version === 52 && /STARTER_WORKSPACE_52/.test(m.name)));
  server.close();
});
