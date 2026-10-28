/* Strict nonce CSP (server/csp.js) on server-rendered HTML; JSON responses carry none. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { addNonce, cspPolicy } from '../csp.js';

test('CSP: every HTML page gets a fresh nonce on every <script>; policy blocks injected scripts, plugins, <base> and framing', async () => {
  const saved = process.env.GA4_MEASUREMENT_ID;
  process.env.GA4_MEASUREMENT_ID = 'G-TEST1234';
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const nonces = new Set();
    for (const path of ['/', '/login', '/signup', '/terms', '/privacy', '/app', '/pay/agent']) {
      const r = await fetch(base + path, { redirect: 'manual' });
      const text = await r.text();
      if (r.status !== 200 || !/<script\b/i.test(text)) continue;
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp, `${path} has CSP`);
      const nonce = /'nonce-([^']+)'/.exec(csp)[1];
      nonces.add(nonce);
      assert.match(csp, /'strict-dynamic'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'self'/); assert.match(csp, /frame-ancestors 'none'/);
      const tags = text.match(/<script\b[^>]*>/gi);
      for (const t of tags) assert.ok(t.includes(`nonce="${nonce}"`), `${path}: ${t} lacks the nonce`);
      if (path.startsWith('/pay/')) assert.match(csp, /'unsafe-eval'/); else assert.doesNotMatch(csp, /'unsafe-eval'/);
    }
    assert.ok(nonces.size >= 3, 'nonce differs per response');
    const api = await fetch(base + '/api/auth/me');
    assert.equal(api.headers.get('content-security-policy'), null);
  } finally {
    if (saved === undefined) delete process.env.GA4_MEASUREMENT_ID; else process.env.GA4_MEASUREMENT_ID = saved;
    server.close();
  }
});

test('CSP helpers: nonce added once, closing tags untouched', () => {
  const out = addNonce('<script src="/a.js"></script><script nonce="x">1</script><SCRIPT>2</SCRIPT>', 'N');
  assert.equal(out, '<script nonce="N" src="/a.js"></script><script nonce="x">1</script><script nonce="N">2</SCRIPT>');
  assert.match(cspPolicy('N'), /^script-src 'nonce-N' 'strict-dynamic' https: 'unsafe-inline'/);
});
