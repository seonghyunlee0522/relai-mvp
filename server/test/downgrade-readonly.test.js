/* 구독 해지 · Free 전환 · 데이터 보관 (founder policy 2026-10-21, hive research/relai-pricing-v3/founder-cancel-retention-2026-10-21.md):
 * cancel → auto-renew off, plan until the period end → the daily cron expires it → FREE. The newest project by created_at stays
 * editable, every other active project is read-only: every write route under it answers 409 project_read_only (edit, delete, AI,
 * imports, Jira, comments …; enumerated from the router so a new route cannot slip through). Re-subscribing restores edit access
 * up to the plan's limit, newest first. Nothing is deleted; samples are never counted or locked. Fake provider, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { setup, project } from './api-helpers.js';
import { createFakeProvider } from '../billing/provider.js';
import { resetBillingCache } from '../billing-admin.js';
import { effectivePlan } from '../billing/subscriptions.js';
import { projectAccess } from '../billing/limits.js';
import { syncAllDue } from '../integrations/jira/sync.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';

process.env.PAYMENTS_ENABLED = 'true';
process.env.PLAN_LIMITS = 'on';
process.env.CRON_SECRET = 'cron-test-secret';
process.env.EARLY_ACCESS_CUTOFF = '2000-01-01T00:00:00Z';
process.env.ADDONS_ENABLED = 'true';
const mail = fakeEmailProvider(); setEmailProvider(mail);
const CARD = { number: '4242-4242-4242-4242', expiry: '12/29', id_no: '800101', password2: '12' };

async function boot() {
  const db = await testDb();
  resetBillingCache();
  const provider = createFakeProvider({ recurring: true });
  const app = createApp(db, { billingProvider: provider });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    };
  };
  const cron = () => fetch(`${base}/api/billing/cron/daily`, { headers: { Authorization: 'Bearer cron-test-secret' } }).then((x) => x.json());
  return { app, db, server, client, provider, cron };
}
const owner = async (t, email = 'o@x.com') => {
  const A = await setup(t.client, email, '소유자');
  await t.db.run('UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL');
  return A;
};
const B = (A) => `/api/workspaces/${A.w}/billing`;
const P = (A, id) => `/api/workspaces/${A.w}/projects/${id}`;
async function subscribe(A, { plan = 'PRO', cycle = 'MONTHLY', extra_projects = 0 } = {}) {
  const q = await A.c('GET', `${B(A)}/quote?plan=${plan}&cycle=${cycle}&extra_users=0&extra_projects=${extra_projects}`);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  const r = await A.c('POST', `${B(A)}/recurring`, { plan, cycle, extra_users: 0, extra_projects, card: CARD, agree: true, disclosure_hash: q.json.disclosure.hash });
  assert.equal(r.status, 201, JSON.stringify(r.json));
}
/** Makes created_at strictly increasing in creation order (one request can land in the same microsecond on a fast machine). */
const spreadCreatedAt = (db, ids) => Promise.all(ids.map((id, i) => db.run(`UPDATE projects SET created_at = now() - make_interval(mins => ?) WHERE id = ?`, [100 - i, id])));

/** Row counts of every table that holds project data (any table with a project_id column) + the projects themselves. */
async function projectRowCounts(db, wid) {
  const tables = (await db.all(`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'project_id' ORDER BY table_name`)).map((r) => r.table_name);
  const out = { projects: Number((await db.get('SELECT COUNT(*) n FROM projects WHERE workspace_id = ?', [wid])).n) };
  for (const t of tables) out[t] = Number((await db.get(`SELECT COUNT(*) n FROM "${t}" WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`, [wid])).n);
  return out;
}

/** Every non-GET route mounted under a project, with its params filled in. */
function projectWriteRoutes(app) {
  const prefix = '/api/workspaces/:wid/projects/:pid';
  const out = [];
  for (const layer of app._router.stack) {
    const r = layer.route; if (!r || typeof r.path !== 'string' || !r.path.startsWith(`${prefix}/`) && r.path !== prefix) continue;
    for (const m of Object.keys(r.methods)) if (!['get', 'head', 'options', '_all'].includes(m)) out.push({ method: m.toUpperCase(), path: r.path });
  }
  return out;
}
const fill = (path, A, pid) => path.replace(':wid', A.w).replace(':pid', pid)
  .replace(/:(\w+)\(([^)|]+)[^)]*\)/g, '$2')                      // :action(complete|confirm|…) → complete
  .replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000');    // any other id → a well-formed id that does not exist
