/**
 * Account lifecycle (migration 30): profile edit, password change, self-service account deletion (회원 탈퇴),
 * workspace deletion by its OWNER, and the login record kept for 통신비밀보호법.
 *   GET    /api/me/account     { has_password, email_verified, can_set_password, login_methods, deletion: { blockers, workspaces_deleted } }
 *   PATCH  /api/me             { name }                                → { user }
 *   POST   /api/me/password    { current_password?, new_password }    → { ok, sessions_revoked }
 *   DELETE /api/me             { password? }                           → { ok, workspaces_deleted }   (session cleared)
 *   DELETE /api/workspaces/:wid { confirm_name, password? }           → { ok, purge_after, fallback_workspace_id }  (OWNER only)
 *
 * Re-authentication (deletions): an account with a password must send it; a Google-only account must have signed in within
 * the last REAUTH_MINUTES (the current session's age), otherwise 401 reauth_required and the UI sends them through Google again.
 *
 * Password change: the current password is required; a Google-only account (no password yet) may set one once its e-mail is
 * verified. Every other session of the user is revoked; the current one stays.
 *
 * Account deletion: refused while the user is the only OWNER of a workspace that has other members (transfer OWNER or remove
 * them first), while a workspace that would be deleted still has a paid subscription running, and for operators (SYSTEM_ADMIN).
 * Workspaces where the user is the only member are deleted with the account (same rules as workspace deletion). The users row is
 * kept as a pseudonymous tombstone (status DEACTIVATED, e-mail/name replaced, password and sign-in methods removed) because work
 * items keep `created_by`; personal data is gone at once. login_records stay for their legal 3 months.
 *
 * Workspace deletion: soft delete (status CLOSED, deleted_at) — members lose access at once, pending invitations are revoked, the
 * Jira connection is disconnected. After PURGE_DAYS the purge job removes every project and workspace-scoped row; the workspaces
 * row stays as a tombstone so payments / subscriptions (전자상거래법: 5 years) keep their reference.
 */
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, rateLimiter } from '../security.js';
import { passwordProblem } from './account-security.js';
import { addIdentity, createWorkspaceForOwner } from '../accounts.js';
import { writeAudit } from '../admin.js';
import { requireOwner } from '../authz.js';
import { effectivePlan, getSubscription } from '../billing/subscriptions.js';
import { disconnect } from '../integrations/service.js';
import { tx } from '../db.js';

export const REAUTH_MINUTES = 10;
export const PURGE_DAYS = 30;
export const LOGIN_RECORD_MONTHS = 3;
export const DELETED_USER_NAME = '탈퇴한 사용자';
export const DELETED_WORKSPACE_NAME = '삭제된 Workspace';

/** One row per successful sign-in (접속 일시, IP 주소). Purged after LOGIN_RECORD_MONTHS by purgeAccountData(). */
export async function recordLogin(db, { userId, method, req }) {
  const ua = String(req?.get?.('user-agent') || '').slice(0, 300) || null;
  await db.run('INSERT INTO login_records (id, user_id, method, ip, user_agent) VALUES (?,?,?,?,?)', [randomUUID(), userId, method, String(req?.ip || '').slice(0, 64) || null, ua]);
}

/**
 * A paid plan that renews and is not set to end — deleting would keep charging the customer. One-time (일반결제) purchases
 * (auto_renew = false) never charge again and cannot be canceled, so they do not block; the prepaid period simply ends.
 */
async function runningSubscription(db, workspaceId) {
  if ((await effectivePlan(db, workspaceId)) === 'FREE') return null;
  const s = await getSubscription(db, workspaceId);
  return s && s.auto_renew !== false && !s.cancel_at_period_end ? s : null;
}

/** Soft delete. Caller runs inside tx and has checked permission + subscription. */
async function closeWorkspace(db, w, actor) {
  await db.run(`UPDATE workspaces SET status = 'CLOSED', deleted_at = now(), deleted_by = ? WHERE id = ?`, [actor.id, w.id]);
  await db.run(`UPDATE invitations SET status = 'REVOKED', revoked_at = now(), updated_at = now() WHERE workspace_id = ? AND status = 'PENDING'`, [w.id]);
  await disconnect(db, w.id);   // wipes Jira tokens, stops scheduled sync and webhook renewal
  await writeAudit(db, { adminUserId: actor.id, action: 'WORKSPACE_DELETED', targetType: 'WORKSPACE', targetId: w.id, metadata: { name: w.name, purge_after_days: PURGE_DAYS }, actorKind: 'USER' });
}

