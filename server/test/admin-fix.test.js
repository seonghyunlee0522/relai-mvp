/* Admin test fixes (Jim, 2026-10-19): P1-1 early-access workspaces read EARLY (not FREE) in 워크스페이스 list/detail, 회원 detail and
 * AI 사용량; P2-1 감사 로그 labels; P2-2 AI 사용량 shows AI runs / API cost over the last 30 days and the allowance used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boot, setup, project } from './api-helpers.js';
import { AUDIT_ACTIONS, bootstrapSystemAdmin, listAudit } from '../admin.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { ACTIONS } from '../../public/app/shared/admin-labels.js';

/** Signs up a service operator (system_role granted straight in the DB). */
async function operator(db, client, email = 'ops@relai.io') {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '운영자', email, password: 'passw0rd!' });
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [s.json.user.id]);
  await c('POST', '/api/auth/login', { email, password: 'passw0rd!' });
  return { c, uid: s.json.user.id };
}
/** The plan every admin read reports for workspace `w` of user `uid`: 워크스페이스 list, detail (+ usage), 회원 detail, AI 사용량. */
async function adminPlans(ops, w, uid) {
  const list = (await ops.c('GET', '/api/admin/workspaces?size=100')).json.items.find((x) => x.id === w);
  const detail = (await ops.c('GET', `/api/admin/workspaces/${w}`)).json;
  const user = (await ops.c('GET', `/api/admin/users/${uid}`)).json.workspaces.find((x) => x.id === w);
  const usage = (await ops.c('GET', '/api/admin/usage?size=100')).json.items.find((x) => x.workspace_id === w);
  return { list: list.plan, detail: detail.workspace.plan, detail_usage: detail.usage.plan, user: user.plan, usage: usage.plan, usage_row: usage, list_label: list.plan_label };
}

test('P1-1 (T5: early access retired): an early-access workspace reads FREE in every admin query with FREE limits; TEAM subscription wins; expired early access is FREE', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'early@x.com', '얼리');                       // signed up before the cutoff → early access
  await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '두 번째' }));   // v3: the 2nd is refused; 1 project = FREE's limit
  assert.equal(await effectivePlan(db, A.w), 'FREE');   // early_access_until in the future no longer grants a plan

  let p = await adminPlans(ops, A.w, A.uid);
  assert.deepEqual([p.list, p.detail, p.detail_usage, p.user, p.usage], ['FREE', 'FREE', 'FREE', 'FREE', 'FREE']);
  assert.equal(p.list_label, 'Free');
  assert.equal(p.usage_row.max_pct, 200); assert.equal(p.usage_row.tier, 'attention');
  const dash = (await ops.c('GET', '/api/admin/dashboard')).json;
  assert.ok(dash.attention.near_limit.some((x) => x.workspace_id === A.w));

  // a granting TEAM subscription beats early access (same order as effectivePlan)
  await db.run(`INSERT INTO subscriptions (id, workspace_id, plan, status, provider, current_period_end) VALUES ('s-team', ?, 'TEAM', 'ACTIVE', 'fake', now() + interval '20 days')`, [A.w]);
  p = await adminPlans(ops, A.w, A.uid);
  assert.deepEqual([p.list, p.detail, p.user, p.usage], ['TEAM', 'TEAM', 'TEAM', 'TEAM']);

  // no subscription and early access over → FREE, with the FREE limits back
  await db.run(`DELETE FROM subscriptions WHERE id = 's-team'`);
  await db.run(`UPDATE workspaces SET early_access_until = now() - interval '1 day' WHERE id = ?`, [A.w]);
  assert.equal(await effectivePlan(db, A.w), 'FREE');
  p = await adminPlans(ops, A.w, A.uid);
  assert.deepEqual([p.list, p.detail, p.detail_usage, p.user, p.usage], ['FREE', 'FREE', 'FREE', 'FREE', 'FREE']);
  assert.equal(p.usage_row.max_pct, 200); assert.equal(p.usage_row.tier, 'attention');
  server.close();
});

test('P2-2: AI 사용량 lists AI runs / API cost (failed runs included) / failures over the last 30 days and the allowance used, sorted by AI cost by default', async () => {
  const { db, server, client } = await boot();
  const ops = await operator(db, client);
  const A = await setup(client, 'a@x.com', '가');
  const B = await setup(client, 'b@x.com', '나');
  const run = (w, { status = 'SUCCEEDED', cost = 0.1, ago = '1 day' } = {}) => db.run(
    `INSERT INTO ai_runs (id, workspace_id, user_id, feature, provider, model, status, provider_cost_amount, plan_key, created_at) VALUES (?, ?, NULL, 'PROJECT_QA', 'mock', 'mock', ?, ?, 'FREE', now() - ?::interval)`,
    [randomUUID(), w, status, cost, ago]);
  await run(B.w); await run(B.w, { cost: 0.25 }); await run(B.w, { status: 'FAILED', cost: 0.3 });
  await run(B.w, { cost: 0.99, ago: '40 days' });                         // outside the 30-day window (still in the Free allowance)
  await run(A.w, { cost: 0.05 });

  const u = (await ops.c('GET', '/api/admin/usage')).json;
  assert.equal(u.sort, 'ai');
  const rows = u.items.filter((x) => [A.w, B.w].includes(x.workspace_id));
  assert.deepEqual(rows.map((x) => x.workspace_id), [B.w, A.w]);               // highest AI cost first
  const b = rows[0].ai;
  assert.deepEqual([b.runs_30d, b.failed_30d, b.cost_usd_30d], [3, 1, 0.65]);   // failed runs count (founder 2026-10-27)
  assert.ok(b.last_run_at);
  assert.equal(b.limit_usd, 2); assert.equal(b.used_pct, 82); assert.equal(b.allowance, 'ONCE');   // Free allowance: all Free runs (1.64 of 2)
  assert.ok(Array.isArray(rows[0].dims));                                      // plan limits kept as the secondary column
  for (const s of ['projects', 'requirements', 'wbs', 'activity']) assert.equal((await ops.c('GET', `/api/admin/usage?sort=${s}`)).status, 200);
  server.close();
});

test('P2-1: 감사 로그 labels — SYSTEM_ADMIN_BOOTSTRAP and FEEDBACK_UPDATE have Korean labels, every label is a working 작업 filter', async () => {
  assert.equal(ACTIONS.SYSTEM_ADMIN_BOOTSTRAP, '운영자 자동 부여');
  assert.equal(ACTIONS.FEEDBACK_UPDATE, '의견 처리');
  for (const [k, v] of Object.entries(ACTIONS)) {
    assert.ok(AUDIT_ACTIONS.includes(k), `${k} is a filter option but the server ignores it`);
    assert.match(v, /[가-힣]/, `${k} label is not Korean`);
  }
  // the bootstrap row is an operator action, so it shows in the default (ADMIN) audit list and the filter finds it
  const { db, server, client } = await boot();
  const c = client();
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '창업자', email: 'founder@x.com', password: 'passw0rd!' });
  const user = await db.get('SELECT id, email, system_role FROM users WHERE id = ?', [s.json.user.id]);
  assert.equal(await bootstrapSystemAdmin(db, user, 'founder@x.com'), true);
  const r = await listAudit(db, { action: 'SYSTEM_ADMIN_BOOTSTRAP' });
  assert.equal(r.total, 1); assert.equal(r.items[0].action, 'SYSTEM_ADMIN_BOOTSTRAP');
  assert.ok(ACTIONS[r.items[0].action]);
  server.close();
});
