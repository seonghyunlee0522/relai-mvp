/**
 * Phase 13 routes: Google sign-in, invitation landing/accept, workspace member invitations, admin platform invitations.
 *   GET  /api/auth/providers                         { google: { enabled } }
 *   GET  /api/auth/google/start?intent=&invite=&next=   → 302 Google consent (rate-limited per IP)
 *   GET  /api/auth/google/callback?code&state        → RELAI session + 302 return path
 *   GET  /api/invitations/:token                     public landing model (masked e-mail)
 *   POST /api/invitations/:token/accept              requireAuth; e-mail must match; explicit acceptance
 *   GET/POST /api/workspaces/:wid/invitations, POST …/:id/resend, DELETE …/:id   (member_manage; ADMIN → MEMBER only)
 *   GET/POST /api/admin/invitations, POST …/:id/resend, …/:id/revoke, GET /api/admin/email-deliveries   (SYSTEM_ADMIN)
 */
import { tx } from '../db.js';
import { ValidationError } from '../validate.js';
import { rateLimiter, sha256 } from '../security.js';
import { requireAction } from '../authz.js';
import * as I from '../invitations.js';
import { startGoogleAuth, finishGoogleAuth, googleConfig, getGoogleProvider, GoogleAuthError } from './google.js';
import { listDeliveries, getEmailProvider } from '../email/service.js';