/** What stops this user from deleting the account, and which workspaces would be deleted with it. */
async function deletionPlan(db, user) {
  const rows = await db.all(`SELECT w.id, w.name, w.owner_id, m.role,
      (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = w.id AND o.role = 'OWNER') AS owners,
      (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = w.id) AS members
    FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND w.status <> 'CLOSED' ORDER BY w.created_at`, [user.id]);
  const blockers = []; const solo = []; const shared = [];
  if (user.system_role === 'SYSTEM_ADMIN') blockers.push({ code: 'system_admin', message: '운영자 계정은 탈퇴할 수 없습니다. 다른 운영자에게 권한 해제를 요청해 주세요.' });
  for (const w of rows) {
    if (Number(w.members) === 1) {
      solo.push(w);
      if (await runningSubscription(db, w.id)) blockers.push({ code: 'subscription_active', workspace_id: w.id, workspace_name: w.name, message: `'${w.name}' Workspace의 유료 구독을 먼저 해지해 주세요.` });
    } else if (w.role === 'OWNER' && Number(w.owners) === 1) {
      blockers.push({ code: 'sole_owner', workspace_id: w.id, workspace_name: w.name, message: `'${w.name}' Workspace의 유일한 OWNER입니다. 다른 멤버에게 OWNER를 넘기거나 멤버를 모두 내보낸 후 탈퇴할 수 있습니다.` });
    } else shared.push(w);
  }
  return { blockers, solo, shared };
}