// The only writes a read-only project still takes: 보관, previews / error sheets (pure reads), 질문 (no data change).
const STILL_OPEN = [/\/archive$/, /\/preview$/, /\/errors\.xlsx$/, /\/ai\/ask$/];

test('cancel → period end → FREE: newest project editable, every other one read-only on EVERY write route (409 project_read_only); nothing deleted; re-subscribe restores newest first', async () => {
  const t = await boot();
  const A = await owner(t);
  await subscribe(A, { plan: 'PRO', extra_projects: 1 });   // 3 + 1 = 4 active projects
  const ids = [A.p.id];
  for (const n of ['둘째', '셋째', '넷째']) { const r = await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: n })); assert.equal(r.status, 201, JSON.stringify(r.json)); ids.push(r.json.project.id); }
  await spreadCreatedAt(t.db, ids);
  const [oldest, , third, newest] = ids;
  assert.equal((await A.c('POST', `${P(A, oldest)}/requirements`, { title: '요구사항 1', description: 'x' })).status, 201);
  assert.equal((await A.c('POST', `${P(A, oldest)}/wbs`, { title: '작업 1', item_type: 'TASK' })).status, 201);

  // 1. cancel: auto-renew off, PRO and full edit access until the period end
  const c = await A.c('POST', `${B(A)}/cancel`, {});
  assert.equal(c.status, 200, JSON.stringify(c.json)); assert.equal(c.json.billing.plan, 'PRO'); assert.equal(c.json.billing.auto_renew, false);
  assert.match(c.json.billing.cancel_policy.free, /가장 최근인 프로젝트 1개/);
  for (const id of ids) assert.equal((await A.c('POST', `${P(A, id)}/requirements`, { title: `해지 후 ${id.slice(0, 4)}`, description: 'x' })).status, 201);
  const cm = mail.find((m) => /해지 안내/.test(m.subject)).pop();
  assert.match(cm.text, /가장 최근인 프로젝트 1개만 계속 편집/); assert.match(cm.text, /삭제되지 않으며/);
  const before = await projectRowCounts(t.db, A.w);

  // 2. the period ends → the daily cron expires it → FREE, Free-transition mail names the editable and the read-only projects
  await t.db.run(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute', next_billing_at = NULL WHERE workspace_id = ?`, [A.w]);
  assert.equal((await t.cron()).expired.expired, 1);
  assert.equal(await effectivePlan(t.db, A.w), 'FREE');
  assert.equal((await t.db.get(`SELECT COUNT(*)::int n FROM email_deliveries WHERE type = 'BILLING_FREE_TRANSITION' AND workspace_id = ?`, [A.w])).n, 1);
  const free = mail.find((m) => /Free 플랜으로 전환/.test(m.subject)).pop();
  assert.ok(free, 'Free-transition mail'); assert.match(free.text, /계속 편집할 수 있는 프로젝트 \(최근 생성 1개\): 넷째/); assert.match(free.text, /조회 전용으로 바뀐 프로젝트 3개/); assert.match(free.html, /삭제되지 않으며/);
  const access = await projectAccess(t.db, A.w);
  assert.deepEqual(access.editable, [newest]); assert.deepEqual([...access.readOnly].sort(), [oldest, ids[1], third].sort());

  // 3. read-only projects: readable, banner data on the project payload, and EVERY write route refused
  const g = await A.c('GET', P(A, oldest));
  assert.equal(g.status, 200); assert.equal(g.json.project.read_only, true); assert.match(g.json.read_only.message, /조회 전용/);
  assert.equal((await A.c('GET', P(A, newest))).json.read_only, null);
  assert.equal((await A.c('GET', `${P(A, oldest)}/requirements`)).json.requirements.length, 2);
  const routes = projectWriteRoutes(t.app);
  assert.ok(routes.length > 80, `found ${routes.length} project write routes`);
  const leaked = [];
  for (const r of routes) {
    const url = fill(r.path, A, oldest);
    if (STILL_OPEN.some((re) => re.test(url))) continue;   // not called: 보관 would archive the project for the rest of the sweep
    const res = await A.c(r.method, url, {});
    if (res.status !== 409 || res.json?.error?.code !== 'project_read_only') leaked.push(`${r.method} ${r.path} → ${res.status} ${res.json?.error?.code || ''}`);
  }
  assert.deepEqual(leaked, [], `write routes not blocked on a read-only project:\n${leaked.join('\n')}`);
  // the named ones, explicitly: edit, delete, AI draft + commit, import, Jira sync, comment
  for (const [m, u] of [['PATCH', P(A, oldest)], ['POST', `${P(A, oldest)}/close`], ['POST', `${P(A, oldest)}/ai/wbs/generate`], ['POST', `${P(A, oldest)}/ai/requirements/extract`],
    ['POST', `${P(A, oldest)}/ai/requirements/commit`], ['POST', `${P(A, oldest)}/requirements/import`], ['POST', `${P(A, oldest)}/integrations/jira/sync`]]) {
    const res = await A.c(m, u, {}); assert.equal(res.status, 409, `${m} ${u}`); assert.equal(res.json.error.code, 'project_read_only', `${m} ${u}`);
  }
  const reqId = (await A.c('GET', `${P(A, oldest)}/requirements`)).json.requirements[0].id;
  for (const [m, u] of [['PATCH', `${P(A, oldest)}/requirements/${reqId}`], ['POST', `${P(A, oldest)}/requirements/${reqId}/archive`], ['POST', `${P(A, oldest)}/requirements/${reqId}/comments`]]) {
    assert.equal((await A.c(m, u, { title: 'x', body: '댓글' })).json.error.code, 'project_read_only', `${m} ${u}`);
  }
  // the newest one stays fully editable
  assert.equal((await A.c('POST', `${P(A, newest)}/requirements`, { title: 'Free에서도 편집', description: 'x' })).status, 201);
  assert.equal((await A.c('PATCH', P(A, newest), project({ name: '넷째 수정' }))).status, 200);
  assert.equal((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '다섯째' }))).status, 402);   // still over the limit

  // 4. nothing deleted, nothing changed on read-only projects (only the newest project gained its one requirement)
  const after = await projectRowCounts(t.db, A.w);
  // analytics_events is the product event log (it records the newest project's requirement), not project data
  assert.deepEqual({ ...after, requirements: after.requirements - 1, analytics_events: undefined }, { ...before, analytics_events: undefined });
  assert.equal(after.projects, before.projects);

  // 5. Billing page data: which project is editable, which are read-only, and the policy text
  const b = (await A.c('GET', B(A))).json.billing;
  assert.equal(b.plan, 'FREE'); assert.deepEqual(b.read_only_projects.editable.map((x) => x.id), [newest]); assert.equal(b.read_only_projects.read_only.length, 3);
  const list = (await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects.filter((x) => !x.sample_key);
  assert.deepEqual(list.filter((x) => !x.read_only).map((x) => x.id), [newest]);

  // 6. re-subscribe PRO (3 projects): the newest three are editable again, the oldest stays read-only; data intact
  await subscribe(A, { plan: 'PRO' });
  assert.equal(await effectivePlan(t.db, A.w), 'PRO');
  assert.equal((await A.c('POST', `${P(A, third)}/requirements`, { title: '복원', description: 'x' })).status, 201);
  assert.equal((await A.c('POST', `${P(A, ids[1])}/requirements`, { title: '복원', description: 'x' })).status, 201);
  assert.equal((await A.c('POST', `${P(A, oldest)}/requirements`, { title: '아직', description: 'x' })).json.error.code, 'project_read_only');
  assert.equal((await A.c('GET', `${P(A, oldest)}/requirements`)).json.requirements.length, 2);
  // an add-on project (limit 4) restores the oldest too
  const q = await A.c('GET', `${B(A)}/quote?kind=ADDON&extra_projects=1`);
  const add = await A.c('POST', `${B(A)}/addons`, { extra_projects: 1, agree: true, disclosure_hash: q.json.disclosure.hash, client_key: 'dg-1' });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  assert.equal((await A.c('POST', `${P(A, oldest)}/requirements`, { title: '전부 복원', description: 'x' })).status, 201);
  assert.equal((await projectAccess(t.db, A.w)).readOnly.size, 0);
  t.server.close();
});

