/* In-app feedback (migration 48): POST /api/feedback (signed-in, validated, 10/hour) and 관리자 › 의견 (operator-only list / detail / update + audit).
 * UI: scripts/e2e-feedback.cjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';
import { listAudit } from '../admin.js';
import { FEEDBACK_RATE } from '../feedback.js';

const send = (c, o = {}) => c('POST', '/api/feedback', { category: 'SUGGESTION', message: '간트 차트에서 주말을 숨기고 싶어요.', page_path: '/app/projects', ...o });
const operator = async (db, client) => {
  const A = await setup(client, 'fb-op@example.com', '운영자');
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [A.uid]);
  return A;
};

test('auth required: anonymous POST /api/feedback is 401 and nothing is stored', async () => {
  const { db, client } = await boot();
  const r = await send(client());
  assert.equal(r.status, 401);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM feedback')).n), 0);
});

test('validation: category, required message, 2000-char cap; auto-attached context (own workspace/project only, path, UA)', async () => {
  const { db, client } = await boot();
  const U = await setup(client, 'fb-user@example.com', '사용자');
  const bad = await U.c('POST', '/api/feedback', { category: 'NOPE', message: '   ' });
  assert.equal(bad.status, 422); assert.ok(bad.json.error.fields.category); assert.ok(bad.json.error.fields.message);
  const long = await send(U.c, { message: 'ㄱ'.repeat(2001) });
  assert.equal(long.status, 422); assert.match(long.json.error.fields.message, /2,000자/);
  assert.equal((await send(U.c, { message: 'ㄱ'.repeat(2000) })).status, 200);

  const ok = await send(U.c, { category: 'BUG', message: '  저장 버튼이 안 눌려요  ', page_path: `/app/projects/${U.p.id}/wbs?x=1`, workspace_id: U.w, project_id: U.p.id });
  assert.equal(ok.status, 200); assert.equal(ok.json.feedback.status, 'NEW');
  const row = await db.get('SELECT * FROM feedback WHERE id = ?', [ok.json.feedback.id]);
  assert.equal(row.user_id, U.uid); assert.equal(row.workspace_id, U.w); assert.equal(row.project_id, U.p.id);
  assert.equal(row.message, '저장 버튼이 안 눌려요'); assert.equal(row.category, 'BUG'); assert.equal(row.status, 'NEW');
  assert.equal(row.page_path, `/app/projects/${U.p.id}/wbs?x=1`); assert.ok(row.user_agent && row.user_agent.length > 0);

  // someone else's workspace / project and a non-path page are dropped, not stored
  const O = await setup(client, 'fb-other@example.com', '다른 사람');
  const foreign = await send(U.c, { workspace_id: O.w, project_id: O.p.id, page_path: 'https://evil.example.com' });
  const f = await db.get('SELECT workspace_id, project_id, page_path FROM feedback WHERE id = ?', [foreign.json.feedback.id]);
  assert.deepEqual({ ...f }, { workspace_id: null, project_id: null, page_path: null });
  const cross = await send(U.c, { workspace_id: U.w, project_id: O.p.id });
  const x = await db.get('SELECT workspace_id, project_id FROM feedback WHERE id = ?', [cross.json.feedback.id]);
  assert.equal(x.workspace_id, U.w); assert.equal(x.project_id, null);
});

test(`rate limit: ${FEEDBACK_RATE.max} per hour per user → 429; rejected sends do not count; other users unaffected`, async () => {
  const { db, client } = await boot();
  const U = await setup(client, 'fb-rl@example.com', '사용자');
  for (let i = 0; i < 3; i++) assert.equal((await send(U.c, { message: '' })).status, 422);
  for (let i = 0; i < FEEDBACK_RATE.max; i++) assert.equal((await send(U.c, { message: `의견 ${i}` })).status, 200, `send ${i}`);
  const r = await send(U.c);
  assert.equal(r.status, 429); assert.equal(r.json.error.code, 'rate_limited');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?', [U.uid])).n), FEEDBACK_RATE.max);
  const V = await setup(client, 'fb-rl2@example.com', '다른 사용자');
  assert.equal((await send(V.c)).status, 200);
});

test('admin-only: list / summary / detail / update are 401 anonymous, 403 for a workspace OWNER', async () => {
  const { client } = await boot();
  const U = await setup(client, 'fb-owner@example.com', '소유자');
  const id = (await send(U.c)).json.feedback.id;
  const anon = client();
  for (const [m, p, b] of [['GET', '/api/admin/feedback'], ['GET', '/api/admin/feedback/summary'], ['GET', `/api/admin/feedback/${id}`], ['PATCH', `/api/admin/feedback/${id}`, { status: 'DONE' }]]) {
    assert.equal((await anon(m, p, b)).status, 401, `${m} ${p} anon`);
    assert.equal((await U.c(m, p, b)).status, 403, `${m} ${p} owner`);
  }
});

test('admin list: filters (status, category, date), search, new_count; detail has name/email/page; update writes one audit row', async () => {
  const { db, client } = await boot();
  const A = await operator(db, client);
  const U = await setup(client, 'fb-sender@example.com', '김의견');
  const a = (await send(U.c, { category: 'BUG', message: '보고서 PDF가 비어 있어요', page_path: '/app/projects/x/reports', workspace_id: U.w, project_id: U.p.id })).json.feedback.id;
  const b = (await send(U.c, { category: 'SUGGESTION', message: '다크 모드가 있으면 좋겠어요' })).json.feedback.id;
  await db.run(`UPDATE feedback SET created_at = now() - interval '40 days' WHERE id = ?`, [b]);

  const all = await A.c('GET', '/api/admin/feedback');
  assert.equal(all.status, 200); assert.equal(all.json.total, 2); assert.equal(all.json.new_count, 2);
  assert.equal(all.json.items[0].id, a); assert.equal(all.json.items[0].user_email, 'fb-sender@example.com'); assert.equal(all.json.categories.BUG, '오류');
  assert.deepEqual((await A.c('GET', '/api/admin/feedback?category=BUG')).json.items.map((x) => x.id), [a]);
  assert.deepEqual((await A.c('GET', `/api/admin/feedback?q=${encodeURIComponent('다크')}`)).json.items.map((x) => x.id), [b]);
  assert.deepEqual((await A.c('GET', `/api/admin/feedback?q=${encodeURIComponent('fb-sender')}`)).json.total, 2);
  const kst = (d) => new Date(Date.now() + 9 * 3600e3 - d * 86400e3).toISOString().slice(0, 10);
  assert.deepEqual((await A.c('GET', `/api/admin/feedback?from=${kst(1)}&to=${kst(0)}`)).json.items.map((x) => x.id), [a]);
  assert.deepEqual((await A.c('GET', `/api/admin/feedback?to=${kst(30)}`)).json.items.map((x) => x.id), [b]);

  const d = await A.c('GET', `/api/admin/feedback/${a}`);
  assert.equal(d.status, 200);
  assert.equal(d.json.feedback.user_name, '김의견'); assert.equal(d.json.feedback.user_email, 'fb-sender@example.com');
  assert.equal(d.json.feedback.page_path, '/app/projects/x/reports'); assert.equal(d.json.feedback.project_name, '테스트 프로젝트'); assert.ok(d.json.feedback.workspace_name);
  assert.equal((await A.c('GET', '/api/admin/feedback/nope')).status, 404);

  assert.equal((await A.c('PATCH', `/api/admin/feedback/${a}`, { status: 'WHAT' })).status, 422);
  assert.equal((await A.c('PATCH', `/api/admin/feedback/${a}`, { admin_note: 'x'.repeat(2001) })).status, 422);
  const up = await A.c('PATCH', `/api/admin/feedback/${a}`, { status: 'IN_REVIEW', admin_note: 'PDF 폰트 문제로 보임' });
  assert.equal(up.status, 200); assert.equal(up.json.feedback.status, 'IN_REVIEW'); assert.equal(up.json.feedback.admin_note, 'PDF 폰트 문제로 보임');
  assert.equal((await A.c('PATCH', `/api/admin/feedback/${a}`, { status: 'IN_REVIEW', admin_note: 'PDF 폰트 문제로 보임' })).status, 200);   // no change → no audit row
  assert.equal((await A.c('GET', '/api/admin/feedback/summary')).json.new_count, 1);
  assert.deepEqual((await A.c('GET', '/api/admin/feedback?status=IN_REVIEW')).json.items.map((x) => x.id), [a]);

  const audit = await listAudit(db, { action: 'FEEDBACK_UPDATE' });
  assert.equal(audit.total, 1);
  assert.equal(audit.items[0].admin_user_id, A.uid); assert.equal(audit.items[0].target_type, 'FEEDBACK'); assert.equal(audit.items[0].target_id, a);
  assert.match(audit.items[0].summary, /새 의견 → 검토 중 · 메모 수정/);
  assert.equal((await A.c('GET', `/api/admin/audit?target_type=FEEDBACK`)).json.total, 1);
});