export function mountAccountRoutes({ app, db, wrap, fail, guard, requireAuth, sessionHash, clearSessionCookie, toPublicUser }) {
  const pwLimit = rateLimiter(db, { name: 'account-password', max: 5, windowMs: 15 * 60 * 1000 });   // per user: wrong current password / re-auth
  const loadUser = (id) => db.get('SELECT id, email, name, status, system_role, password_hash, email_verified_at FROM users WHERE id = ?', [id]);

  /** Re-authentication for destructive actions. Returns true, or sends the error and returns false.
   * Failures are 403, never 401: the session is valid, and the client treats any 401 as "logged out" (redirects to /login). */
  async function reauth(req, res, user) {
    if (user.password_hash) {
      if (await pwLimit.blocked(user.id)) { fail(res, 429, 'rate_limited', '비밀번호를 너무 많이 틀렸습니다. 잠시 후 다시 시도해 주세요.'); return false; }
      if (!(await verifyPassword(String(req.body?.password || ''), user.password_hash))) {
        await pwLimit.hit(user.id);
        fail(res, 403, 'invalid_password', '비밀번호가 올바르지 않습니다.', { fields: { password: '비밀번호가 올바르지 않습니다.' } }); return false;
      }
      return true;
    }
    const s = await db.get(`SELECT created_at > now() - (?::int * interval '1 minute') AS fresh FROM sessions WHERE token_hash = ?`, [REAUTH_MINUTES, sessionHash(req)]);
    if (!s?.fresh) { fail(res, 403, 'reauth_required', `보안을 위해 Google로 다시 로그인한 후 ${REAUTH_MINUTES}분 안에 진행해 주세요.`); return false; }
    return true;
  }

  app.get('/api/me/account', requireAuth, wrap(async (req, res) => {
    const user = await loadUser(req.user.id);
    const methods = await db.all('SELECT provider, email, last_used_at FROM user_identities WHERE user_id = ? ORDER BY created_at', [user.id]);
    const plan = await deletionPlan(db, user);
    res.json({ account: { has_password: Boolean(user.password_hash), email_verified: Boolean(user.email_verified_at), can_set_password: !user.password_hash && Boolean(user.email_verified_at),
      login_methods: methods, reauth_minutes: REAUTH_MINUTES, deletion: { blockers: plan.blockers, workspaces_deleted: plan.solo.map((w) => ({ id: w.id, name: w.name })) } } });
  }));

  app.patch('/api/me', requireAuth, wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 50) return fail(res, 400, 'validation', '이름을 50자 이내로 입력해 주세요.', { fields: { name: '이름을 50자 이내로 입력해 주세요.' } });
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
    res.json({ user: toPublicUser({ ...req.user, name }) });
  }));

  app.post('/api/me/password', requireAuth, wrap(async (req, res) => {
    const user = await loadUser(req.user.id);
    const next = req.body?.new_password;
    if (user.password_hash) {
      if (await pwLimit.blocked(user.id)) return fail(res, 429, 'rate_limited', '비밀번호를 너무 많이 틀렸습니다. 잠시 후 다시 시도해 주세요.');
      if (!(await verifyPassword(String(req.body?.current_password || ''), user.password_hash))) {
        await pwLimit.hit(user.id);
        return fail(res, 400, 'invalid_password', '현재 비밀번호가 올바르지 않습니다.', { fields: { current_password: '현재 비밀번호가 올바르지 않습니다.' } });
      }
    } else if (!user.email_verified_at) return fail(res, 403, 'email_unverified', '이메일 인증 후 비밀번호를 설정할 수 있습니다.');
    const problem = passwordProblem(next);
    if (problem) return fail(res, 400, 'validation', problem, { fields: { new_password: problem } });
    if (user.password_hash && await verifyPassword(next, user.password_hash)) return fail(res, 400, 'validation', '현재 비밀번호와 다른 비밀번호를 입력해 주세요.', { fields: { new_password: '현재 비밀번호와 다른 비밀번호를 입력해 주세요.' } });
    const hash = await hashPassword(next);
    const revoked = await tx(db, async (db) => {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
      const n = (await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [user.id, sessionHash(req) || ''])).changes;
      await db.run(`UPDATE auth_tokens SET used_at = now() WHERE user_id = ? AND purpose = 'PASSWORD_RESET' AND used_at IS NULL`, [user.id]);
      if (!(await db.get(`SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'PASSWORD'`, [user.id]))) await addIdentity(db, { userId: user.id, provider: 'PASSWORD', subject: user.id, email: user.email, verified: Boolean(user.email_verified_at) });
      await writeAudit(db, { adminUserId: user.id, action: user.password_hash ? 'PASSWORD_CHANGED' : 'PASSWORD_SET', targetType: 'USER', targetId: user.id, metadata: { sessions_revoked: n }, actorKind: 'USER' });
      return n;
    });
    await pwLimit.reset(user.id);
    res.json({ ok: true, sessions_revoked: revoked });
  }));

  app.delete('/api/me', requireAuth, wrap(async (req, res) => {
    const user = await loadUser(req.user.id);
    if (!(await reauth(req, res, user))) return;
    const out = await tx(db, async (db) => {
      await db.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [user.id]);
      const plan = await deletionPlan(db, user);
      if (plan.blockers.length) return { blockers: plan.blockers };
      for (const w of plan.solo) await closeWorkspace(db, w, user);
      for (const w of plan.shared) {   // another OWNER remains: hand the owner pointer over
        if (w.owner_id === user.id) await db.run(`UPDATE workspaces SET owner_id = (SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'OWNER' AND user_id <> ? ORDER BY created_at LIMIT 1) WHERE id = ?`, [w.id, user.id, w.id]);
      }
      await db.run('DELETE FROM workspace_members WHERE user_id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE status <> ?)', [user.id, 'CLOSED']);
      for (const t of ['sessions', 'auth_tokens', 'user_identities', 'user_onboarding', 'user_feature_guides', 'integration_oauth_states']) await db.run(`DELETE FROM ${t} WHERE user_id = ?`, [user.id]);
      await db.run('DELETE FROM email_deliveries WHERE related_user_id = ?', [user.id]);
      await db.run(`UPDATE admin_audit_logs SET metadata = metadata - 'email' - 'name' WHERE target_type = 'USER' AND target_id = ?`, [user.id]);
      await db.run(`UPDATE users SET email = ?, name = ?, password_hash = NULL, email_verified_at = NULL, last_login_at = NULL, status = 'DEACTIVATED', deleted_at = now() WHERE id = ?`,
        [`deleted-${user.id}@deleted.invalid`, DELETED_USER_NAME, user.id]);
      await writeAudit(db, { adminUserId: user.id, action: 'ACCOUNT_DELETED', targetType: 'USER', targetId: user.id, metadata: { workspaces_deleted: plan.solo.map((w) => w.id), method: user.password_hash ? 'PASSWORD' : 'RECENT_LOGIN' }, actorKind: 'USER' });
      return { deleted: plan.solo.map((w) => ({ id: w.id, name: w.name })) };
    });
    if (out.blockers) return fail(res, 409, 'account_delete_blocked', out.blockers[0].message, { blockers: out.blockers });
    clearSessionCookie(res);
    res.json({ ok: true, workspaces_deleted: out.deleted });
  }));

  app.delete('/api/workspaces/:wid', guard, requireOwner(), wrap(async (req, res) => {
    const user = await loadUser(req.user.id);
    const w = await db.get('SELECT id, name, status FROM workspaces WHERE id = ?', [req.params.wid]);
    if (String(req.body?.confirm_name ?? '').trim() !== w.name) return fail(res, 400, 'validation', '확인을 위해 Workspace 이름을 정확히 입력해 주세요.', { fields: { confirm_name: 'Workspace 이름이 일치하지 않습니다.' } });
    if (!(await reauth(req, res, user))) return;
    if (await runningSubscription(db, w.id)) return fail(res, 409, 'subscription_active', '유료 구독을 먼저 해지해 주세요. 해지 예약 후 삭제할 수 있습니다.');
    const fallback = await tx(db, async (db) => {
      const cur = await db.get('SELECT id, name, status FROM workspaces WHERE id = ? FOR UPDATE', [w.id]);
      if (cur.status === 'CLOSED') return undefined;
      await closeWorkspace(db, cur, user);
      // The app needs a workspace to open: an owner left with none gets a fresh empty one (account deletion is the way out).
      const left = await db.get(`SELECT 1 FROM workspace_members m JOIN workspaces x ON x.id = m.workspace_id WHERE m.user_id = ? AND x.status <> 'CLOSED' LIMIT 1`, [user.id]);
      return left ? null : createWorkspaceForOwner(db, { ownerId: user.id, name: `${user.name}님의 워크스페이스` });
    });
    if (fallback === undefined) return fail(res, 404, 'not_found', '찾을 수 없습니다.');
    res.json({ ok: true, purge_after: new Date(Date.now() + PURGE_DAYS * 86400e3).toISOString(), fallback_workspace_id: fallback });
  }));
}