test('samples are never counted or locked; archiving a read-only project is allowed and frees no edit slot by itself; immediate cancel + refund → FREE with the same rule', async () => {
  const t = await boot();
  const A = await owner(t, 's@x.com');
  if (!(await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects.some((x) => x.sample_key)) assert.equal((await A.c('POST', `/api/workspaces/${A.w}/samples`, {})).status, 201);
  const samples = (await A.c('GET', `/api/workspaces/${A.w}/projects`)).json.projects.filter((x) => x.sample_key);
  assert.ok(samples.length >= 1, 'sample projects');
  await subscribe(A, { plan: 'PRO' });
  const ids = [A.p.id];
  for (const n of ['b', 'c']) ids.push((await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: n }))).json.project.id);
  await spreadCreatedAt(t.db, ids);
  // samples are newer than every real project: they still take no slot
  await t.db.run(`UPDATE projects SET created_at = now() WHERE sample_key IS NOT NULL AND workspace_id = ?`, [A.w]);
  const before = await projectRowCounts(t.db, A.w);
  const r = await A.c('POST', `${B(A)}/cancel`, { refund: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await effectivePlan(t.db, A.w), 'FREE');
  const access = await projectAccess(t.db, A.w);
  assert.deepEqual(access.editable, [ids[2]]);
  for (const s of samples) assert.ok(!access.readOnly.has(s.id));
  // sample projects stay writable (they are demo data) and are not flagged
  const sp = (await A.c('GET', P(A, samples[0].id))).json;
  assert.equal(sp.project.read_only, false); assert.equal(sp.read_only, null);
  assert.notEqual((await A.c('POST', `${P(A, samples[0].id)}/requirements`, { title: '샘플', description: 'x' })).json?.error?.code, 'project_read_only');
  // archive a read-only one: allowed; the newest stays the only editable one
  assert.equal((await A.c('POST', `${P(A, ids[0])}/archive`, {})).status, 200);
  assert.equal((await A.c('POST', `${P(A, ids[1])}/requirements`, { title: 'x', description: 'x' })).json.error.code, 'project_read_only');
  assert.equal((await A.c('POST', `${P(A, ids[2])}/requirements`, { title: 'x', description: 'x' })).status, 201);
  // unarchive is refused by the limit (402), so no project changes hands silently
  assert.equal((await A.c('POST', `${P(A, ids[0])}/unarchive`, {})).status, 402);
  const after = await projectRowCounts(t.db, A.w);
  assert.equal(after.projects, before.projects);
  for (const k of Object.keys(before)) if (!['requirements', 'analytics_events'].includes(k)) assert.ok(after[k] >= before[k], `${k}: ${before[k]} → ${after[k]}`);
  t.server.close();
});

