/* Phase 12 — Jira Cloud integration against the fake provider (no network). Covers OAuth, permissions, mapping,
 * WBS link policy (leaf/group/milestone/legacy SUMMARY), stable ids through tree edits, execution aggregation,
 * auto-complete, requirement trace, sync (manual/webhook/scheduled/retry), security and admin. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup, addMember } from './api-helpers.js';
import { setProvider } from '../integrations/registry.js';
import { fakeJiraProvider } from '../integrations/jira/provider.js';
import { encrypt, decrypt, signJwt, verifyJwt } from '../integrations/crypto.js';
import { ensureAccessToken } from '../integrations/service.js';
import { runIntegrationJobs } from '../integrations/scheduler.js';

process.env.ATLASSIAN_CLIENT_ID = 'cid'; process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret'; process.env.ATLASSIAN_REDIRECT_URI = 'https://relai.test/api/integrations/jira/callback';
process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64); process.env.INTEGRATION_PROVIDER = 'live';

const mkWbs = async (A, body) => { const r = await A.c('POST', A.wbs, body); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.item; };
const INT = (A) => `/api/workspaces/${A.w}/integrations`;
const PJ = (A) => `${A.purl}/integrations/jira`;
const WJ = (A, id) => `${A.wbs}/${id}/jira`;

/** Connects the workspace through the full OAuth round trip (start → callback) and maps the project to ABC. */
async function connect(A, fake, { map = true, leafType = '1', groupType = '3', auto = false } = {}) {
  setProvider(fake);
  const s = await A.c('POST', `${INT(A)}/jira/connect`, {}); assert.equal(s.status, 200, JSON.stringify(s.json));
  const cb = await A.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s.json.state)}`);
  assert.equal(cb.status, 302);
  if (map) { const r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: leafType, group_issue_type_id: groupType, auto_complete_leaf_wbs: auto }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; }
  return null;
}
const conn = (A) => A.c('GET', INT(A)).then((r) => r.json.providers[0].connection);

test('crypto: AES-GCM round trip, tamper detection, JWT HS256 sign/verify (jose)', async () => {
  const ct = encrypt('secret-token'); assert.notEqual(ct, 'secret-token'); assert.match(ct, /^v1\./); assert.equal(decrypt(ct), 'secret-token');
  assert.throws(() => decrypt(ct.slice(0, -2) + 'xx'));
  const jwt = await signJwt({ iss: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, 'k'); assert.ok(await verifyJwt(jwt, 'k')); assert.equal(await verifyJwt(jwt, 'wrong'), null);
  assert.equal(await verifyJwt(await signJwt({ exp: Math.floor(Date.now() / 1000) - 600 }, 'k'), 'k'), null);
});

test('OAuth: OWNER/ADMIN connect, MEMBER forbidden, state validation (unknown/expired/other user), tokens encrypted and never exposed', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); setProvider(fake);
  const AD = await addMember(client, A, 'ad@x.com', '관리자', 'ADMIN'); const M = await addMember(client, A, 'm@x.com', '멤버', 'MEMBER');
  assert.equal((await M.c('POST', `${INT(A)}/jira/connect`, {})).status, 403);
  assert.equal((await M.c('POST', `${INT(A)}/jira/disconnect`, {})).status, 403);
  let r = await A.c('GET', INT(A)); assert.equal(r.json.providers[0].configured, true); assert.equal(r.json.providers[0].connection, null);
  // bad state
  assert.equal((await A.c('GET', '/api/integrations/jira/callback?code=good-code&state=nope')).status, 302);
  assert.equal(await conn(A), null);
  // state started by ADMIN cannot be completed by OWNER
  const s1 = await AD.c('POST', `${INT(A)}/jira/connect`, {}); assert.equal(s1.status, 200); assert.match(s1.json.url, /state=/);
  await A.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s1.json.state)}`);
  assert.equal(await conn(A), null);
  // expired state
  const s2 = await AD.c('POST', `${INT(A)}/jira/connect`, {});
  await db.run(`UPDATE integration_oauth_states SET expires_at = now() - interval '1 minute' WHERE state = ?`, [s2.json.state]);
  await AD.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s2.json.state)}`);
  assert.equal(await conn(A), null);
  // happy path by ADMIN; state is single use
  const s3 = await AD.c('POST', `${INT(A)}/jira/connect`, {});
  const cb = await AD.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s3.json.state)}`); assert.equal(cb.status, 302);
  await AD.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s3.json.state)}`);
  const c = await conn(A); assert.equal(c.status, 'ACTIVE'); assert.equal(c.site_url, 'https://example.atlassian.net'); assert.equal(c.connected_by_name, '관리자');
  for (const k of Object.keys(c)) assert.ok(!/token|secret/i.test(k), k);
  const row = await db.get('SELECT * FROM integration_connections WHERE id = ?', [c.id]);
  assert.match(row.access_token_encrypted, /^v1\./); assert.match(row.refresh_token_encrypted, /^v1\./); assert.ok(!row.access_token_encrypted.includes('acc-')); assert.equal(decrypt(row.access_token_encrypted), 'acc-1');
  // MEMBER can read the card but not disconnect; OWNER disconnect wipes tokens, keeps row
  assert.equal((await M.c('GET', INT(A))).status, 200);
  r = await A.c('POST', `${INT(A)}/jira/disconnect`, {}); assert.equal(r.status, 200); assert.equal(r.json.providers[0].connection.status, 'DISABLED');
  const row2 = await db.get('SELECT access_token_encrypted, refresh_token_encrypted FROM integration_connections WHERE id = ?', [c.id]); assert.equal(row2.access_token_encrypted, null); assert.equal(row2.refresh_token_encrypted, null);
  server.close();
});

test('OAuth: rotating refresh replaced atomically, concurrent refresh uses one exchange, invalid refresh → reconnect_required', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake, { map: false });
  const c = await conn(A);
  await db.run(`UPDATE integration_connections SET access_token_expires_at = now() + interval '10 seconds' WHERE id = ?`, [c.id]);   // inside skew → refresh
  const before = fake.calls.filter((x) => x[0] === 'refresh').length;
  const [t1, t2, t3] = await Promise.all([ensureAccessToken(db, c.id), ensureAccessToken(db, c.id), ensureAccessToken(db, c.id)]);
  assert.equal(fake.calls.filter((x) => x[0] === 'refresh').length - before, 1);   // locked: one rotation
  assert.equal(t1.accessToken, t2.accessToken); assert.equal(t2.accessToken, t3.accessToken); assert.equal(t1.accessToken, 'acc-2');
  const row = await db.get('SELECT * FROM integration_connections WHERE id = ?', [c.id]);
  assert.equal(decrypt(row.refresh_token_encrypted), 'ref-2'); assert.ok(new Date(row.access_token_expires_at) > new Date(Date.now() + 3000000));
  // the old refresh token is gone (single use); forcing a refresh with a revoked token → reconnect_required, connection ERROR
  fake.tokens.validRefresh.clear();
  await db.run(`UPDATE integration_connections SET access_token_expires_at = now() WHERE id = ?`, [c.id]);
  await assert.rejects(() => ensureAccessToken(db, c.id), (e) => e.code === 'reconnect_required');
  const c2 = await conn(A); assert.equal(c2.status, 'ERROR'); assert.equal(c2.reconnect_required, true);
  // API calls now say reconnect, no retry loop
  const r = await A.c('GET', `${PJ(A)}/projects`); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'reconnect_required');
  assert.equal(fake.calls.filter((x) => x[0] === 'refresh').length - before, 2);
  // reconnect restores
  await connect(A, fake, { map: false }); assert.equal((await conn(A)).status, 'ACTIVE');
  server.close();
});

test('project mapping: list Jira projects / issue types, map, invalid project, change option, remove keeps history; permissions', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake, { map: false });
  const M = await addMember(client, A, 'm@x.com', '멤버', 'MEMBER');
  let r = await A.c('GET', `${PJ(A)}/projects?q=abc`); assert.equal(r.status, 200); assert.deepEqual(r.json.projects.map((p) => p.key), ['ABC']);
  r = await A.c('GET', `${PJ(A)}/issue-types?project_key=ABC`); assert.deepEqual(r.json.issue_types.map((t) => t.name), ['Task', 'Story', 'Epic', 'Bug']);
  assert.equal((await M.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC' })).status, 403);
  r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'NOPE', leaf_issue_type_id: '1' }); assert.equal(r.status, 400); assert.match(r.json.error.fields.external_project_key, /찾을 수 없/);
  r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '99' }); assert.equal(r.status, 400);
  r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'abc', leaf_issue_type_id: '2', group_issue_type_id: '3' }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mapping.external_project_key, 'ABC'); assert.equal(r.json.mapping.leaf_issue_type_name, 'Story'); assert.equal(r.json.mapping.group_issue_type_name, 'Epic'); assert.equal(r.json.mapping.auto_complete_leaf_wbs, false);
  assert.equal(fake.webhooks.length, 1); assert.match(fake.webhooks[0].url, /^https:\/\/relai\.test\/api\/integrations\/jira\/webhook\//); assert.deepEqual(fake.webhooks[0].events, ['jira:issue_updated', 'jira:issue_deleted']);
  // MEMBER can read the mapping screen
  r = await M.c('GET', PJ(A)); assert.equal(r.status, 200); assert.equal(r.json.mapping.external_project_key, 'ABC');
  assert.ok(r.json.activity.some((a) => a.action === 'PROJECT_MAPPED'));
  // toggle option
  r = await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1', auto_complete_leaf_wbs: true }); assert.equal(r.json.mapping.auto_complete_leaf_wbs, true); assert.equal(r.json.mapping.leaf_issue_type_name, 'Task');
  // remove: mapping REMOVED (history kept), webhook deleted, screen shows previous mapping
  r = await A.c('DELETE', `${PJ(A)}/mapping`); assert.equal(r.status, 200); assert.equal(r.json.mapping, null); assert.equal(r.json.previous_mapping.external_project_key, 'ABC');
  assert.equal((await db.get(`SELECT COUNT(*) n FROM integration_project_mappings WHERE project_id = ?`, [A.p.id])).n, 1);
  assert.equal(fake.webhooks.length, 0);
  assert.equal((await A.c('DELETE', `${PJ(A)}/mapping`)).status, 404);
  server.close();
});

test('WBS links: leaf create/link, multiple issues per WBS, same issue second WBS blocked, group EXECUTION blocked, group Epic optional, milestone blocked, legacy SUMMARY by is_group', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const M = await addMember(client, A, 'm@x.com', '멤버', 'MEMBER');
  const g = await mkWbs(A, { title: 'SSO 구축' });
  const leaf = await mkWbs(A, { title: 'Backend 구현', parent_id: g.id, description: '인증 API\n\nSAML' });
  const leaf2 = await mkWbs(A, { title: 'Frontend 구현', parent_id: g.id });
  const ms = await mkWbs(A, { title: '오픈', item_type: 'MILESTONE', milestone_date: '2026-12-01' });
  const legacy = await mkWbs(A, { title: '레거시 SUMMARY (자식 없음)', item_type: 'SUMMARY' });
  const req = (await A.c('POST', A.req, { title: 'SSO 인증 지원', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED' })).json.requirement;
  await A.c('POST', `${A.req}/${req.id}/links`, { wbs_item_id: leaf.id });
  // 13. create from leaf (MEMBER allowed): summary default, ADF description with requirement + link
  let r = await M.c('POST', `${WJ(A, leaf.id)}/issues`, {}); assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.issue.external_key, 'ABC-101'); assert.equal(r.json.issue.summary, `[${leaf.wbs_code}] Backend 구현`); assert.equal(r.json.issue.browser_url, 'https://example.atlassian.net/browse/ABC-101');
  const created = [...fake.issues.values()].find((x) => x.key === 'ABC-101'); assert.equal(created.description.type, 'doc'); assert.equal(created.description.version, 1);
  const txt = JSON.stringify(created.description); assert.match(txt, /RELAI WBS/); assert.match(txt, /REQ-001 SSO 인증 지원/); assert.match(txt, /relai\.test\/app\/projects/); assert.match(txt, /bulletList/);
  assert.equal(created.type, 'Task');
  // 14/15. link existing: multiple at once (one WBS → many issues)
  fake.addIssue('ABC-142', { summary: '인증 API', status: 'inprogress', assignee: { accountId: 'u1', displayName: '김개발' } }); fake.addIssue('ABC-145', { summary: 'SAML Parser', status: 'done' }); fake.addIssue('ABC-205', { summary: 'Safari 로그인 실패', type: 'Bug' });
  r = await M.c('POST', `${WJ(A, leaf.id)}/links`, { issue_keys: ['ABC-142', 'abc-145', 'ABC-205', 'ABC-999'] }); assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.results.map((x) => [x.key, x.ok]), [['ABC-142', true], ['ABC-145', true], ['ABC-205', true], ['ABC-999', false]]);
  assert.equal(r.json.links.length, 4); assert.deepEqual(r.json.summary, { total: 4, done: 1, in_progress: 1, todo: 2, missing: 0, rate: 25 });
  const l142 = r.json.links.find((l) => l.external_key === 'ABC-142'); assert.equal(l142.status_name, 'In Progress'); assert.equal(l142.status_category, 'indeterminate'); assert.equal(l142.assignee_name, '김개발'); assert.equal(l142.issue_type, 'Task');
  // 16. same issue on a second WBS → blocked with the holder shown
  r = await A.c('POST', `${WJ(A, leaf2.id)}/links`, { issue_keys: ['ABC-142'] }); assert.equal(r.status, 201);
  assert.equal(r.json.results[0].ok, false); assert.match(r.json.results[0].error, /이미 WBS/); assert.equal(r.json.results[0].linked_wbs.id, leaf.id);
  r = await A.c('GET', `${PJ(A)}/issues/search?q=ABC-142`); assert.equal(r.json.issues[0].linked_wbs.wbs_code, leaf.wbs_code);
  // search by text within mapped project only
  r = await A.c('GET', `${PJ(A)}/issues/search?q=SAML`); assert.deepEqual(r.json.issues.map((i) => i.external_key), ['ABC-145']);
  // 17. group EXECUTION blocked; 18. group Epic allowed and excluded from rate; 19. milestone blocked; create on group blocked
  r = await A.c('POST', `${WJ(A, g.id)}/links`, { issue_keys: ['ABC-145'] }); assert.equal(r.status, 400); assert.match(r.json.error.fields.wbs_item_id, /Group/);
  assert.equal((await A.c('POST', `${WJ(A, g.id)}/issues`, {})).status, 400);
  fake.addIssue('ABC-100', { summary: 'SSO Epic', type: 'Epic', status: 'done' });
  r = await A.c('POST', `${WJ(A, g.id)}/links`, { issue_keys: ['ABC-100'], link_role: 'EPIC' }); assert.equal(r.status, 201); assert.equal(r.json.results[0].ok, true); assert.equal(r.json.links[0].link_role, 'EPIC');
  assert.equal(r.json.summary.total, 4);   // group aggregates descendant leaves; the Done epic is not counted
  r = await A.c('POST', `${WJ(A, leaf.id)}/links`, { issue_keys: ['ABC-205'], link_role: 'EPIC' }); assert.equal(r.status, 400);   // epic only on groups
  r = await A.c('POST', `${WJ(A, ms.id)}/links`, { issue_keys: ['ABC-145'] }); assert.equal(r.status, 400); assert.match(r.json.error.fields.wbs_item_id, /마일스톤/);
  assert.equal((await A.c('POST', `${WJ(A, ms.id)}/issues`, {})).status, 400);
  // 20. legacy SUMMARY without children is a leaf for Jira purposes (is_group, not enum); with a child it becomes a group
  r = await A.c('POST', `${WJ(A, legacy.id)}/issues`, { summary: '레거시 작업' }); assert.equal(r.status, 201);
  await mkWbs(A, { title: '자식', parent_id: legacy.id });
  r = await A.c('POST', `${WJ(A, legacy.id)}/links`, { issue_keys: ['ABC-145'] }); assert.equal(r.status, 400);
  // list response carries the optional column data; detail has jira summary; wbs progress untouched
  r = await A.c('GET', A.wbs); assert.equal(r.json.jira.enabled, true); assert.deepEqual(r.json.jira.by[leaf.id].total, 4); assert.equal(r.json.jira.by[g.id].total, 4); assert.equal(r.json.jira.by[leaf2.id], undefined);
  assert.equal(r.json.items.find((i) => i.id === leaf.id).progress, 0); assert.equal(r.json.items.find((i) => i.id === leaf.id).computed_status, 'PLANNED');
  r = await A.c('GET', `${A.wbs}/${leaf.id}`); assert.equal(r.json.item.jira.total, 4);
  // unlink keeps the Jira issue, history recorded
  const lid = l142.id; r = await M.c('DELETE', `${WJ(A, leaf.id)}/links/${lid}`); assert.equal(r.status, 200); assert.equal(r.json.links.length, 3);
  assert.ok([...fake.issues.values()].some((x) => x.key === 'ABC-142'));
  const h = (await A.c('GET', `${A.wbs}/${leaf.id}`)).json.item.history.map((x) => x.action_type); assert.ok(h.includes('JIRA_LINKED') && h.includes('JIRA_UNLINKED'));
  // re-link allowed after unlink (unique index only on live links)
  r = await A.c('POST', `${WJ(A, leaf2.id)}/links`, { issue_keys: ['ABC-142'] }); assert.equal(r.json.results[0].ok, true);
  // requirement: no direct Jira endpoints, indirect trace through WBS
  assert.equal((await A.c('POST', `${A.req}/${req.id}/jira/links`, { issue_keys: ['ABC-145'] })).status, 404);
  r = await A.c('GET', `${A.req}/${req.id}`); assert.equal(r.json.requirement.jira.total, 3); assert.equal(r.json.requirement.jira.done, 1); assert.equal(r.json.requirement.jira.wbs[0].jira.total, 3);
  server.close();
});

test('stable id: links survive renumber (move/indent/outdent), promote-after-archive, duplicate does not copy, archive pauses, restore resumes', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const p1 = await mkWbs(A, { title: '1' }); const p2 = await mkWbs(A, { title: '2' }); const c21 = await mkWbs(A, { title: '2.1', parent_id: p2.id });
  fake.addIssue('ABC-142', { summary: 'a', status: 'done' }); fake.addIssue('ABC-143', { summary: 'b' });
  let r = await A.c('POST', `${WJ(A, c21.id)}/links`, { issue_keys: ['ABC-142', 'ABC-143'] }); assert.equal(r.json.links.length, 2);
  const linkRow = async () => db.all(`SELECT wbs_item_id, status FROM integration_entity_links WHERE project_id = ? AND status <> 'REMOVED' ORDER BY external_key`, [A.p.id]);
  // 21/22. move to root, indent under 1, outdent → code changes, link row untouched
  r = await A.c('POST', `${A.wbs}/${c21.id}/move`, { parent_id: null, sequence: 1 }); assert.equal(r.json.items.find((i) => i.id === c21.id).wbs_code, '1');
  r = await A.c('POST', `${A.wbs}/${p1.id}/indent`, {}); r = await A.c('POST', `${A.wbs}/${c21.id}/move`, { parent_id: p2.id }); r = await A.c('POST', `${A.wbs}/${c21.id}/indent`, {}).catch(() => null);
  const code = (await A.c('GET', A.wbs)).json.items.find((i) => i.id === c21.id).wbs_code; assert.notEqual(code, '2.1');
  assert.deepEqual((await linkRow()).map((l) => l.wbs_item_id), [c21.id, c21.id]);
  r = await A.c('GET', `${WJ(A, c21.id)}`); assert.equal(r.json.links.length, 2);
  // 23. archive parent with promote → child keeps id and links
  r = await A.c('POST', `${A.wbs}/${p2.id}/archive`, { children: 'promote' }); assert.equal(r.status, 200);
  assert.ok(r.json.items.some((i) => i.id === c21.id)); assert.deepEqual((await linkRow()).map((l) => l.wbs_item_id), [c21.id, c21.id]);
  // 24. duplicate does not copy links
  r = await A.c('POST', `${A.wbs}/${c21.id}/duplicate`, {}); assert.equal(r.status, 201);
  assert.equal((await A.c('GET', WJ(A, r.json.item.id))).json.links.length, 0); assert.equal((await linkRow()).length, 2);
  // 25. archive the linked WBS: Jira issue untouched, links kept (paused: excluded from sync), 57. restore resumes
  const before = fake.issues.size;
  r = await A.c('POST', `${A.wbs}/${c21.id}/archive`, {}); assert.equal(r.status, 200); assert.equal(fake.issues.size, before);
  assert.equal((await linkRow()).length, 2);
  r = await A.c('GET', WJ(A, c21.id)); assert.equal(r.json.paused, true); assert.equal(r.json.links.length, 2);
  fake.setStatus('ABC-143', 'done');
  r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.items_total, 0);   // archived → not synced
  r = await A.c('POST', `${A.wbs}/${c21.id}/restore`, {}); assert.equal(r.status, 200);
  r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.items_total, 2); assert.equal(r.json.run.items_success, 2);
  r = await A.c('GET', WJ(A, c21.id)); assert.equal(r.json.summary.done, 2); assert.equal(r.json.paused, false);
  // detail of a WBS with no mapping project → still works (not mapped flag)
  const B = await setup(client, 'b@x.com'); const bw = await mkWbs(B, { title: 'x' });
  r = await B.c('GET', WJ(B, bw.id)); assert.equal(r.json.mapped, false); assert.equal((await B.c('GET', B.wbs)).json.jira, null);
  server.close();
});

test('execution: status categories, leaf/group/project rates, epic excluded, WBS progress unaffected, auto-complete OFF/ON (leaf only), requirement status unchanged', async () => {
  const { server, client } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const g = await mkWbs(A, { title: 'G' }); const a = await mkWbs(A, { title: 'A', parent_id: g.id, progress: 70, status: 'IN_PROGRESS' }); const b = await mkWbs(A, { title: 'B', parent_id: g.id });
  const req = (await A.c('POST', A.req, { title: 'R', type: 'FUNCTIONAL', priority: 'HIGH', scope: 'IN_SCOPE', status: 'CONFIRMED' })).json.requirement; await A.c('POST', `${A.req}/${req.id}/links`, { wbs_item_id: a.id });
  fake.addIssue('ABC-1', { summary: 'a1', status: 'done' }); fake.addIssue('ABC-2', { summary: 'a2', status: 'qa' }); fake.addIssue('ABC-3', { summary: 'b1', status: 'todo' }); fake.addIssue('ABC-9', { summary: 'epic', type: 'Epic', status: 'done' });
  await A.c('POST', `${WJ(A, a.id)}/links`, { issue_keys: ['ABC-1', 'ABC-2'] }); await A.c('POST', `${WJ(A, b.id)}/links`, { issue_keys: ['ABC-3'] }); await A.c('POST', `${WJ(A, g.id)}/links`, { issue_keys: ['ABC-9'], link_role: 'EPIC' });
  let r = await A.c('GET', WJ(A, a.id)); assert.deepEqual(r.json.summary, { total: 2, done: 1, in_progress: 1, todo: 0, missing: 0, rate: 50 });
  assert.equal(r.json.links.find((l) => l.external_key === 'ABC-2').status_name, 'QA 검증');   // custom status name kept, category drives the rate
  r = await A.c('GET', WJ(A, g.id)); assert.deepEqual(r.json.summary, { total: 3, done: 1, in_progress: 1, todo: 1, missing: 0, rate: 33 });
  r = await A.c('GET', PJ(A)); assert.equal(r.json.summary.total, 3); assert.equal(r.json.summary.done, 1); assert.equal(r.json.summary.rate, 33); assert.equal(r.json.counts.epics, 1);
  // 32/33. WBS progress stays 70 / group roll-up unaffected; all done with auto OFF → nothing changes
  fake.setStatus('ABC-2', 'done'); r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.status, 'SUCCESS');
  let tree = (await A.c('GET', A.wbs)).json; assert.equal(tree.items.find((i) => i.id === a.id).progress, 70); assert.equal(tree.items.find((i) => i.id === a.id).status, 'IN_PROGRESS'); assert.equal(tree.jira.by[a.id].rate, 100);
  // 34. auto ON → leaf completes via the regular update (history source), group stays roll-up, requirement untouched
  await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1', group_issue_type_id: '3', auto_complete_leaf_wbs: true });
  r = await A.c('POST', `${PJ(A)}/sync`, {});
  tree = (await A.c('GET', A.wbs)).json; const A1 = tree.items.find((i) => i.id === a.id); assert.equal(A1.status, 'COMPLETED'); assert.equal(A1.progress, 100);
  const G = tree.items.find((i) => i.id === g.id); assert.equal(G.computed_progress, 50); assert.equal(G.status, 'NOT_STARTED');   // group untouched (roll-up only)
  const hist = (await A.c('GET', `${A.wbs}/${a.id}`)).json.item.history; assert.ok(hist.some((h) => h.action_type === 'JIRA_AUTO_COMPLETED' && h.new_value === 'jira_sync')); assert.ok(hist.some((h) => h.action_type === 'UPDATED' && h.field_name === 'status' && h.new_value === 'COMPLETED'));
  assert.equal((await A.c('GET', `${A.req}/${req.id}`)).json.requirement.status, 'CONFIRMED');
  // b has a To Do issue → not completed; epic Done never completes the group
  assert.equal(tree.items.find((i) => i.id === b.id).status, 'NOT_STARTED');
  // activity feed carries integration events (coarse ones only)
  r = await A.c('GET', `${A.purl}/activity?limit=50`); const kinds = r.json.items.filter((i) => i.entity_type === 'JIRA'); assert.ok(kinds.some((i) => /완료 처리/.test(i.summary))); assert.ok(kinds.some((i) => /연결했습니다/.test(i.summary)));
  server.close();
});

test('sync: manual, webhook update/delete, duplicate webhook, invalid auth, missing issue, scheduled reconciliation + webhook renewal, retry on 429/5xx/timeout, sync log', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const base = `http://127.0.0.1:${server.address().port}`;
  const w = await mkWbs(A, { title: 'W' }); fake.addIssue('ABC-10', { summary: 's', status: 'todo' }); fake.addIssue('ABC-11', { summary: 't', status: 'todo' });
  await A.c('POST', `${WJ(A, w.id)}/links`, { issue_keys: ['ABC-10', 'ABC-11'] });
  const c = await conn(A); const row = await db.get('SELECT webhook_secret FROM integration_connections WHERE id = ?', [c.id]);
  const hook = async (body, { secret = 'test-client-secret', path = row.webhook_secret, id = null } = {}) => fetch(`${base}/api/integrations/jira/webhook/${c.id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signJwt({ iss: 'atlassian', exp: Math.floor(Date.now() / 1000) + 300 }, secret)}`, ...(id ? { 'x-atlassian-webhook-identifier': id } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  // 39. webhook update → snapshot refreshed from Jira (payload not trusted)
  fake.setStatus('ABC-10', 'done');
  let r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 1, issue: { id: '999999', key: 'ABC-10', fields: { status: { name: 'HACKED' } } } }); assert.equal(r.status, 200); assert.equal(r.json.result, 'updated');
  r = await A.c('GET', WJ(A, w.id)); assert.equal(r.json.links.find((l) => l.external_key === 'ABC-10').status_category, 'done'); assert.equal(r.json.links.find((l) => l.external_key === 'ABC-10').status_name, 'Done');
  // 40. duplicate (same event id) ignored; same payload twice too
  r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 2, issue: { key: 'ABC-10' } }, { id: 'evt-1' }); assert.equal(r.json.result, 'updated');
  r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 3, issue: { key: 'ABC-10' } }, { id: 'evt-1' }); assert.equal(r.json.result, 'duplicate');
  r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 4, issue: { key: 'ABC-10' } }); r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 4, issue: { key: 'ABC-10' } }); assert.equal(r.json.result, 'duplicate');
  // 41. invalid auth: wrong signature / wrong path secret / unknown connection
  assert.equal((await hook({ webhookEvent: 'jira:issue_updated', timestamp: 5, issue: { key: 'ABC-10' } }, { secret: 'bad' })).status, 401);
  assert.equal((await hook({ webhookEvent: 'jira:issue_updated', timestamp: 5, issue: { key: 'ABC-10' } }, { path: 'nope' })).status, 404);
  assert.equal((await fetch(`${base}/api/integrations/jira/webhook/${c.id}/${row.webhook_secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  // unlinked issue / created event → ignored, nothing written
  r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 6, issue: { key: 'ABC-555' } }); assert.equal(r.json.result, 'ignored');
  r = await hook({ webhookEvent: 'jira:issue_created', timestamp: 7, issue: { key: 'ABC-11' } }); assert.equal(r.json.result, 'ignored');
  // 42. deleted → link MISSING, WBS stays, snapshot kept; manual sync also marks missing
  r = await hook({ webhookEvent: 'jira:issue_deleted', timestamp: 8, issue: { key: 'ABC-11' } }); assert.equal(r.json.result, 'missing');
  r = await A.c('GET', WJ(A, w.id)); const m11 = r.json.links.find((l) => l.external_key === 'ABC-11'); assert.equal(m11.status, 'MISSING'); assert.equal(m11.summary, 't'); assert.equal(r.json.summary.missing, 1);
  assert.ok((await A.c('GET', A.wbs)).json.items.some((i) => i.id === w.id));
  fake.deleteIssue('ABC-11'); r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.status, 'PARTIAL'); assert.equal(r.json.run.items_failed, 1);
  // unlink a missing link
  r = await A.c('DELETE', `${WJ(A, w.id)}/links/${m11.id}`); assert.equal(r.status, 200); assert.equal(r.json.links.length, 1);
  // 44/47. retry: 429 then 500 then ok → sync succeeds; timeout twice then ok; three failures → FAILED run logged
  fake.failNext = [{ status: 429, times: 1 }, { status: 500, times: 1 }]; r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.status, 'SUCCESS');
  fake.failNext = [{ kind: 'timeout', times: 2 }]; r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.status, 'SUCCESS');
  fake.failNext = [{ status: 503, times: 5 }]; r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.json.run.status, 'FAILED'); assert.match(r.json.run.error_summary, /503|Jira/);
  fake.failNext = [];
  const runs = await db.all('SELECT trigger, status FROM integration_sync_runs WHERE project_id = ? ORDER BY started_at', [A.p.id]);
  assert.ok(runs.filter((x) => x.trigger === 'WEBHOOK').length >= 2); assert.ok(runs.some((x) => x.trigger === 'MANUAL' && x.status === 'FAILED'));
  // 43. scheduled reconciliation: stale connection gets synced; webhook near expiry renewed; expired re-registered
  fake.setStatus('ABC-10', 'inprogress');
  await db.run(`UPDATE integration_connections SET last_synced_at = now() - interval '2 hours' WHERE id = ?`, [c.id]);
  await db.run(`UPDATE integration_webhooks SET expires_at = now() + interval '2 days' WHERE connection_id = ?`, [c.id]);
  let jobs = await runIntegrationJobs(db, { olderThanMinutes: 30 }); assert.equal(jobs.synced.length, 1); assert.equal(jobs.synced[0].status, 'SUCCESS'); assert.deepEqual(jobs.webhooks.map((x) => x.action), ['refreshed']);
  assert.equal((await A.c('GET', WJ(A, w.id))).json.links[0].status_category, 'indeterminate');
  const runs2 = await db.all(`SELECT trigger FROM integration_sync_runs WHERE project_id = ? AND trigger = 'SCHEDULED'`, [A.p.id]); assert.equal(runs2.length, 1);
  await db.run(`UPDATE integration_webhooks SET expires_at = now() - interval '1 day' WHERE connection_id = ?`, [c.id]);
  jobs = await runIntegrationJobs(db, { olderThanMinutes: 30 }); assert.deepEqual(jobs.webhooks.map((x) => x.action), ['reregistered']); assert.equal(fake.webhooks.length, 1);
  assert.equal(jobs.synced.length, 0);   // just synced → not due
  // disabled connection: webhook accepted but ignored; sync refused
  await A.c('POST', `${INT(A)}/jira/disconnect`, {});
  r = await hook({ webhookEvent: 'jira:issue_updated', timestamp: 9, issue: { key: 'ABC-10' } }); assert.equal(r.status, 202);
  r = await A.c('POST', `${PJ(A)}/sync`, {}); assert.equal(r.status, 409);
  server.close();
});

test('security: workspace isolation, archived project write blocked, admin view masks credentials', async () => {
  const { server, client, db } = await boot();
  const A = await setup(client); const fake = fakeJiraProvider(); await connect(A, fake);
  const B = await setup(client, 'b@x.com');
  const w = await mkWbs(A, { title: 'W' }); fake.addIssue('ABC-10', { summary: 's' }); await A.c('POST', `${WJ(A, w.id)}/links`, { issue_keys: ['ABC-10'] });
  // 48. other workspace: 404 everywhere, cannot see A's connection or mapping
  assert.equal((await B.c('GET', INT(A))).status, 404); assert.equal((await B.c('GET', PJ(A))).status, 404); assert.equal((await B.c('GET', WJ(A, w.id))).status, 404);
  assert.equal((await B.c('POST', `${PJ(A)}/sync`, {})).status, 404);
  assert.equal((await B.c('GET', INT(B))).json.providers[0].connection, null);
  // B's own project cannot link to A's issue via its own (nonexistent) mapping
  const bw = await mkWbs(B, { title: 'x' }); assert.equal((await B.c('POST', `${WJ(B, bw.id)}/links`, { issue_keys: ['ABC-10'] })).status, 409);
  // 49. archived project: reads OK, writes 409
  await A.c('POST', `${A.purl}/archive`, {});
  assert.equal((await A.c('GET', WJ(A, w.id))).status, 200);
  assert.equal((await A.c('POST', `${WJ(A, w.id)}/links`, { issue_keys: ['ABC-10'] })).status, 409);
  assert.equal((await A.c('POST', `${PJ(A)}/sync`, {})).status, 409);
  assert.equal((await A.c('PUT', `${PJ(A)}/mapping`, { external_project_key: 'ABC' })).status, 409);
  // 50. admin: operator only, no tokens / secrets / issue summaries
  await db.run(`UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?`, [B.uid]);
  assert.equal((await A.c('GET', '/api/admin/integrations')).status, 403);
  const r = await B.c('GET', '/api/admin/integrations'); assert.equal(r.status, 200);
  assert.equal(r.json.counts.active, 1); assert.equal(r.json.connections[0].site_url, 'https://example.atlassian.net'); assert.equal(r.json.mappings[0].external_project_key, 'ABC');
  const txt = JSON.stringify(r.json); assert.ok(!/acc-\d|ref-\d|token|secret|v1\./.test(txt), txt.slice(0, 200)); assert.ok(!txt.includes('"s"'));
  server.close();
});