/**
 * Tables holding a deleted workspace's data, removed by the purge. Projects go first (their children cascade). Billing rows
 * (subscriptions, payments, billing_events, subscription_events) are deliberately absent: 전자상거래법 keeps them 5 years.
 */
const WORKSPACE_TABLES = ['projects', 'ai_wbs_plans', 'ai_runs', 'credit_ledger', 'workspace_credit_accounts', 'integration_oauth_states', 'integration_connections',
  'user_onboarding', 'email_deliveries', 'invitations', 'workspace_members'];

/** Purge step for /api/cron/purge: login records past 3 months, workspaces deleted more than PURGE_DAYS ago (batch). */
export async function purgeAccountData(db, { batch = 20 } = {}) {
  const lr = await db.get(`WITH d AS (DELETE FROM login_records WHERE created_at < now() - (?::int * interval '1 month') RETURNING 1) SELECT COUNT(*) AS n FROM d`, [LOGIN_RECORD_MONTHS]);
  const due = await db.all(`SELECT id FROM workspaces WHERE status = 'CLOSED' AND purged_at IS NULL AND deleted_at < now() - (?::int * interval '1 day') ORDER BY deleted_at LIMIT ?`, [PURGE_DAYS, batch]);
  for (const { id } of due) {
    await tx(db, async (db) => {
      for (const t of WORKSPACE_TABLES) await db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, [id]);
      await db.run(`UPDATE invitations SET accepted_workspace_id = NULL WHERE accepted_workspace_id = ?`, [id]);
      await db.run('UPDATE workspaces SET name = ?, purged_at = now() WHERE id = ?', [DELETED_WORKSPACE_NAME, id]);
      await db.run(`UPDATE admin_audit_logs SET metadata = metadata - 'name' WHERE target_type = 'WORKSPACE' AND target_id = ?`, [id]);
    });
  }
  return { login_records: Number(lr.n), workspaces_purged: due.length };
}
