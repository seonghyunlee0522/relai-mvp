/* B9 / SHL-14 — /terms, /privacy, business footer, signup consent (password + Google). Fake Google + fake e-mail (no network). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { setGoogleProvider, fakeGoogleProvider } from '../auth/google.js';
import { LEGAL } from '../../public/app/shared/legal-info.js';
import { renderDoc } from '../legal.js';

process.env.APP_BASE_URL = 'https://relai.test'; process.env.EMAIL_PROVIDER = 'fake'; process.env.GOOGLE_PROVIDER = 'fake';
setEmailProvider(fakeEmailProvider());
const google = fakeGoogleProvider(); setGoogleProvider(google);

async function googleFlow(c, claims, query) {
  const start = await c('GET', `/api/auth/google/start?${query}`);
  const url = new URL(start.location, 'http://localhost');
  const code = google.issueCode({ email_verified: true, name: 'G User', ...claims, nonce: url.searchParams.get('nonce') });
  return (await c('GET', `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state'))}`)).location;
}

test('signup: both consents required (422, nothing created); consent time + version stored', async () => {
  const { server, client, db } = await boot();
  try {
    const body = { name: '홍길동', email: 'c@x.com', password: 'passw0rd!' };
    let r = await client()('POST', '/api/auth/signup', body);
    assert.equal(r.status, 422); assert.equal(r.json.error.code, 'consent_required');
    assert.ok(r.json.error.fields.agree_terms && r.json.error.fields.agree_privacy);
    r = await client()('POST', '/api/auth/signup', { ...body, agree_terms: true });
    assert.equal(r.status, 422); assert.deepEqual(Object.keys(r.json.error.fields), ['agree_privacy']);
    r = await client()('POST', '/api/auth/signup', { ...body, agree_terms: true, agree_privacy: false });
    assert.equal(r.status, 422);
    assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'c@x.com'`)).n), 0);
    r = await client()('POST', '/api/auth/signup', { ...body, agree_terms: 'true', agree_privacy: 'true', terms_version: 'forged' });
    assert.equal(r.status, 201);
    const u = await db.get(`SELECT terms_agreed_at, terms_version, privacy_agreed_at, privacy_version FROM users WHERE email = 'c@x.com'`);
    assert.ok(u.terms_agreed_at && u.privacy_agreed_at);
    assert.equal(u.terms_version, LEGAL.termsVersion); assert.equal(u.privacy_version, LEGAL.privacyVersion);
  } finally { server.close(); }
});

test('Google: a new account needs consent=1 from the signup page; existing accounts sign in without it', async () => {
  const { server, client, db } = await boot();
  try {
    let loc = await googleFlow(client(), { sub: 'g-1', email: 'new@corp.com' }, 'intent=login');
    assert.equal(loc, '/signup?error=consent_required');
    assert.equal(Number((await db.get(`SELECT COUNT(*) n FROM users WHERE email = 'new@corp.com'`)).n), 0);
    loc = await googleFlow(client(), { sub: 'g-1', email: 'new@corp.com' }, 'intent=signup&consent=1');
    assert.equal(loc, '/app');
    const u = await db.get(`SELECT terms_version, privacy_version, terms_agreed_at FROM users WHERE email = 'new@corp.com'`);
    assert.equal(u.terms_version, LEGAL.termsVersion); assert.equal(u.privacy_version, LEGAL.privacyVersion); assert.ok(u.terms_agreed_at);
    loc = await googleFlow(client(), { sub: 'g-1', email: 'new@corp.com' }, 'intent=login');   // returning user: no consent prompt
    assert.equal(loc, '/app');
  } finally { server.close(); }
});

test('public legal pages: /terms /privacy /pricing and the landing footer, no draft markers, no birth date', async () => {
  const { server, client } = await boot();
  try {
    const c = client();
    for (const path of ['/terms', '/privacy', '/']) {
      const r = await c('GET', path, undefined, { raw: true }); assert.equal(r.status, 200, path);
      const h = r.buf.toString('utf8');
      for (const s of ['상호', LEGAL.company, LEGAL.ceo, LEGAL.bizNo, LEGAL.address, '통신판매업 신고번호', LEGAL.mailOrderNo, '/terms', '/privacy']) assert.ok(h.includes(s), `${path} lacks ${s}`);
      assert.ok(!/\{\{|법률 검토|검토자 메모|LEGAL_FOOTER|__CONTACT_EMAIL__/.test(h), `${path} has a draft marker`);
      assert.ok(!/생년월일[^·]*\d{4}|19\d\d[.-]\d\d[.-]\d\d/.test(h.replace(/생년월일\(또는 사업자등록번호\)|생년월일 6자리/g, '')), `${path} shows a birth date`);
    }
    const terms = (await c('GET', '/terms', undefined, { raw: true })).buf.toString('utf8');
    assert.match(terms, /이용약관/); assert.match(terms, /20,000원/); assert.match(terms, /2026년 10월 20일부터 시행/); assert.match(terms, /버전 2026-10-20/);
    // b7-fix P0-1: early access retired — no 12-month / unlimited promise; the Free plan (2 projects, 500 credits once) is described
    assert.doesNotMatch(terms, /얼리 액세스|12개월 동안 요금 없이|Team 요금제와 같은 한도/);
    assert.match(terms, /무료 플랜\(Free 요금제\)/); assert.match(terms, /진행 중 프로젝트 2개/); assert.match(terms, /무료 크레딧 500 크레딧을 한 번 지급/);
    const privacy = (await c('GET', '/privacy', undefined, { raw: true })).buf.toString('utf8');
    for (const v of ['Vercel Inc.', '나이스페이먼츠', 'Resend', 'Neon', 'Anthropic', 'Google LLC', `개인정보 보호책임자: ${LEGAL.privacyOfficer.name}`]) assert.ok(privacy.includes(v), v);
    const p = await c('GET', '/pricing'); assert.equal(p.status, 302); assert.equal(p.location, '/#pricing');
    const sp = await c('GET', '/pay/agent', undefined, { raw: true }); assert.equal(sp.status, 200); assert.match(sp.buf.toString('utf8'), /서비스 결제/);   // 서비스 결제 page moved to /pay/agent (founder 2026-10-20), kept closed
  } finally { server.close(); }
});

test('renderDoc: headings, nested lists, tables, links are escaped', () => {
  const h = renderDoc('## 제1조 <x>\n1. a [b](/terms)\n   - c\n\n| h1 | h2 |\n|---|---|\n| **d** | e |\n\npara');
  assert.match(h, /<h2 id="s1">제1조 &lt;x&gt;<\/h2>/); assert.match(h, /<ol><li>a <a href="\/terms">b<\/a><ul><li>c<\/li><\/ul><\/li><\/ol>/);
  assert.match(h, /<th>h1<\/th>/); assert.match(h, /<td><b>d<\/b><\/td>/); assert.match(h, /<p>para<\/p>/);
});