export function mountAuthRoutes({ app, db, guard, wrap, fail, requireAuth, startSession, afterLogin }) {
  const googleStartLimit = rateLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
  const inviteLookupLimit = rateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
  const memberInviteLimit = rateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });       // per workspace
  const inviteEmailLimit = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });         // per target e-mail (all kinds)
  const platformInviteLimit = rateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });     // per admin
  const resendLimit = rateLimiter({ max: 3, windowMs: 10 * 60 * 1000 });              // per invitation
  const send = (res, fn) => fn().catch((e) => {
    if (e instanceof I.InviteError) return fail(res, e.status, e.code, e.message, e.extra);
    if (e instanceof GoogleAuthError) return fail(res, e.status, e.code, e.message);
    throw e;
  });
  void ValidationError; void startSession;
  const safeNext = (n) => (typeof n === 'string' && /^\/(app|invite|admin)(\/|\?|$)/.test(n) && !n.startsWith('//') ? n.slice(0, 500) : '/app');

  // Dev/E2E only: with the fake e-mail provider (never in production) the in-memory outbox is readable so Playwright can follow
  // invite links. The live provider has no outbox; a production process never mounts this route.
  if (process.env.NODE_ENV !== 'production' && (process.env.EMAIL_PROVIDER || 'fake') === 'fake') {
    app.get('/api/_dev/email-outbox', (req, res) => { const p = getEmailProvider(); if (p.name !== 'fake') return fail(res, 404, 'not_found', 'not available'); res.json({ messages: p.outbox.slice(-50).map((m) => ({ id: m.id, to: m.to, subject: m.subject, text: m.text, at: m.at })) }); });
  }
  if (process.env.NODE_ENV !== 'production' && googleConfig().provider === 'fake') {
    // Fake Google consent screen (dev/E2E): pick the Google account to "sign in" with; issues a one-time code like Google would.
    const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    app.get('/api/_dev/google/consent', (req, res) => {
      const { state, nonce, login_hint: hint } = req.query;
      res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fake Google Sign-In</title>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px"><h2>Fake Google 계정 선택 <small style="color:#888">(개발용)</small></h2>
<form method="get" action="/api/_dev/google/consent/go" id="gc"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="nonce" value="${esc(nonce)}">
<p><label>이메일<br><input name="email" id="g-email" type="email" required value="${esc(hint)}" style="width:100%;padding:8px"></label></p>
<p><label>이름<br><input name="name" id="g-name" value="Google User" style="width:100%;padding:8px"></label></p>
<p><label><input type="checkbox" name="verified" value="1" checked> email_verified</label></p>
<p><button id="g-ok" style="padding:10px 16px">계속</button> <a href="/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(String(state || ''))}">취소</a></p></form>`);
    });
    app.get('/api/_dev/google/consent/go', (req, res) => {
      const p = getGoogleProvider(); const { state, nonce, email, name, verified } = req.query || {};
      const sub = `sub-${sha256(String(email || '').trim().toLowerCase()).slice(0, 16)}`;
      const code = p.issueCode({ sub, email: String(email || '').trim().toLowerCase(), name: String(name || 'Google User'), email_verified: verified === '1', nonce: String(nonce || '') });
      res.redirect(`/api/auth/google/callback?state=${encodeURIComponent(String(state || ''))}&code=${encodeURIComponent(code)}`);
    });
  }
  app.get('/api/auth/providers', (req, res) => { const cfg = googleConfig(); res.json({ google: { enabled: cfg.configured || getGoogleProvider().name === 'fake' } }); });

  /* ---------- Google ---------- */
  app.get('/api/auth/google/start', wrap(async (req, res) => {
    if (googleStartLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    googleStartLimit.hit(req.ip);
    const intentRaw = String(req.query.intent || 'login').toLowerCase();
    let intent = intentRaw === 'signup' ? 'SIGNUP' : 'LOGIN'; let invitationId = null; let returnPath = safeNext(req.query.next);
    if (req.query.invite) {
      const inv = await I.getByToken(db, String(req.query.invite));
      if (!inv || inv.status !== 'PENDING') return res.redirect('/login?error=invite_invalid');
      intent = 'INVITE'; invitationId = inv.id; returnPath = `/invite/${String(req.query.invite)}`;
    }
    try { const r = await startGoogleAuth(db, { intent, invitationId, returnPath, loginHint: req.query.login_hint ? String(req.query.login_hint).slice(0, 254) : null }); return res.redirect(r.url); }
    catch (e) { if (e instanceof GoogleAuthError) return res.redirect(`/login?error=${encodeURIComponent(e.code)}`); throw e; }
  }));
  app.get('/api/auth/google/callback', wrap(async (req, res) => {
    const { code, state, error } = req.query || {};
    if (error) return res.redirect('/login?error=google_denied');   // never echo code/state
    let r;
    try { r = await finishGoogleAuth(db, { state: String(state || ''), code: String(code || ''), tx }); }
    catch (e) { if (e instanceof GoogleAuthError) return res.redirect(`/login?error=${encodeURIComponent(e.code)}`); throw e; }
    const user = await db.get('SELECT * FROM users WHERE id = ?', [r.userId]);
    if (!user || user.status !== 'ACTIVE') return res.redirect('/login?suspended=1');
    await afterLogin(req, res, user);
    res.redirect(r.returnPath || '/app');
  }));

  /* ---------- invitation landing / accept ---------- */
  app.get('/api/invitations/:token', wrap(async (req, res) => {
    if (inviteLookupLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    inviteLookupLimit.hit(req.ip);
    const inv = await I.getByToken(db, req.params.token);
    if (!inv) return fail(res, 404, 'invite_not_found', '초대를 찾을 수 없습니다. 링크가 올바른지 확인해 주세요.');
    res.json({ invitation: I.publicView(inv, req.user || null), google: { enabled: googleConfig().configured || getGoogleProvider().name === 'fake' } });
  }));
  app.post('/api/invitations/:token/accept', requireAuth, wrap(async (req, res) => send(res, async () => {
    const inv = await I.getByToken(db, req.params.token);
    if (!inv) return fail(res, 404, 'invite_not_found', '초대를 찾을 수 없습니다.');
    const r = await tx(db, (db) => I.acceptInvite(db, inv, req.user));
    res.json({ ok: true, type: r.type, workspace_id: r.workspaceId, workspaces: await afterLogin.memberships(req.user.id) });
  })));

  /* ---------- workspace member invitations ---------- */
  const W = '/api/workspaces/:wid/invitations';
  const manage = [...guard, requireAction('member_manage')];
  app.get(W, manage, wrap(async (req, res) => res.json({ invitations: await I.pendingForWorkspace(db, req.params.wid), all: (await I.listInvitations(db, { workspaceId: req.params.wid, size: 100 })).items })));
  app.post(W, manage, wrap(async (req, res) => send(res, async () => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (memberInviteLimit.blocked(req.params.wid) || (email && inviteEmailLimit.blocked(email))) return fail(res, 429, 'rate_limited', '초대 발송이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const r = await I.createMemberInvite(db, { workspaceId: req.params.wid, email, role: req.body?.role }, req.user, req.role);
    memberInviteLimit.hit(req.params.wid); inviteEmailLimit.hit(email);
    res.status(201).json(r);
  })));
  const loadWsInvite = async (req, res) => { const inv = await I.getInvitation(db, req.params.id); if (!inv || inv.type !== 'WORKSPACE_MEMBER' || inv.workspace_id !== req.params.wid) { fail(res, 404, 'not_found', '초대를 찾을 수 없습니다.'); return null; } return inv; };
  app.post(`${W}/:id/resend`, manage, wrap(async (req, res) => send(res, async () => {
    const inv = await loadWsInvite(req, res); if (!inv) return;
    if (inv.role === 'ADMIN' && req.role !== 'OWNER') return fail(res, 403, 'forbidden', 'ADMIN 초대는 OWNER만 재발송할 수 있습니다.');
    if (resendLimit.blocked(inv.id) || inviteEmailLimit.blocked(inv.email)) return fail(res, 429, 'rate_limited', '재발송이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
    resendLimit.hit(inv.id); inviteEmailLimit.hit(inv.email);
    res.json(await I.resendInvite(db, inv, req.user));
  })));
  app.delete(`${W}/:id`, manage, wrap(async (req, res) => send(res, async () => { const inv = await loadWsInvite(req, res); if (!inv) return; res.json({ invitation: await I.revokeInvite(db, inv, req.user) }); })));

}

/** Mounted from admin-routes.js (before its /api/admin/* catch-all). */
export function mountAdminInvitationRoutes(app, db, { guard: adminGuard, wrap, fail }) {
  const platformInviteLimit = rateLimiter({ max: 30, windowMs: 60 * 60 * 1000 }); const inviteEmailLimit = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 }); const resendLimit = rateLimiter({ max: 3, windowMs: 10 * 60 * 1000 });
  const send = (res, fn) => fn().catch((e) => { if (e instanceof I.InviteError) return fail(res, e.status, e.code, e.message, e.extra); throw e; });
  /* ---------- admin: platform invitations + operations view ---------- */
  app.get('/api/admin/invitations', adminGuard, wrap(async (req, res) => { const page = Math.max(1, Number(req.query.page) || 1); const size = Math.min(100, Math.max(1, Number(req.query.size) || 50)); res.json(await I.listInvitations(db, { type: String(req.query.type || ''), status: String(req.query.status || ''), q: String(req.query.q || '').trim(), page, size })); }));
  app.post('/api/admin/invitations', adminGuard, wrap(async (req, res) => send(res, async () => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (platformInviteLimit.blocked(req.user.id) || (email && inviteEmailLimit.blocked(email))) return fail(res, 429, 'rate_limited', '초대 발송이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const r = await I.createPlatformInvite(db, { email, workspaceName: req.body?.workspace_name, inviteeName: req.body?.invitee_name, note: req.body?.note }, req.user);
    platformInviteLimit.hit(req.user.id); inviteEmailLimit.hit(email);
    res.status(201).json(r);
  })));
  const loadAdminInvite = async (req, res) => { const inv = await I.getInvitation(db, req.params.id); if (!inv) { fail(res, 404, 'not_found', '초대를 찾을 수 없습니다.'); return null; } if (inv.type !== 'WORKSPACE_CREATE') { fail(res, 403, 'forbidden', 'Workspace 멤버 초대는 해당 Workspace의 OWNER/ADMIN이 관리합니다.'); return null; } return inv; };
  app.post('/api/admin/invitations/:id/resend', adminGuard, wrap(async (req, res) => send(res, async () => { const inv = await loadAdminInvite(req, res); if (!inv) return; if (resendLimit.blocked(inv.id)) return fail(res, 429, 'rate_limited', '재발송이 너무 잦습니다. 잠시 후 다시 시도해 주세요.'); resendLimit.hit(inv.id); res.json(await I.resendInvite(db, inv, req.user)); })));
  app.post('/api/admin/invitations/:id/revoke', adminGuard, wrap(async (req, res) => send(res, async () => { const inv = await loadAdminInvite(req, res); if (!inv) return; res.json({ invitation: await I.revokeInvite(db, inv, req.user) }); })));
  app.get('/api/admin/email-deliveries', adminGuard, wrap(async (req, res) => { const page = Math.max(1, Number(req.query.page) || 1); const size = Math.min(100, Math.max(1, Number(req.query.size) || 50)); res.json(await listDeliveries(db, { page, size, status: String(req.query.status || ''), type: String(req.query.type || ''), q: String(req.query.q || '').trim() })); }));

}