test('Jira on a read-only project: manual sync refused (409), scheduled sync skips it, the editable project still syncs', async () => {
  const t = await boot();
  const A = await owner(t, 'j@x.com');
  process.env.PLAN_LIMITS = 'off';
  const newer = (await A.c('POST', `/api/workspaces/${A.w}/projects`, project({ name: '새 프로젝트' }))).json.project.id;
  process.env.PLAN_LIMITS = 'on';
  await spreadCreatedAt(t.db, [A.p.id, newer]);
  // two mapped projects on one ACTIVE connection (rows only: the scheduled job picks them; no provider call needed to see the skip)
  const cid = 'conn-dg';
  await t.db.run(`INSERT INTO integration_connections (id, workspace_id, provider, status, site_url, connected_by, connected_at, webhook_secret) VALUES (?, ?, 'JIRA', 'ACTIVE', 'https://x.atlassian.net', ?, now(), 's')`, [cid, A.w, A.uid]);
  for (const [i, pid] of [A.p.id, newer].entries()) {
    await t.db.run(`INSERT INTO integration_project_mappings (id, connection_id, project_id, external_project_id, external_project_key, external_project_name, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`, [`map-${i}`, cid, pid, `1000${i}`, `K${i}`, `K${i}`, A.uid]);
  }
  assert.equal(await effectivePlan(t.db, A.w), 'FREE');
  assert.equal((await A.c('POST', `${P(A, A.p.id)}/integrations/jira/sync`, {})).json.error.code, 'project_read_only');
  const out = await syncAllDue(t.db, { olderThanMinutes: 0 });
  assert.ok(!out.some((o) => o.project_id === A.p.id), 'read-only project skipped');
  assert.ok(out.some((o) => o.project_id === newer), 'editable project still synced');
  t.server.close();
});
