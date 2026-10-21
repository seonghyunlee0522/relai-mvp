/* 관리자 › AI 프롬프트 (migration 68): DB-stored prompt overrides with code-default fallback, SYSTEM_ADMIN-only routes,
 * second-step save (check → save), history / restore / reset, audit, per-instance cache invalidation, and the 전송 내용
 * preview that builds the real request without calling the provider or touching credits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, setup, addMember } from './api-helpers.js';
import { setFakeProvider, fakeCalls, autoReply } from '../ai/provider.js';
import { SYSTEM, COMMON_RULES, DEFAULT_PROMPTS, PROMPT_KEYS } from '../ai/prompts.js';
import { systemPrompt, invalidatePromptCache, promptOverrides } from '../ai/prompt-store.js';

process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.DEV_INITIAL_AI_CREDITS = '100'; process.env.AI_MODEL = '';
delete process.env.AI_USER_MINUTE_LIMIT; delete process.env.AI_DAILY_LIMIT;

const grant = (db, uid) => db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [uid]);
const balance = async (db, wid) => (await db.get('SELECT balance FROM workspace_credit_accounts WHERE workspace_id = ?', [wid])).balance;
const B = '/api/admin/ai/prompts';

test('empty table = the shipped prompts exactly (byte-identical to e25c3e1), for every key', async () => {
  const { db, server } = await boot();
  const fx = JSON.parse(readFileSync(new URL('./fixtures/ai-prompts-e25c3e1.json', import.meta.url), 'utf8'));
  assert.deepEqual(PROMPT_KEYS, Object.keys(fx));
  assert.equal(COMMON_RULES, fx.COMMON_RULES);
  for (const k of PROMPT_KEYS.slice(1)) { assert.equal(SYSTEM[k], fx[k], k); assert.equal(await systemPrompt(db, k), fx[k], k); }
  server.close();
});

test('access: anonymous 401, workspace OWNER / ADMIN 403 on every route; SYSTEM_ADMIN sees 9 entries', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pa-owner@x.com');
  const M = await addMember(client, A, 'pa-adm@x.com', '관리자', 'ADMIN');
  const anon = client();
  assert.equal((await anon('GET', B)).status, 401);
  for (const c of [A.c, M.c]) {
    assert.equal((await c('GET', B)).status, 403);
    assert.equal((await c('GET', `${B}/COMMON_RULES`)).status, 403);
    assert.equal((await c('PUT', `${B}/COMMON_RULES`, { body: 'x' })).status, 403);
    assert.equal((await c('POST', `${B}/PROJECT_QA/reset`, {})).status, 403);
    assert.equal((await c('POST', `${B}/PROJECT_QA/restore`, { version: 1 })).status, 403);
    assert.equal((await c('POST', `${B}/PROJECT_QA/preview`, { project_id: A.p.id })).status, 403);
    assert.equal((await c('GET', '/api/admin/ai/preview-projects')).status, 403);
  }
  await grant(db, A.uid);
  const r = await A.c('GET', B);
  assert.equal(r.status, 200); assert.equal(r.json.prompts.length, 9);
  assert.equal(r.json.prompts[0].label, '공통 원칙'); assert.ok(r.json.prompts.every((p) => !p.overridden && p.version === 0 && p.where));
  server.close();
});

test('save → used by the feature call (fake provider); validation; history, restore, reset; audit; cache invalidated in-instance', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pa-save@x.com'); await grant(db, A.uid);
  setFakeProvider((req) => ({ data: autoReply(req), usage: { input_tokens: 10, output_tokens: 10 } }));
  // warm the cache with the default, then edit: the next call must see the edit at once (same instance)
  assert.equal(await systemPrompt(db, 'REQUIREMENT_EXTRACTION'), SYSTEM.REQUIREMENT_EXTRACTION);
  const edited = `${DEFAULT_PROMPTS.REQUIREMENT_EXTRACTION}\n\n[편집됨] 표식 MARKER-42`;
  assert.equal((await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: '   ' })).status, 422);
  assert.equal((await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: 'x'.repeat(20_001) })).status, 422);
  assert.equal((await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: `${edited} {{NOPE}}` })).status, 422);
  const chk = await A.c('POST', `${B}/REQUIREMENT_EXTRACTION/check`, { body: edited.replace('{{REQ_TYPES}}', '') });
  assert.equal(chk.status, 200); assert.ok(chk.json.warnings.some((w) => w.includes('REQ_TYPES')));
  assert.deepEqual(chk.json.affected.map((a) => a.key), ['REQUIREMENT_EXTRACTION']);
  assert.equal((await A.c('POST', `${B}/COMMON_RULES/check`, { body: 'x' })).json.affected.length, 8);

  const s = await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: edited, base_version: 0 });
  assert.equal(s.status, 200, JSON.stringify(s.json)); assert.equal(s.json.version, 1);
  assert.equal((await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: `${edited}!`, base_version: 0 })).status, 409, 'stale base_version');
  const run = await A.c('POST', `${A.purl}/ai/requirements/extract`, { text: '고객 미팅: SSO로 로그인하고 싶다.' });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  const sent = fakeCalls().at(-1).system;
  assert.match(sent, /MARKER-42/); assert.ok(sent.startsWith(COMMON_RULES)); assert.ok(!sent.includes('{{REQ_TYPES}}'), 'placeholders rendered');
  assert.equal(await systemPrompt(db, 'WBS_GENERATION'), SYSTEM.WBS_GENERATION, 'other features untouched');

  // COMMON_RULES edit reaches every feature
  const common = `${DEFAULT_PROMPTS.COMMON_RULES}\n6. 공통 표식 COMMON-7`;
  assert.equal((await A.c('PUT', `${B}/COMMON_RULES`, { body: common })).status, 200);
  for (const k of PROMPT_KEYS.slice(1)) assert.match(await systemPrompt(db, k), /COMMON-7/);

  // second save, history, restore v1, reset to default
  assert.equal((await A.c('PUT', `${B}/REQUIREMENT_EXTRACTION`, { body: `${edited} v2`, base_version: 1 })).json.version, 2);
  let d = (await A.c('GET', `${B}/REQUIREMENT_EXTRACTION`)).json;
  assert.deepEqual(d.versions.map((v) => [v.version, v.action]), [[2, 'SAVE'], [1, 'SAVE']]);
  assert.equal(d.versions[0].created_by.email, 'pa-save@x.com'); assert.ok(d.send.schema && d.send.user_template.includes('<untrusted_input>'));
  const rs = await A.c('POST', `${B}/REQUIREMENT_EXTRACTION/restore`, { version: 1, base_version: 2 });
  assert.equal(rs.status, 200); assert.equal(rs.json.action, 'RESTORE'); assert.equal(rs.json.prompt.body, edited);
  assert.match(await systemPrompt(db, 'REQUIREMENT_EXTRACTION'), /MARKER-42$/);
  const rz = await A.c('POST', `${B}/REQUIREMENT_EXTRACTION/reset`, { base_version: 3 });
  assert.equal(rz.status, 200); assert.equal(rz.json.action, 'RESET'); assert.equal(rz.json.prompt.overridden, false);
  assert.equal((await A.c('POST', `${B}/REQUIREMENT_EXTRACTION/reset`, {})).status, 409, 'already default');
  assert.ok(!(await systemPrompt(db, 'REQUIREMENT_EXTRACTION')).includes('MARKER-42'));
  // saving the exact default text = reset (row removed; follows future code updates)
  assert.equal((await A.c('PUT', `${B}/COMMON_RULES`, { body: DEFAULT_PROMPTS.COMMON_RULES })).json.action, 'RESET');
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM ai_prompts')).n, 0);
  assert.equal(await systemPrompt(db, 'PROJECT_QA'), SYSTEM.PROJECT_QA);

  const audit = await db.all(`SELECT metadata FROM admin_audit_logs WHERE action = 'AI_PROMPT_UPDATE' ORDER BY created_at`);
  assert.equal(audit.length, 6);   // v1, COMMON, v2, restore, reset, COMMON → default
  server.close();
});

test('cache: another instance sees a direct DB change only after the TTL / invalidation (no stale read after invalidate)', async () => {
  const { db, server } = await boot();
  await promptOverrides(db);   // cached: empty
  await db.run(`INSERT INTO ai_prompts (key, body, version) VALUES ('PROJECT_QA', '다른 인스턴스가 저장 OTHER-1', 1)`);
  assert.equal(await systemPrompt(db, 'PROJECT_QA'), SYSTEM.PROJECT_QA, 'still cached');
  invalidatePromptCache(db);
  assert.match(await systemPrompt(db, 'PROJECT_QA'), /OTHER-1$/);
  await db.run('DELETE FROM ai_prompts'); invalidatePromptCache();
  server.close();
});

test('preview: exact request built by the feature code, no provider call, no credits, no ai_runs row; audited', async () => {
  const { db, server, client } = await boot();
  const A = await setup(client, 'pa-prev@x.com'); await grant(db, A.uid);
  await A.c('POST', A.req, { title: '청구 조회', scope: 'IN_SCOPE', status: 'CONFIRMED', criteria: ['청구 내역이 보인다'] });
  setFakeProvider(() => { throw new Error('provider must not be called'); });
  const before = fakeCalls().length; const bal = await balance(db, A.w);
  const projects = (await A.c('GET', '/api/admin/ai/preview-projects?q=테스트')).json.projects;
  assert.ok(projects.some((p) => p.id === A.p.id));
  for (const key of ['REQUIREMENT_EXTRACTION', 'WBS_GENERATION', 'PROJECT_QA', 'WBS_PLAN_QUESTIONS', 'PROJECT_WBS_DRAFT', 'TEST_GENERATION']) {
    const r = await A.c('POST', `${B}/${key}/preview`, { project_id: A.p.id, text: '회의록: 엑셀 다운로드가 필요하다.' });
    assert.equal(r.status, 200, `${key} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.system, await systemPrompt(db, key));
    assert.match(r.json.user, /<project_data>/); assert.ok(r.json.schema && r.json.request.body.messages);
  }
  const ex = (await A.c('POST', `${B}/REQUIREMENT_EXTRACTION/preview`, { project_id: A.p.id, text: '회의록: 엑셀 다운로드가 필요하다.' })).json;
  assert.match(ex.user, /엑셀 다운로드/); assert.match(ex.user, /청구 조회/);
  assert.equal((await A.c('POST', `${B}/CHANGE_IMPACT/preview`, { project_id: A.p.id })).status, 409, 'no change request → clear message');
  assert.equal((await A.c('POST', `${B}/WBS_PLAN_FIX/preview`, { project_id: A.p.id })).status, 409);
  assert.equal(fakeCalls().length, before); assert.equal(await balance(db, A.w), bal);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM ai_runs WHERE workspace_id = ?', [A.w])).n, 0);
  assert.ok((await db.get(`SELECT COUNT(*)::int AS n FROM admin_audit_logs WHERE action = 'AI_PROMPT_PREVIEW'`)).n >= 6);
  server.close();
});
