/**
 * Phase 14 routes
 *   GET  /api/workspaces/:wid/onboarding                 one call: audience, welcome, tour (+steps config), checklist, guides seen
 *   POST /api/workspaces/:wid/onboarding/:key/:action    action = start | step | complete | skip | replay  (body { step })
 *   POST /api/guides/:guideKey/seen                     one-time coach mark dismissed
 *   POST /api/guides/reset                              "가이드 다시 보기" → coach marks show once more
 *   GET  /api/workspaces/:wid/activation                 OWNER/ADMIN: activation state of their own workspace
 */
import { POLICY } from './authz.js';
import * as O from './onboarding.js';
import { emailConfig } from './email/config.js';

export function mountOnboardingRoutes({ app, db, guard, requireAuth, wrap, fail }) {
  const send = (res, fn) => fn().catch((e) => { if (e instanceof O.OnboardingError) return fail(res, e.status, e.code, e.message); throw e; });
  const perms = (role) => Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, v.includes(role)]));
  app.get('/api/workspaces/:wid/onboarding', guard, wrap(async (req, res) => send(res, async () => {
    res.json({ ...(await O.onboardingSummary(db, { user: req.user, workspaceId: req.params.wid, role: req.role, permissions: perms(req.role) })), support_email: emailConfig().supportEmail || null });
  })));
  app.post('/api/workspaces/:wid/onboarding/:key/:action(start|step|complete|skip|replay)', guard, wrap(async (req, res) => send(res, async () => {
    const r = await O.updateOnboarding(db, { user: req.user, workspaceId: req.params.wid, key: String(req.params.key).toUpperCase(), action: req.params.action, step: req.body?.step ? String(req.body.step).slice(0, 60) : null });
    res.json({ [String(req.params.key).toLowerCase()]: r });
  })));
  app.post('/api/guides/reset', requireAuth, wrap(async (req, res) => res.json({ guides_seen: await O.resetGuides(db, req.user.id) })));
  app.post('/api/guides/:guideKey/seen', requireAuth, wrap(async (req, res) => send(res, async () => res.json({ guides_seen: await O.markGuideSeen(db, req.user.id, String(req.params.guideKey).toUpperCase()) }))));
  app.get('/api/workspaces/:wid/activation', guard, wrap(async (req, res) => {
    if (!['OWNER', 'ADMIN'].includes(req.role)) return fail(res, 403, 'forbidden', 'Workspace OWNER/ADMIN만 볼 수 있습니다.');
    res.json({ activation: await O.workspaceActivation(db, req.params.wid) });
  }));
}
