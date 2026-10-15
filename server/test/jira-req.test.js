/* v43 — requirement ↔ Jira issue links against the fake provider (no network): create (summary/description/link back), link by key,
 * unlink, bulk create, list/trace map, sync (manual/webhook/scheduled) updating the chip, the optional '구현 완료' mark (status never
 * changes), empty states, permissions and workspace isolation. Same harness as jira.test.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setProvider } from '../integrations/registry.js';
import { fakeJiraProvider } from '../integrations/jira/provider.js';
import { signJwt } from '../integrations/crypto.js';
import { runIntegrationJobs } from '../integrations/scheduler.js';

process.env.ATLASSIAN_CLIENT_ID = 'cid'; process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret'; process.env.ATLASSIAN_REDIRECT_URI = 'https://relai.test/api/integrations/jira/callback';
process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64); process.env.INTEGRATION_PROVIDER = 'live';

const INT = (A) => `/api/workspaces/${A.w}/integrations`;
const PJ = (A) => `${A.purl}/integrations/jira`;
const RJ = (A, id) => `${A.req}/${id}/jira`;
async function connect(A, fake, { map = true, mark = false, leafType = '1' } = {}) {
  setProvider(fake);
  const s = await A.c('POST', `${INT(A)}/jira/connect`, {}); assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal((await A.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s.json.state)}`)).status, 302);
  if (map) { const r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: leafType, auto_mark_requirements: mark }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; }
  return null;
}
const mkReq = async (A, body) => { const r = await A.c('POST', A.req, { scope: 'IN_SCOPE', ...body }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.requirement; };
const textOf = (adf) => JSON.stringify(adf);

test('requirement Jira: empty states before connect / before mapping; create from requirement (summary, description = 설명 + 완료 조건 + link back), several issues per requirement', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); setProvider(fake);
  const R = await mkReq(A, { title: 'SSO 로그인', description: '사내 계정으로 로그인한다.', criteria: ['AD 계정으로 로그인 성공', '실패 시 안내 문구'] });
  let r = await A.c('GET', RJ(A, R.id)); assert.equal(r.status, 200);
  assert.equal(r.json.connected, false); assert.equal(r.json.mapped, false); assert.deepEqual(r.json.links, []);
  assert.equal((await A.c('POST', `${RJ(A, R.id)}/issues`, {})).status, 409);   // not mapped
  await connect(A, fake, { map: false });
  r = await A.c('GET', RJ(A, R.id)); assert.equal(r.json.connected, true); assert.equal(r.json.mapped, false);
  r = await A.c('GET', A.req); assert.equal(r.json.jira, null);   // list: no Jira column data until mapped
  await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1' });
  r = await A.c('POST', `${RJ(A, R.id)}/issues`, {}); assert.equal(r.status, 201, JSON.stringify(r.json));
  const key = r.json.issue.external_key; assert.match(key, /^ABC-\d+$/);
  const it = [...fake.issues.values()].find((x) => x.key === key);
  assert.equal(it.summary, `${R.display_id} SSO 로그인`);
  const d = textOf(it.description); assert.match(d, /사내 계정으로 로그인한다/); assert.match(d, /완료 조건/); assert.match(d, /AD 계정으로 로그인 성공/); assert.match(d, new RegExp(`/app/projects/${A.p.id}/requirements\\?sel=${R.id}`));
  assert.equal(r.json.jira.links.length, 1); assert.equal(r.json.jira.links[0].status_name, 'To Do'); assert.match(r.json.jira.links[0].browser_url, /^https:\/\/example\.atlassian\.net\/browse\/ABC-/);
  assert.deepEqual([r.json.jira.summary.total, r.json.jira.summary.done, r.json.jira.summary.rate], [1, 0, 0]);
  // custom summary + a second issue; history rows
  r = await A.c('POST', `${RJ(A, R.id)}/issues`, { summary: 'SSO 화면' }); assert.equal(r.status, 201); assert.equal(r.json.jira.links.length, 2);
  const det = (await A.c('GET', `${A.req}/${R.id}`)).json.requirement;
  assert.equal(det.history.filter((h) => h.action_type === 'JIRA_LINKED').length, 2);
  assert.equal(det.status, 'DRAFT');   // never changed by Jira
  // list map + 추적 data
  r = await A.c('GET', A.req); assert.equal(r.json.jira.enabled, true); assert.equal(r.json.jira.by[R.id].total, 2); assert.equal(r.json.jira.by[R.id].keys[0].key, key);
  // required custom field → typed error with the field name
  fake.projects.ABC.requiredFields['1'] = [{ fieldId: 'customfield_99', name: '고객 코드', required: true }];
  r = await A.c('POST', `${RJ(A, R.id)}/issues`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'jira_required_fields'); assert.match(r.json.error.message, /고객 코드/);
  server.close();
});

test('requirement Jira: link existing by key (also when linked to a WBS), duplicates, other project, unknown key, unlink keeps the Jira issue, search marks linked requirements', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const R1 = await mkReq(A, { title: '주문 조회' }); const R2 = await mkReq(A, { title: '배송 조회' });
  fake.addIssue('ABC-50', { summary: '주문 API', status: 'inprogress' }); fake.addIssue('ABC-51', { summary: '주문 화면' });
  fake.projects.OTH = { id: '10900', key: 'OTH', name: '다른 프로젝트', issueTypes: [{ id: '1', name: 'Task' }], requiredFields: {} }; fake.seq.OTH = 1; fake.addIssue('OTH-1', { summary: '남의 것', project: 'OTH' });
  // ABC-50 is also the execution issue of a WBS leaf → still linkable to requirements
  const w = (await A.c('POST', A.wbs, { title: '주문 개발' })).json.item;
  assert.equal((await A.c('POST', `${A.wbs}/${w.id}/jira/links`, { issue_keys: ['ABC-50'] })).status, 201);
  let r = await A.c('POST', `${RJ(A, R1.id)}/links`, { issue_keys: ['abc-50', 'ABC-51', 'ABC-999', 'OTH-1'] }); assert.equal(r.status, 201);
  const by = Object.fromEntries(r.json.results.map((x) => [x.key, x]));
  assert.equal(by['ABC-50'].ok, true); assert.equal(by['ABC-51'].ok, true); assert.equal(by['ABC-999'].ok, false); assert.match(by['ABC-999'].error, /찾을 수 없습니다/); assert.equal(by['OTH-1'].ok, false); assert.match(by['OTH-1'].error, /연결된 Jira 프로젝트/);
  assert.equal(r.json.jira.links.length, 2); assert.equal(r.json.jira.summary.in_progress, 1);
  r = await A.c('POST', `${RJ(A, R1.id)}/links`, { issue_keys: ['ABC-50'] }); assert.equal(r.json.results[0].ok, false); assert.match(r.json.results[0].error, /이미 이 요구사항/);
  assert.equal((await A.c('POST', `${RJ(A, R2.id)}/links`, { issue_keys: ['ABC-50'] })).json.results[0].ok, true);   // one issue → several requirements
  assert.equal((await A.c('POST', `${RJ(A, R1.id)}/links`, { issue_keys: ['nope'] })).status, 400);
  // WBS pane unaffected (one EXECUTION link, the requirement links do not count there)
  r = await A.c('GET', `${A.wbs}/${w.id}/jira`); assert.equal(r.json.links.length, 1); assert.equal(r.json.summary.total, 1);
  r = await A.c('GET', PJ(A)); assert.equal(Number(r.json.counts.execution), 1); assert.equal(Number(r.json.counts.requirements), 3);
  // search shows where an issue is linked
  r = await A.c('GET', `${PJ(A)}/issues/search?q=ABC-50`); const hit = r.json.issues.find((i) => i.external_key === 'ABC-50'); assert.equal(hit.linked_wbs.id, w.id); assert.deepEqual(hit.linked_requirements.map((x) => x.id).sort(), [R1.id, R2.id].sort());
  // unlink: RELAI link only; Jira issue untouched; history + activity
  const lid = (await A.c('GET', RJ(A, R1.id))).json.links.find((l) => l.external_key === 'ABC-51').id;
  r = await A.c('DELETE', `${RJ(A, R1.id)}/links/${lid}`); assert.equal(r.status, 200); assert.equal(r.json.jira.links.length, 1);
  assert.ok([...fake.issues.values()].some((x) => x.key === 'ABC-51'));
  assert.equal((await A.c('DELETE', `${RJ(A, R1.id)}/links/${lid}`)).status, 404);
  assert.equal((await A.c('DELETE', `${RJ(A, R2.id)}/links/${(await A.c('GET', RJ(A, R1.id))).json.links[0].id}`)).status, 404);   // a link of another requirement
  assert.ok((await db.get(`SELECT 1 FROM requirement_history WHERE requirement_id = ? AND action_type = 'JIRA_UNLINKED'`, [R1.id])));
  assert.ok((await A.c('GET', PJ(A))).json.activity.some((a) => a.action === 'ISSUE_UNLINKED' && /ABC-51/.test(a.summary)));
  // relink after unlink is allowed
  assert.equal((await A.c('POST', `${RJ(A, R1.id)}/links`, { issue_keys: ['ABC-51'] })).json.results[0].ok, true);
  // archived requirement: read-only
  await A.c('POST', `${A.req}/${R2.id}/archive`, {});
  r = await A.c('POST', `${RJ(A, R2.id)}/links`, { issue_keys: ['ABC-51'] }); assert.equal(r.status, 400);
  server.close();
});

test('requirement Jira: bulk 지라 태스크 만들기 creates one issue per requirement, skips linked/archived, caps at 50', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const rs = []; for (const t of ['가', '나', '다']) rs.push(await mkReq(A, { title: t }));
  await A.c('POST', `${RJ(A, rs[1].id)}/issues`, {});
  const before = fake.issues.size;
  let r = await A.c('POST', `${A.req}/jira/bulk-create`, { ids: rs.map((x) => x.id) }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created.length, 2); assert.equal(r.json.skipped.length, 1); assert.match(r.json.skipped[0].reason, /이미 Jira 이슈/);
  assert.equal(fake.issues.size - before, 2); assert.equal(r.json.jira.by[rs[0].id].total, 1);
  assert.equal((await A.c('POST', `${A.req}/jira/bulk-create`, { ids: [] })).status, 400);
  assert.equal((await A.c('POST', `${A.req}/jira/bulk-create`, { ids: Array.from({ length: 51 }, (_, i) => `x${i}`) })).status, 400);
  server.close();
});

test('requirement Jira sync: webhook / manual / scheduled update the chip and 지라 진행률; status never changes; optional 구현 완료 mark (default off)', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); const mapped = await connect(A, fake);
  assert.equal(mapped.mapping.auto_mark_requirements, false);
  const base = `http://127.0.0.1:${server.address().port}`;
  const R = await mkReq(A, { title: '결제', status: 'CONFIRMED' });
  const k1 = (await A.c('POST', `${RJ(A, R.id)}/issues`, {})).json.issue.external_key; const k2 = (await A.c('POST', `${RJ(A, R.id)}/issues`, {})).json.issue.external_key;
  const c = (await A.c('GET', INT(A))).json.providers[0].connection; const row = await db.get('SELECT webhook_secret FROM integration_connections WHERE id = ?', [c.id]);
  const hook = async (body) => fetch(`${base}/api/integrations/jira/webhook/${c.id}/${row.webhook_secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signJwt({ iss: 'atlassian', exp: Math.floor(Date.now() / 1000) + 300 }, 'test-client-secret')}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  // webhook → chip updates; toggle off → no mark, status untouched
  fake.setStatus(k1, 'done');
  let r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 1, issue: { key: k1 } }); assert.equal(r.json.result, 'updated');
  r = await A.c('GET', RJ(A, R.id)); assert.equal(r.json.links.find((l) => l.external_key === k1).status_category, 'done'); assert.equal(r.json.summary.rate, 50);
  fake.setStatus(k2, 'done'); await hook({ webhookEvent: 'jira:issue_updated', timestamp: 2, issue: { key: k2 } });
  r = await A.c('GET', RJ(A, R.id)); assert.equal(r.json.summary.rate, 100); assert.equal(r.json.jira_done_at, null);
  assert.equal((await A.c('GET', `${A.req}/${R.id}`)).json.requirement.status, 'CONFIRMED');
  // turn the toggle on → evaluated at once; MEMBER cannot change the mapping
  const M = await addMember(client, A, 'm@x.com', '멤버', 'MEMBER');
  assert.equal((await M.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1', auto_mark_requirements: true })).status, 403);
  r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1', auto_mark_requirements: true }); assert.equal(r.json.mapping.auto_mark_requirements, true);
  r = await A.c('GET', RJ(A, R.id)); assert.ok(r.json.jira_done_at); let det = (await A.c('GET', `${A.req}/${R.id}`)).json.requirement; assert.equal(det.status, 'CONFIRMED'); assert.ok(det.history.some((h) => h.action_type === 'JIRA_DONE'));
  assert.ok((await A.c('GET', A.req)).json.jira.auto_mark);
  // reopened in Jira → manual refresh clears the mark
  fake.setStatus(k2, 'inprogress');
  r = await A.c('POST', `${RJ(A, R.id)}/refresh`, {}); assert.equal(r.status, 200); assert.equal(r.json.run.items_total, 2); assert.equal(r.json.jira.jira_done_at, null); assert.equal(r.json.jira.summary.in_progress, 1);
  // scheduled reconciliation picks requirement links up too
  fake.setStatus(k2, 'done'); await db.run(`UPDATE integration_connections SET last_synced_at = now() - interval '2 hours'`);
  const jobs = await runIntegrationJobs(db, { olderThanMinutes: 30 }); assert.ok(jobs.synced.some((x) => x.project_id === A.p.id && x.items_total >= 2));
  r = await A.c('GET', RJ(A, R.id)); assert.ok(r.json.jira_done_at); assert.equal(r.json.summary.done, 2);
  // deleted in Jira → MISSING via webhook, mark cleared
  r = await hook({ webhookEvent: 'jira:issue_deleted', timestamp: 3, issue: { key: k1 } }); assert.equal(r.json.result, 'missing');
  r = await A.c('GET', RJ(A, R.id)); assert.equal(r.json.summary.missing, 1); assert.equal(r.json.jira_done_at, null);
  // toggle off → marks cleared for the project
  fake.setStatus(k2, 'done');
  await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1', auto_mark_requirements: false });
  assert.equal((await db.get('SELECT COUNT(*) n FROM requirements WHERE project_id = ? AND jira_done_at IS NOT NULL', [A.p.id])).n, 0);
  // an issue linked to both a WBS leaf and a requirement: one webhook updates both
  const w = (await A.c('POST', A.wbs, { title: '결제 개발' })).json.item;
  await A.c('POST', `${A.wbs}/${w.id}/jira/links`, { issue_keys: [k2] });
  fake.setStatus(k2, 'todo'); await hook({ webhookEvent: 'jira:issue_updated', timestamp: 4, issue: { key: k2 } });
  assert.equal((await A.c('GET', `${A.wbs}/${w.id}/jira`)).json.links[0].status_category, 'new');
  assert.equal((await A.c('GET', RJ(A, R.id))).json.links.find((l) => l.external_key === k2).status_category, 'new');
  server.close();
});

test('requirement Jira permissions + isolation: MEMBER can link/create, another workspace cannot read or write, archived project read-only, disconnect keeps links, fake-only route absent', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const B = await setup(client, 'b@x.com', '김비');
  const R = await mkReq(A, { title: '권한' }); fake.addIssue('ABC-70', { summary: 'x' });
  const M = await addMember(client, A, 'm2@x.com', '멤버', 'MEMBER');
  assert.equal((await M.c('POST', `${RJ(A, R.id)}/links`, { issue_keys: ['ABC-70'] })).status, 201);
  assert.equal((await M.c('POST', `${RJ(A, R.id)}/issues`, {})).status, 201);
  // B: not a member of A's workspace; B's own path with A's requirement id → 404
  assert.equal((await B.c('GET', RJ(A, R.id))).status, 404);
  assert.equal((await B.c('POST', `${RJ(A, R.id)}/issues`, {})).status, 404);
  assert.equal((await B.c('GET', `${B.req}/${R.id}/jira`)).status, 404);
  assert.equal((await B.c('POST', `${B.req}/${R.id}/jira/links`, { issue_keys: ['ABC-70'] })).status, 404);
  assert.equal((await B.c('POST', `${B.req}/jira/bulk-create`, { ids: [R.id] })).status, 409);   // B is not connected
  const lid = (await A.c('GET', RJ(A, R.id))).json.links[0].id;
  const BR = await mkReq(B, { title: 'B 요구사항' });
  assert.equal((await B.c('DELETE', `${B.req}/${BR.id}/jira/links/${lid}`)).status, 404);
  // bulk in A with B's id → skipped as not found
  const r = await A.c('POST', `${A.req}/jira/bulk-create`, { ids: [BR.id] }); assert.equal(r.json.created.length, 0); assert.match(r.json.skipped[0].reason, /찾을 수 없습니다/);
  // B's list never sees A's Jira data
  assert.equal((await B.c('GET', B.req)).json.jira, null);
  // archived project → writes refused, reads ok
  await db.run(`UPDATE projects SET status = 'ARCHIVED' WHERE id = ?`, [A.p.id]);
  assert.equal((await A.c('GET', RJ(A, R.id))).status, 200);
  assert.ok([409, 403, 423].includes((await A.c('POST', `${RJ(A, R.id)}/links`, { issue_keys: ['ABC-70'] })).status));
  await db.run(`UPDATE projects SET status = 'ACTIVE' WHERE id = ?`, [A.p.id]);
  // workspace disconnect: links stay (audit) but the pane shows the connect state
  await A.c('POST', `${INT(A)}/jira/disconnect`, {});
  const d = (await A.c('GET', RJ(A, R.id))).json; assert.equal(d.connected, false);
  assert.ok(Number((await db.get(`SELECT COUNT(*) n FROM integration_entity_links WHERE requirement_id = ? AND status <> 'REMOVED'`, [R.id])).n) >= 2);
  assert.equal((await A.c('POST', `${RJ(A, R.id)}/issues`, {})).status, 409);
  assert.equal((await A.c('POST', '/api/integrations/jira/fake/status', { key: 'ABC-70', status: 'done' })).status, 404);   // INTEGRATION_PROVIDER=live → not mounted
  server.close();
});
