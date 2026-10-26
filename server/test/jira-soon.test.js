/* Jira release gate (2026-10-26): with JIRA_INTEGRATION not 'on' the integration is '출시 예정' — the settings card says so, /api/me
 * reports features.jira=false, connect and every project / WBS / requirement Jira route answer 409 integration_coming_soon, and the
 * list / detail / home responses carry no Jira data. Setting the env to 'on' (Vercel: plus a redeploy) reopens it with no code change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, setup } from './api-helpers.js';

process.env.ATLASSIAN_CLIENT_ID = 'cid'; process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret'; process.env.ATLASSIAN_REDIRECT_URI = 'https://relai.test/api/integrations/jira/callback';
process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64);

test('Jira gate: JIRA_INTEGRATION off → 출시 예정 everywhere; on → available again', async () => {
  const { client } = await boot();
  const A = await setup(client);
  process.env.JIRA_INTEGRATION = 'off';
  try {
    let r = await A.c('GET', '/api/me'); assert.equal(r.json.features.jira, false);
    r = await A.c('GET', `/api/workspaces/${A.w}/integrations`); assert.equal(r.status, 200); assert.equal(r.json.providers[0].coming_soon, true);
    r = await A.c('POST', `/api/workspaces/${A.w}/integrations/jira/connect`, {}); assert.equal(r.status, 409); assert.equal(r.json.error.code, 'integration_coming_soon');
    const req = (await A.c('POST', A.req, { title: '로그인', scope: 'IN_SCOPE' })).json.requirement;
    const wbs = (await A.c('POST', A.wbs, { title: '로그인 화면' })).json.item;
    for (const [m, p] of [['GET', `${A.purl}/integrations/jira`], ['PUT', `${A.purl}/integrations/jira/mapping`], ['POST', `${A.purl}/integrations/jira/sync`],
      ['GET', `${A.req}/${req.id}/jira`], ['POST', `${A.req}/${req.id}/jira/issues`], ['POST', `${A.req}/jira/bulk-create`], ['GET', `${A.wbs}/${wbs.id}/jira`], ['POST', `${A.wbs}/${wbs.id}/jira/links`]]) {
      r = await A.c(m, p, m === 'GET' ? undefined : {}); assert.equal(r.status, 409, `${m} ${p}`); assert.equal(r.json.error.code, 'integration_coming_soon');
    }
    assert.equal((await A.c('GET', A.req)).json.jira, null);
    assert.equal((await A.c('GET', A.wbs)).json.jira, null);
    assert.equal((await A.c('GET', A.purl)).json.jira, null);
    assert.equal((await A.c('GET', `${A.req}/${req.id}`)).json.requirement.jira.total, 0);
    process.env.JIRA_INTEGRATION = 'on';
    r = await A.c('GET', '/api/me'); assert.equal(r.json.features.jira, true);
    r = await A.c('GET', `/api/workspaces/${A.w}/integrations`); assert.equal(r.json.providers[0].coming_soon, false);
    assert.equal((await A.c('GET', `${A.req}/${req.id}/jira`)).status, 200);
  } finally { process.env.JIRA_INTEGRATION = 'on'; }
});
