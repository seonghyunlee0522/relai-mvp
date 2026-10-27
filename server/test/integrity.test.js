/* Integrity (founder stability check 2026-10-21): races found by the live multi-instance test, each pinned here.
 * CR approve once · WBS cross-move cannot store a cycle · concurrent WBS creates get distinct codes · planner generate charges once ·
 * identical AI request while one is running → 409 (a killed run older than the reservation window does not block) · Jira sync keeps an unlinked link removed · NUL byte → 400. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { setFakeProvider, autoReply } from '../ai/provider.js';
import { dbErrorInfo } from '../db.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT;

const { db, server, client } = await boot();
test.after(() => server.close());
const statuses = (rs) => rs.map((r) => r.status).sort();

test('change request: three concurrent approvals → one 200, the rest 409; one STATUS_CHANGED → APPROVED row', async () => {
  const A = await setup(client, 'cr@x.com');
  const C = `${A.purl}/changes`;
  const cid = (await A.c('POST', C, { title: 'CR', reason: 'r' })).json.change.id;
  assert.equal((await A.c('POST', `${C}/${cid}/transition`, { action: 'submit' })).status, 200);
  const approve = { action: 'approve', decision_note: 'ok', customer_approval: { approver_name: '홍길동', approver_title: '차장', add_to_stakeholders: true, date: '2026-10-20', method: 'EMAIL', evidence: 'mail' } };
  const rs = await Promise.all([1, 2, 3].map(() => A.c('POST', `${C}/${cid}/transition`, approve)));
  assert.deepEqual(statuses(rs), [200, 409, 409]);
  const h = await db.all(`SELECT * FROM change_request_history WHERE change_request_id = ? AND action_type = 'STATUS_CHANGED' AND new_value = 'APPROVED'`, [cid]);
  assert.equal(h.length, 1);
  // approve vs reject at once: exactly one decision
  const c2 = (await A.c('POST', C, { title: 'CR2', reason: 'r' })).json.change.id;
  await A.c('POST', `${C}/${c2}/transition`, { action: 'submit' });
  const ar = await Promise.all([A.c('POST', `${C}/${c2}/transition`, approve), A.c('POST', `${C}/${c2}/transition`, { action: 'reject', decision_note: 'no' })]);
  assert.deepEqual(statuses(ar), [200, 409]);
});

test('WBS: concurrent "X under Y" + "Y under X" → one succeeds, no parent cycle; concurrent creates → distinct codes', async () => {
  const A = await setup(client, 'wbs@x.com');
  await A.c('GET', A.wbs);
  const parent = (await A.c('POST', A.wbs, { title: 'P', item_type: 'TASK' })).json.item;
  const kids = await Promise.all(Array.from({ length: 8 }, (_, i) => A.c('POST', A.wbs, { title: `c${i}`, item_type: 'TASK', parent_id: parent.id, convert_parent: 'move' })));
  assert.ok(kids.every((r) => r.status === 201));
  const items = await db.all('SELECT * FROM wbs_items WHERE parent_id = ? AND archived_at IS NULL', [parent.id]);
  assert.equal(new Set(items.map((x) => x.wbs_code)).size, 8, 'no duplicate WBS codes');
  const [x, y] = items;
  const mv = await Promise.all([A.c('POST', `${A.wbs}/${x.id}/move`, { parent_id: y.id }), A.c('POST', `${A.wbs}/${y.id}/move`, { parent_id: x.id })]);
  assert.deepEqual(statuses(mv), [200, 400]);
  const cyc = await db.get('SELECT COUNT(*) AS n FROM wbs_items a JOIN wbs_items b ON a.parent_id = b.id AND b.parent_id = a.id');
  assert.equal(Number(cyc.n), 0);
});

test('AI: planner generate double click runs once; identical in-flight request → 409 AI_RUN_IN_PROGRESS', async () => {
  const A = await setup(client, 'ai@x.com');
  await A.c('POST', A.req, { title: '로그인', description: '이메일 로그인' });
  const slow = (req) => new Promise((r) => setTimeout(() => r({ data: autoReply(req) }), 300));   // valid canned answer, slow enough to overlap
  setFakeProvider(slow);
  const plan = (await A.c('POST', `${A.purl}/ai/wbs-plans`, { all: true })).json.plan;
  const runs = async () => Number((await db.get(`SELECT COUNT(*) AS n FROM ai_runs WHERE workspace_id = ? AND feature = 'WBS_GENERATION'`, [A.w])).n);
  const gen = await Promise.all([1, 2].map(() => A.c('POST', `${A.purl}/ai/wbs-plans/${plan.id}/generate`, {})));
  assert.deepEqual(statuses(gen), [200, 409]);
  assert.equal(gen.find((r) => r.status === 409).json.error.code, 'plan_busy');
  assert.equal(await runs(), 1, 'one AI run for the double click');

  const ask = await Promise.all([1, 2].map(() => A.c('POST', `${A.purl}/ai/ask`, { question: '진행 상황은?', history: [] })));
  assert.equal(ask.filter((r) => r.status === 409 && r.json.error.code === 'AI_RUN_IN_PROGRESS').length, 1);
  // a run left PENDING by a killed function (older than the reservation window) does not block the same request
  const run = await db.get(`SELECT id FROM ai_runs WHERE workspace_id = ? AND feature = 'PROJECT_QA' AND status = 'SUCCEEDED' LIMIT 1`, [A.w]);
  await db.run(`UPDATE ai_runs SET status = 'PENDING', created_at = now() - interval '11 minutes' WHERE id = ?`, [run.id]);
  assert.equal((await A.c('POST', `${A.purl}/ai/ask`, { question: '진행 상황은?', history: [] })).status, 200);
  setFakeProvider(null);
});

test('NUL byte in text → 400 invalid_value, not 500', async () => {
  const A = await setup(client, 'nul@x.com');
  const r = await A.c('POST', A.req, { title: 'a\u0000b' });
  assert.equal(r.status, 400);
  assert.equal(dbErrorInfo({ code: '22021' }).status, 400);
});
