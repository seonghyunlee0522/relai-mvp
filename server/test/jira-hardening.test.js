/* Phase 12 production hardening: webhook JWT verification via jose (HS256 + exp/nbf only), URL secret, encryption key validation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { boot, setup } from './api-helpers.js';
import { setProvider } from '../integrations/registry.js';
import { fakeJiraProvider } from '../integrations/jira/provider.js';
import { encryptionKey, assertEncryptionConfig, encrypt, decrypt, IntegrationConfigError, signJwt, verifyJwt } from '../integrations/crypto.js';

process.env.ATLASSIAN_CLIENT_ID = 'cid'; process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret'; process.env.ATLASSIAN_REDIRECT_URI = 'https://relai.test/api/integrations/jira/callback';
process.env.INTEGRATION_ENCRYPTION_KEY = 'b'.repeat(64); process.env.INTEGRATION_PROVIDER = 'live';
const SECRET = 'test-client-secret'; const key = new TextEncoder().encode(SECRET); const now = () => Math.floor(Date.now() / 1000);

async function connected() {
  const { server, client, db } = await boot(); const A = await setup(client); const fake = fakeJiraProvider(); setProvider(fake);
  const s = await A.c('POST', `/api/workspaces/${A.w}/integrations/jira/connect`, {});
  await A.c('GET', `/api/integrations/jira/callback?code=good-code&state=${encodeURIComponent(s.json.state)}`);
  await A.c('PUT', `${A.purl}/integrations/jira/mapping`, { external_project_key: 'ABC', leaf_issue_type_id: '1' });
  const w = (await A.c('POST', A.wbs, { title: 'W' })).json.item; fake.addIssue('ABC-10', { summary: 's', status: 'todo' });
  await A.c('POST', `${A.wbs}/${w.id}/jira/links`, { issue_keys: ['ABC-10'] });
  const c = await db.get(`SELECT id, webhook_secret FROM integration_connections WHERE workspace_id = ?`, [A.w]);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (auth, { secret = c.webhook_secret, body = { webhookEvent: 'jira:issue_updated', timestamp: Date.now(), issue: { key: 'ABC-10' } } } = {}) =>
    fetch(`${base}/api/integrations/jira/webhook/${c.id}/${secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { server, A, fake, c, post };
}

test('webhook JWT: valid HS256 accepted; invalid signature / expired / future nbf / malformed / wrong alg / URL secret mismatch rejected without leaking', async () => {
  const { server, fake, post } = await connected();
  const mk = (claims, k = key, alg = 'HS256') => new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT' }).sign(k);
  // valid (exp + nbf in range) → processed; the fake's status change shows the handler ran
  fake.setStatus('ABC-10', 'inprogress');
  let r = await post(`Bearer ${await mk({ iss: 'atlassian', iat: now(), nbf: now() - 5, exp: now() + 300 })}`); assert.equal(r.status, 200); assert.equal(r.json.result, 'updated');
  // claims we do not require (no exp at all) still pass — only signature/exp/nbf are enforced
  r = await post(`Bearer ${await mk({ iss: 'atlassian' })}`, { body: { webhookEvent: 'jira:issue_updated', timestamp: 2, issue: { key: 'ABC-10' } } }); assert.equal(r.status, 200);
  // invalid signature
  r = await post(`Bearer ${await mk({ exp: now() + 300 }, new TextEncoder().encode('other-secret'))}`); assert.equal(r.status, 401); assert.deepEqual(r.json, { error: 'unauthorized' });
  // expired (beyond 60 s tolerance)
  r = await post(`Bearer ${await mk({ exp: now() - 120 })}`); assert.equal(r.status, 401);
  // future nbf
  r = await post(`Bearer ${await mk({ nbf: now() + 600, exp: now() + 900 })}`); assert.equal(r.status, 401);
  // malformed / missing / wrong scheme / alg=none-ish
  for (const a of ['Bearer not.a.jwt', 'Bearer abc', '', 'Basic xyz', `Bearer ${(await mk({ exp: now() + 300 })).split('.').slice(0, 2).join('.')}.`]) { r = await post(a); assert.equal(r.status, 401, a); }
  r = await post(`Bearer ${await mk({ exp: now() + 300 }, key, 'HS384')}`); assert.equal(r.status, 401);   // only HS256 is accepted
  // URL secret mismatch → 404 (before any JWT work), unknown connection → 404
  r = await post(`Bearer ${await mk({ exp: now() + 300 })}`, { secret: 'wrong-secret' }); assert.equal(r.status, 404);
  // response bodies never echo the token or header
  const t = await mk({ exp: now() - 120 }); r = await post(`Bearer ${t}`); assert.ok(!JSON.stringify(r.json).includes(t.slice(0, 20)));
  server.close();
});

test('crypto helpers: signJwt/verifyJwt use jose semantics (HS256, exp, nbf, tolerance)', async () => {
  const t = await signJwt({ exp: now() + 30 }, 'k'); assert.ok(await verifyJwt(t, 'k'));
  assert.equal(await verifyJwt(t, 'k2'), null);
  assert.ok(await verifyJwt(await signJwt({ exp: now() - 30 }, 'k'), 'k'));          // inside 60 s tolerance
  assert.equal(await verifyJwt(await signJwt({ exp: now() - 120 }, 'k'), 'k'), null);
  assert.equal(await verifyJwt(await signJwt({ nbf: now() + 120 }, 'k'), 'k'), null);
  assert.equal(await verifyJwt('garbage', 'k'), null); assert.equal(await verifyJwt('', 'k'), null); assert.equal(await verifyJwt(t, ''), null);
});

test('encryption key: production accepts 64-hex / 32-byte base64 / base64url only; short, arbitrary, or missing keys rejected; dev fallback works', () => {
  const prod = (k) => ({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: k, SESSION_SECRET: 'sess' });
  const raw = Buffer.alloc(32, 7);
  // valid shapes
  assert.equal(encryptionKey(prod('c'.repeat(64))).length, 32);
  assert.equal(encryptionKey(prod(raw.toString('base64'))).length, 32);
  assert.equal(encryptionKey(prod(raw.toString('base64url'))).length, 32);
  assert.ok(assertEncryptionConfig(prod('C'.repeat(64))));
  const ct = encrypt('tok', prod('d'.repeat(64))); assert.equal(decrypt(ct, prod('d'.repeat(64))), 'tok');
  assert.throws(() => decrypt(ct, prod('e'.repeat(64))));   // different key cannot read it
  // rejected: short, arbitrary string (no SHA-256 derivation), 31/33-byte base64, missing in production
  for (const bad of ['short', 'my-secret-passphrase-that-is-not-a-key', 'f'.repeat(63), 'f'.repeat(65), Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), 'zz'.repeat(32)]) {
    assert.throws(() => encryptionKey(prod(bad)), (e) => e instanceof IntegrationConfigError && /64자리 hex|32바이트/.test(e.message), bad);
    assert.throws(() => assertEncryptionConfig(prod(bad)), IntegrationConfigError, bad);
  }
  assert.throws(() => encryptionKey(prod('')), (e) => e instanceof IntegrationConfigError && /설정되지 않았습니다/.test(e.message));
  assert.throws(() => encryptionKey({ NODE_ENV: 'production', SESSION_SECRET: 'sess' }), IntegrationConfigError);
  // malformed key is rejected outside production too (never silently derived)
  assert.throws(() => encryptionKey({ NODE_ENV: 'development', INTEGRATION_ENCRYPTION_KEY: 'short', SESSION_SECRET: 'sess' }), IntegrationConfigError);
  // dev/test fallback: no key → derived from SESSION_SECRET, stable and usable
  const dev = { NODE_ENV: 'development', SESSION_SECRET: 'local-dev-secret' };
  assert.equal(encryptionKey(dev).length, 32); assert.ok(assertEncryptionConfig(dev));
  assert.equal(decrypt(encrypt('tok', dev), dev), 'tok');
  assert.notEqual(encryptionKey(dev).toString('hex'), encryptionKey({ NODE_ENV: 'development', SESSION_SECRET: 'other' }).toString('hex'));
});
