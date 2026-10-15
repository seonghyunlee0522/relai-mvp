/* GA4 (server/ga4.js): gtag only on public logged-out pages when GA4_MEASUREMENT_ID is set; never on /app, /admin, token pages, or when unset. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';

const html = async (base, path, cookie = '') => { const r = await fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} }); return { status: r.status, text: await r.text() }; };
const GTAG = /googletagmanager\.com\/gtag\/js\?id=G-TEST1234/;

test('GA4: tag on landing/login/signup/terms/privacy with the env set; absent on /app, /admin, token pages and with the env unset', async () => {
  const saved = process.env.GA4_MEASUREMENT_ID;
  const { server } = await boot();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    process.env.GA4_MEASUREMENT_ID = 'G-TEST1234';
    for (const path of ['/', '/signup', '/login', '/terms', '/privacy', '/?utm_source=x']) {
      const r = await html(base, path);
      assert.equal(r.status, 200, path);
      assert.match(r.text, GTAG, `${path} has GA4`);
      assert.match(r.text, /anonymize_ip:true/);
      assert.match(r.text, /send_page_view:true/);
      const tag = r.text.slice(r.text.indexOf('<script async src="https://www.googletagmanager.com/gtag/js?id=G-'), r.text.indexOf('})();</script>') + 14);
      assert.doesNotMatch(tag, /user_id|email|@/, `${path} GA4 snippet sends no user id / e-mail`);
    }
    for (const path of ['/app', '/app/projects', '/admin', '/admin/funnel', '/invite/tok_SECRET123', '/signup?invite=tok_SECRET', '/login?next=%2Finvite%2Ftok', '/reset-password?token=abc', '/verify-email?token=abc', '/forgot-password']) {
      const r = await html(base, path);
      assert.doesNotMatch(r.text, /gtag\/js\?id=G-|window\.RELAI_GA4=/, `${path} must not carry GA4`);
    }
    // Signed in: no GA4 anywhere, the public pages included.
    const su = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agree_terms: true, agree_privacy: true, name: '가', email: 'ga4@x.com', password: 'passw0rd!' }) });
    assert.equal(su.status, 201);
    const cookie = su.headers.get('set-cookie').split(';')[0];
    for (const path of ['/', '/terms', '/privacy', '/app', '/app/projects']) assert.doesNotMatch((await html(base, path, cookie)).text, /gtag\/js\?id=G-|window\.RELAI_GA4=/, `${path} signed in`);
    process.env.GA4_MEASUREMENT_ID = 'not-an-id';
    assert.doesNotMatch((await html(base, '/')).text, /gtag\/js\?id=G-|window\.RELAI_GA4=/, 'invalid id = off');
    delete process.env.GA4_MEASUREMENT_ID;
    for (const path of ['/', '/signup', '/login', '/terms', '/privacy']) assert.doesNotMatch((await html(base, path)).text, /gtag\/js\?id=G-|window\.RELAI_GA4=/, `${path} unset = off`);
  } finally {
    if (saved === undefined) delete process.env.GA4_MEASUREMENT_ID; else process.env.GA4_MEASUREMENT_ID = saved;
    server.close();
  }
});

test('GA4: privacy policy names Google Analytics, purpose, items, retention and opt-out', async () => {
  const { privacyMarkdown } = await import('../legal.js');
  const p = privacyMarkdown();
  for (const v of ['Google 애널리틱스', '유입 분석', '방문 페이지, 유입 경로, 기기·브라우저 정보', '데이터 보관 기간 설정', 'tools.google.com/dlpage/gaoptout', 'Google LLC']) assert.ok(p.includes(v), v);
});
