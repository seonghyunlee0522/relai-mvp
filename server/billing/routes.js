/**
 * Billing API (Phase 10). Two mounts:
 *   mountBillingWebhook — POST /api/billing/webhook/:provider. Registered BEFORE the global JSON parser, CSRF/Origin check
 *     and auth so the raw body reaches signature verification (docs/production-readiness.md §6, §8). Own IP rate limiter.
 *   mountBillingRoutes  — workspace-scoped: GET …/billing (any member), POST …/billing/checkout|cancel (OWNER: POLICY.billing).
 */
import express from 'express';
import { rateLimiter } from '../security.js';
import { requireAction, can } from '../authz.js';
import { PLANS, USAGE_DIMS } from '../plans.js';
import { workspaceUsage } from '../usage.js';
import { BillingError } from './provider.js';
import { effectivePlan, getSubscription, processWebhookEvent, requestCancel } from './subscriptions.js';

const catalogue = () => Object.values(PLANS).map((p) => ({ key: p.key, label: p.label, price_monthly: p.price_monthly, limits: p.limits }));

export function mountBillingWebhook(app, db, { provider, fail }) {
  const limiter = rateLimiter({ max: 300, windowMs: 60 * 1000 });   // per source IP; never shared with the login/signup limiters
  app.post('/api/billing/webhook/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      if (!provider || req.params.provider !== provider.name) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
      if (limiter.blocked(req.ip)) return fail(res, 429, 'rate_limited', '요청이 너무 많습니다.');
      limiter.hit(req.ip);
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let ev;
      try { ev = await provider.handleWebhook({ rawBody, headers: req.headers }); }
      catch (e) { if (e instanceof BillingError) return fail(res, e.status, e.code, e.message); throw e; }
      const out = await processWebhookEvent(db, provider.name, ev);
      res.json({ received: true, ...out });
    } catch (e) { next(e); }
  });
}

export function mountBillingRoutes({ app, db, guard, wrap, fail, provider }) {
  const b = '/api/workspaces/:wid/billing';
  const owner = [...guard, requireAction('billing')];
  const unavailable = (res) => fail(res, 503, 'billing_unavailable', '결제 기능이 아직 준비되지 않았습니다. 운영자에게 문의해 주세요.');

  const summary = async (wid, role) => {
    const plan = await effectivePlan(db, wid);
    return { billing: { plan, plan_label: PLANS[plan].label, subscription: (await getSubscription(db, wid)) || null, usage: await workspaceUsage(db, wid, plan),
      plans: catalogue(), dims: USAGE_DIMS, provider_available: Boolean(provider), can_manage: can(role, 'billing') } };
  };
  app.get(b, guard, wrap(async (req, res) => res.json(await summary(req.params.wid, req.role))));

  app.post(`${b}/checkout`, owner, wrap(async (req, res) => {
    const plan = String(req.body?.plan || 'TEAM');
    if (plan !== 'TEAM') return fail(res, 400, 'validation_error', '입력값을 확인해 주세요.', { fields: { plan: '선택할 수 없는 플랜입니다.' } });
    if (!provider) return unavailable(res);
    if ((await effectivePlan(db, req.params.wid)) === plan) return fail(res, 409, 'already_subscribed', '이미 Team 플랜을 사용 중입니다.');
    const workspace = await db.get('SELECT id, name FROM workspaces WHERE id = ?', [req.params.wid]);
    const out = await provider.createCheckout({ workspace, plan, customer: { id: req.user.id, email: req.user.email, name: req.user.name },
      successUrl: '/app/settings', cancelUrl: '/app/settings' });
    res.status(201).json({ checkout_url: out.checkout_url, session_id: out.session_id, provider: provider.name });
  }));

  app.post(`${b}/cancel`, owner, wrap(async (req, res) => {
    if (!provider) return unavailable(res);
    const out = await requestCancel(db, provider, req.params.wid);
    if (out.error === 'no_active_subscription') return fail(res, 409, out.error, '해지할 구독이 없습니다.');
    if (out.error === 'already_canceled') return fail(res, 409, out.error, '이미 해지 예약된 구독입니다.');
    res.json(await summary(req.params.wid, req.role));
  }));
}
