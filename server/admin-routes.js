/**
 * /api/admin/* — service-operator API. Every route runs requireAuth → requireSystemAdmin (403 for any non-operator,
 * including workspace OWNERs). Entirely separate from the /api/workspaces/* guard chain: being SYSTEM_ADMIN never
 * grants workspace membership and workspace roles never grant operator access.
 */
import * as A from './admin.js';
import { USAGE_SORTS, allWorkspacesUsage } from './usage.js';
import { PLANS } from './plans.js';
import { billingStatus, listSubscriptions, getSubscription, listPayments, getPayment } from './billing-admin.js';
import { aiUsageOverview, workspaceAiUsage, grantCredits } from './ai/admin.js';
import { adminIntegrations } from './integrations/routes.js';

export const isSystemAdmin = (user) => Boolean(user && user.system_role === 'SYSTEM_ADMIN');

export function mountAdminRoutes(app, db, { requireAuth, wrap, fail }) {
  /** 401 when not logged in (requireAuth runs first), 403 for everyone whose users.system_role is not SYSTEM_ADMIN. */
  const requireSystemAdmin = (req, res, next) => (isSystemAdmin(req.user) ? next() : fail(res, 403, 'forbidden', '운영자 권한이 필요합니다.'));
  const guard = [requireAuth, requireSystemAdmin];
  const admin = (req) => ({ id: req.user.id });
  const action = (fn) => wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { if (e instanceof A.AdminError) return fail(res, e.status, e.code, e.message); throw e; }
  });

  app.get('/api/admin/dashboard', guard, wrap(async (req, res) => res.json(await A.dashboard(db))));

  app.get('/api/admin/users', guard, wrap(async (req, res) => res.json(await A.listUsers(db, req.query))));
  app.get('/api/admin/users/:id', guard, wrap(async (req, res) => { const d = await A.getUser(db, req.params.id); return d ? res.json(d) : fail(res, 404, 'not_found', '사용자를 찾을 수 없습니다.'); }));
  app.post('/api/admin/users/:id/suspend', guard, action((req) => A.suspendUser(db, admin(req), req.params.id, req.body)));
  app.post('/api/admin/users/:id/reactivate', guard, action((req) => A.reactivateUser(db, admin(req), req.params.id, req.body)));

  app.get('/api/admin/workspaces', guard, wrap(async (req, res) => res.json(await A.listWorkspaces(db, req.query))));
  app.get('/api/admin/workspaces/:id', guard, wrap(async (req, res) => { const d = await A.getWorkspace(db, req.params.id); return d ? res.json(d) : fail(res, 404, 'not_found', 'Workspace를 찾을 수 없습니다.'); }));
  app.post('/api/admin/workspaces/:id/suspend', guard, action((req) => A.suspendWorkspace(db, admin(req), req.params.id, req.body)));
  app.post('/api/admin/workspaces/:id/reactivate', guard, action((req) => A.reactivateWorkspace(db, admin(req), req.params.id, req.body)));

  app.get('/api/admin/usage', guard, wrap(async (req, res) => {
    const { page, size } = A.paging(req.query);
    const sort = USAGE_SORTS.includes(req.query.sort) ? req.query.sort : 'projects';
    res.json({ ...(await allWorkspacesUsage(db, { sort, page, size, q: String(req.query.q || '').trim() })), page, size, sort, plans: PLANS });
  }));

  app.get('/api/admin/billing', guard, wrap(async (req, res) => res.json({ billing: await billingStatus(db), plans: PLANS })));
  app.get('/api/admin/subscriptions', guard, wrap(async (req, res) => { const { page, size } = A.paging(req.query); res.json({ ...(await listSubscriptions(db, { q: String(req.query.q || '').trim(), plan: req.query.plan, status: req.query.status, page, size })), page, size }); }));
  app.get('/api/admin/subscriptions/:id', guard, wrap(async (req, res) => { const d = await getSubscription(db, req.params.id); return d ? res.json(d) : fail(res, 404, 'not_found', 'Subscription을 찾을 수 없습니다.'); }));
  app.get('/api/admin/payments', guard, wrap(async (req, res) => { const { page, size } = A.paging(req.query); res.json({ ...(await listPayments(db, { q: String(req.query.q || '').trim(), status: req.query.status, provider: req.query.provider, from: req.query.from, to: req.query.to, page, size })), page, size }); }));
  app.get('/api/admin/payments/:id', guard, wrap(async (req, res) => { const d = await getPayment(db, req.params.id); return d ? res.json({ payment: d }) : fail(res, 404, 'not_found', 'Payment를 찾을 수 없습니다.'); }));

  /* AI usage + credits (Phase 11). Aggregates only — never project content. */
  app.get('/api/admin/ai/usage', guard, wrap(async (req, res) => res.json(await aiUsageOverview(db))));
  app.get('/api/admin/workspaces/:id/ai', guard, wrap(async (req, res) => { const d = await workspaceAiUsage(db, req.params.id); return d ? res.json(d) : fail(res, 404, 'not_found', 'Workspace를 찾을 수 없습니다.'); }));
  app.post('/api/admin/workspaces/:id/ai/credits', guard, action((req) => grantCredits(db, admin(req), req.params.id, req.body)));

  /* Integrations (Phase 12): connection health + sync failures only; never credentials or issue content. */
  app.get('/api/admin/integrations', guard, wrap(async (req, res) => res.json(await adminIntegrations(db))));

  app.get('/api/admin/audit', guard, wrap(async (req, res) => res.json(await A.listAudit(db, req.query))));

  // Any other /api/admin/* path: still 401/403 before 404 so the admin surface cannot be mapped by outsiders.
  app.all('/api/admin/*', guard, (req, res) => fail(res, 404, 'not_found', '찾을 수 없습니다.'));
}
