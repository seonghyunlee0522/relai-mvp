/* B9 / SHL-14 — /terms, /privacy, business footer, signup consent (password + Google). Fake Google + fake e-mail (no network). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './api-helpers.js';
import { setEmailProvider } from '../email/service.js';
import { fakeEmailProvider } from '../email/provider.js';
import { setGoogleProvider, fakeGoogleProvider } from '../auth/google.js';
import { LEGAL, koDate } from '../../public/app/shared/legal-info.js';
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
    assert.match(terms, /이용약관/); assert.match(terms, new RegExp(`${koDate(LEGAL.termsEffectiveDate)}부터 시행`)); assert.match(terms, new RegExp(`버전 ${LEGAL.termsVersion}`));
    // pricing v3 (founder spec 2026-10-20, VAT 포함): the terms table carries exactly the founder's numbers
    for (const s of ['월 30,000원', '월 80,000원', '포함(최초 1회 제공)', '포함(매월 제공)', 'AI 이용량', '부가가치세 10%를 포함', '월간 정기결제로만 제공']) assert.ok(terms.includes(s), `terms lacks ${s}`);
    // founder 2026-10-28: 월간 결제만 — no 연간 prices, no 추가 이용 (add-ons) in the terms
    assert.doesNotMatch(terms, /연 288,000원|연 768,000원|제7조의2|추가 사용자 1명|연간 정기결제는 갱신일/);
    // legal-review §10: no v2 wording (VAT 별도, Team 20,000 + 5,000/인, Free 2 projects / 500 credits, 정상가 + 위약금 10%)
    assert.doesNotMatch(terms, /얼리 액세스|12개월 동안 요금 없이|부가가치세 별도|20,000원|5,000원|진행 중 프로젝트 2개|500 크레딧|위약금\(잔여 금액의 10%\)/);
    for (const id of ['billing', 'ai-usage', 'recurring', 'refund']) assert.match(terms, new RegExp(`id="${id}"`));   // anchors the pricing note / checkout link to
    assert.match(terms, /간주동의|제4항은 이용요금의 증액/); assert.match(terms, /종전 금액으로 결제하거나 정기결제를 해지/); assert.match(terms, /다음 중 하나라도 이용한 경우에는[^]*청약철회가 제한/); assert.match(terms, /프로젝트 생성/); assert.match(terms, /조회, 내보내기\(다운로드\)와 설정 화면 이용은 이용 이력으로 보지 않습니다/); assert.doesNotMatch(terms, /즉시 종료: 해지일에/);   // founder 2026-10-28
    // founder decisions 2026-10-20: no one-time passes, prorated refunds with no deduction, purchased credits refundable in full, 30-day export after cancel
    assert.match(terms, /이용권은 판매하지 않습니다/); assert.doesNotMatch(terms, /정기결제 준비 중/); assert.doesNotMatch(terms, /이용권 결제|10%를 공제|잔여 금액의 10%|월간 정상가로 다시 계산하여/);
    assert.match(terms, /이미 결제한 이용기간에 대해서는 일할 환불하지 않습니다/); assert.match(terms, /결제 금액 전액을 환불/);
    // 2026-10-27: AI credits retired → AI 이용량 (no amount, failed runs counted, no carry-over, no top-up)
    assert.match(terms, /요청이 실패하더라도 AI 처리가 이미 이루어진 경우에는 사용한 처리량이 반영/); assert.match(terms, /남은 이용량은 다음 달로 이월되거나 환불되지 않습니다/);
    assert.match(terms, /별도로 구매하거나 충전할 수 없습니다/); assert.doesNotMatch(terms, /1 크레딧은|크레딧 충전은|유상 크레딧:|기본 크레딧\(/);
    assert.match(terms, /자동 갱신은 즉시 중단/); assert.match(terms, /해지나 전환만으로 프로젝트 데이터는 삭제되지 않습니다/); assert.match(terms, /생성일이 가장 최근인 활성 프로젝트부터/); assert.match(terms, /고객이 수정할 프로젝트를 고르지 않습니다/); assert.match(terms, /법정 청약철회권\(제12조\)을 먼저 적용/);
    const privacy = (await c('GET', '/privacy', undefined, { raw: true })).buf.toString('utf8');
    for (const v of ['Vercel Inc.', '나이스페이먼츠', 'Resend', 'Neon', 'Anthropic', 'Google LLC', `개인정보 보호책임자: ${LEGAL.privacyOfficer.name}`, '결제·정기결제 동의 기록', '이메일 주소의 해시값', '부분 취소']) assert.ok(privacy.includes(v), v);
    // landing #pricing is rendered from the server catalogue (no price typed in index.html)
    const home = (await c('GET', '/', undefined, { raw: true })).buf.toString('utf8');
    // 월간 결제만 (founder 2026-10-28): monthly prices only — no 연간 price, no add-on rows, no cycle switch; Pro/Team → 결제하기
    for (const s of ['30,000원', '80,000원', '별도 견적', 'data-cycle="MONTHLY"', '도입 문의', '결제하기']) assert.ok(home.includes(s), `landing lacks ${s}`);
    for (const s of ['연 288,000원', '연간 결제', '추가 사용자 1명', 'data-cycle-set']) assert.ok(!(home.split('id="pricing"')[1] || '').split('</section>')[0].includes(s), `landing still shows ${s}`);
    assert.doesNotMatch(home, /<!--PRICING:landing-->/);
    const p = await c('GET', '/pricing'); assert.equal(p.status, 302); assert.equal(p.location, '/#pricing');
    const sp = await c('GET', '/pay/agent', undefined, { raw: true }); assert.equal(sp.status, 200); assert.match(sp.buf.toString('utf8'), /서비스 결제/);   // 서비스 결제 page moved to /pay/agent (founder 2026-10-20), kept closed
  } finally { server.close(); }
});

test('renderDoc: headings, nested lists, tables, links are escaped', () => {
  const h = renderDoc('## 제1조 <x>\n1. a [b](/terms)\n   - c\n\n| h1 | h2 |\n|---|---|\n| **d** | e |\n\npara');
  assert.match(h, /<h2 id="s1">제1조 &lt;x&gt;<\/h2>/); assert.match(h, /<ol><li>a <a href="\/terms">b<\/a><ul><li>c<\/li><\/ul><\/li><\/ol>/);
  assert.match(h, /<th>h1<\/th>/); assert.match(h, /<td><b>d<\/b><\/td>/); assert.match(h, /<p>para<\/p>/);
  assert.match(renderDoc('## A {#refund}\n## B'), /<h2 id="refund">A<\/h2>\n<h2 id="s2">B<\/h2>/);
});
