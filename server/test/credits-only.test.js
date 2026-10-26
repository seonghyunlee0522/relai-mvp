/* NicePay 카드사 심사 모드 (CREDITS_ONLY_MODE, NicePay 2026-10-26): the site sells AI credits only, as one-time card payments.
 *  - mode on: a FREE workspace may top up (checkout 201), the summary and /api/me say credits_only, the landing #pricing shows
 *    credit packs and none of the 정기결제 wording (Pro · Team, 활성 프로젝트, 기본 사용자, 월간 · 연간), plan-limit messages name no plan
 *  - mode off: nothing changes (FREE checkout 402 AI_TOPUP_PLAN_REQUIRED, plan cards on the landing)
 * Fake billing and fake AI only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers.js';
import { createApp } from '../app.js';
import { createFakeProvider } from '../billing/provider.js';
import { resetBillingCache } from '../billing-admin.js';
import { PlanLimitError } from '../billing/limits.js';

process.env.PAYMENTS_ENABLED = 'true';
process.env.AI_PROVIDER = 'fake'; process.env.AI_ENABLED = 'true'; process.env.AI_MODEL = '';

async function boot(on) {
  if (on) process.env.CREDITS_ONLY_MODE = 'true'; else delete process.env.CREDITS_ONLY_MODE;
  const db = await testDb(); resetBillingCache();
  const server = createApp(db, { billingProvider: createFakeProvider() }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const c = async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };
  const s = await c('POST', '/api/auth/signup', { agree_terms: true, agree_privacy: true, name: '김심사', email: `review${Date.now()}@relai.kr`, password: 'passw0rd!' });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  await db.run('UPDATE users SET email_verified_at = now()');
  return { db, c, w: s.json.workspaces[0].id, done: () => { server.close(); delete process.env.CREDITS_ONLY_MODE; } };
}
const pricingSection = (html) => html.slice(html.indexOf('id="pricing"'), html.indexOf('<!-- CLOSING -->'));

test('credits-only mode: Free tops up, flags reach the app, landing sells credit packs only', async () => {
  const env = await boot(true);
  try {
    const me = await env.c('GET', '/api/me');
    assert.equal(me.json.features.credits_only, true);
    const sum = (await env.c('GET', `/api/workspaces/${env.w}/credits/summary`)).json.credits;
    assert.equal(sum.plan, 'FREE'); assert.equal(sum.credits_only, true); assert.equal(sum.topup.allowed, true);
    const co = await env.c('POST', `/api/workspaces/${env.w}/credits/checkout`, { amount: 10000 });
    assert.equal(co.status, 201, JSON.stringify(co.json));
    assert.equal(co.json.order.amount, 10000); assert.equal(co.json.order.credits, 1000);

    const land = await env.c('GET', '/');
    const sec = pricingSection(land.text);
    assert.match(sec, /id="credit-packs"/);
    for (const amount of ['10,000원', '30,000원', '100,000원']) assert.ok(sec.includes(amount), amount);
    assert.equal((sec.match(/data-credit-pack=/g) || []).length, 3);
    assert.match(sec, /href="\/login\?next=%2Fapp%2Fsettings%2Fcredits"/);
    for (const w of ['Pro', 'Team', '활성 프로젝트', '기본 사용자', '연간', '정기결제', '구독', 'sample', 'test', '샘플', '테스트']) assert.ok(!sec.includes(w), `pricing section must not say ${w}`);
    assert.ok(!/<p class="hero__mnote"><span>무료 플랜/.test(land.text), 'hero note');
    assert.ok(!sec.includes('무료 플랜'), 'no plan promo in #pricing');
    assert.ok(!land.text.includes('<!--CO:'), 'markers replaced');

    const msg = new PlanLimitError({ dimension: 'projects', used: 1, limit: 1, plan: 'FREE' }).message;
    assert.ok(!/플랜|업그레이드|Pro|Team/.test(msg), msg);
  } finally { env.done(); }
});

test('credits-only mode off: unchanged (Free cannot top up, plan cards on the landing)', async () => {
  const env = await boot(false);
  try {
    assert.equal((await env.c('GET', '/api/me')).json.features.credits_only, false);
    const co = await env.c('POST', `/api/workspaces/${env.w}/credits/checkout`, { amount: 10000 });
    assert.equal(co.status, 402); assert.equal(co.json.error.code, 'AI_TOPUP_PLAN_REQUIRED');
    const land = await env.c('GET', '/');
    assert.ok(!pricingSection(land.text).includes('id="credit-packs"'));
    assert.match(pricingSection(land.text), /Pro · Team/);
    assert.match(new PlanLimitError({ dimension: 'projects', used: 1, limit: 1, plan: 'FREE' }).message, /Free 플랜/);
  } finally { env.done(); }
});
