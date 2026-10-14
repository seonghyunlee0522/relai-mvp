/**
 * Account security (launch hardening): password reset by e-mail and e-mail verification for direct signups.
 *   POST /api/auth/password/forgot   { email }            → always 200 { ok } (never reveals whether the account exists)
 *   POST /api/auth/password/reset    { token, password }  → 200 { ok } | 400 token_invalid / validation
 *   POST /api/auth/email/verify      { token }            → 200 { ok, email_verified: true } | 400 token_invalid  (no session needed)
 *   POST /api/auth/email/resend                           → requireAuth; 200 { ok, already_verified? } | 429
 *
 * Tokens: 256-bit random, raw value only in the e-mail link; auth_tokens holds sha256(purpose:SESSION_SECRET:token).
 * Single use is enforced by one conditional UPDATE … RETURNING (used_at IS NULL AND not expired), so two concurrent
 * submits of the same link cannot both succeed. A new request invalidates the user's older unused tokens of that purpose.
 *
 * Reset: 30-minute expiry. On success: new password, every session of the user deleted (all devices logged out),
 * remaining reset tokens invalidated, e-mail marked verified (the link proved ownership), PASSWORD identity ensured
 * (a Google-only user may set a password this way), audit row PASSWORD_RESET. The user then logs in normally.
 *
 * Verification policy (unverified = users.email_verified_at IS NULL, i.e. direct password signups until they click the link):
 *   allowed:   log in, use their own personal workspace (projects, requirements, WBS, AI within free limits), be invited by others.
 *   refused:   sending workspace invitations (POST/resend …/invitations → 403 email_unverified) and paying — billing routes
 *              must mount `requireVerifiedEmail` (exported here) in front of checkout / subscription changes.
 * Google sign-ups and invitation sign-ups are verified at creation (the provider or the invite e-mail proved the address).
 */
import { randomUUID } from 'node:crypto';
import { newToken, sha256, hashPassword, rateLimiter } from '../security.js';
import { emailConfig } from '../email/config.js';
import { sendEmail } from '../email/service.js';
import { passwordResetEmail, verifyEmailEmail } from '../email/templates.js';
import { addIdentity, normEmail } from '../accounts.js';
import { writeAudit } from '../admin.js';
import { tx } from '../db.js';

export const RESET_MINUTES = 30;
export const VERIFY_HOURS = 48;
const PASSWORD_RULE = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.';
export const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? PASSWORD_RULE : null);

const hashFor = (purpose, token, env = process.env) => sha256(`${purpose}:${env.SESSION_SECRET || ''}:${token}`);
/** Links are built from APP_BASE_URL (production refuses to boot without it). Dev/test fallback: localhost. */
const linkBase = (env = process.env) => emailConfig(env).appBaseUrl || `http://localhost:${env.PORT || 3000}`;

/** Creates a fresh token for (user, purpose), invalidating that user's older unused ones. Returns the raw token. */
async function issueToken(db, { userId, email, purpose, ttlMs }) {
  const token = newToken();
  await db.run(`UPDATE auth_tokens SET used_at = now() WHERE user_id = ? AND purpose = ? AND used_at IS NULL`, [userId, purpose]);
  await db.run('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email, expires_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), userId, purpose, hashFor(purpose, token), normEmail(email), new Date(Date.now() + ttlMs).toISOString()]);
  return token;
}
/** Atomically marks a valid token used. Returns { user_id, email } or null (unknown, used, expired). */
async function consumeToken(db, purpose, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return db.get(`UPDATE auth_tokens SET used_at = now() WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > now()
    RETURNING user_id, email`, [hashFor(purpose, token), purpose]);
}

/** Sends the verification e-mail for a user (direct signup, resend). Never throws on delivery failure. */
export async function sendVerificationEmail(db, user) {
  const token = await issueToken(db, { userId: user.id, email: user.email, purpose: 'EMAIL_VERIFY', ttlMs: VERIFY_HOURS * 3600e3 });
  const m = verifyEmailEmail({ name: user.name, link: `${linkBase()}/verify-email?token=${token}`, hours: VERIFY_HOURS, support: emailConfig().supportEmail });
  return sendEmail(db, { type: 'EMAIL_VERIFY', to: user.email, ...m, relatedUserId: user.id });
}

/** Middleware: refuses users whose e-mail is not verified. Mount after requireAuth (req.user carries email_verified_at). */
export const requireVerifiedEmail = (fail) => (req, res, next) => (req.user && req.user.email_verified_at ? next()
  : fail(res, 403, 'email_unverified', '이메일 인증 후 이용할 수 있습니다. 받은 편지함의 인증 메일을 확인하거나 인증 메일을 다시 받아 주세요.'));

export function mountAccountSecurityRoutes({ app, db, wrap, fail, requireAuth, minForgotMs = process.env.NODE_ENV === 'production' ? 800 : 0 }) {
  const forgotIpLimit = rateLimiter(db, { name: 'forgot-ip', max: 10, windowMs: 60 * 60 * 1000 });
  const forgotEmailLimit = rateLimiter(db, { name: 'forgot-email', max: 3, windowMs: 60 * 60 * 1000 });
  const resetIpLimit = rateLimiter(db, { name: 'reset-ip', max: 20, windowMs: 60 * 60 * 1000 });
  const verifyIpLimit = rateLimiter(db, { name: 'verify-ip', max: 30, windowMs: 60 * 60 * 1000 });
  const resendUserLimit = rateLimiter(db, { name: 'verify-resend', max: 3, windowMs: 60 * 60 * 1000 });
  const tokenInvalid = (res) => fail(res, 400, 'token_invalid', '링크가 만료되었거나 이미 사용되었습니다. 다시 요청해 주세요.');

  app.post('/api/auth/password/forgot', wrap(async (req, res) => {
    const started = Date.now();
    if (await forgotIpLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    await forgotIpLimit.hit(req.ip);
    const email = normEmail(req.body?.email);
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'validation', '이메일 형식이 올바르지 않습니다.', { fields: { email: '이메일 형식이 올바르지 않습니다.' } });
    // Same response whatever happens below: unknown e-mail, suspended account, per-address limit hit, or mail sent.
    if (!(await forgotEmailLimit.blocked(email))) {
      await forgotEmailLimit.hit(email);
      const user = await db.get('SELECT id, email, status FROM users WHERE email = ?', [email]);
      if (user && user.status === 'ACTIVE') {
        const token = await issueToken(db, { userId: user.id, email: user.email, purpose: 'PASSWORD_RESET', ttlMs: RESET_MINUTES * 60e3 });
        const m = passwordResetEmail({ link: `${linkBase()}/reset-password?token=${token}`, minutes: RESET_MINUTES, support: emailConfig().supportEmail });
        await sendEmail(db, { type: 'PASSWORD_RESET', to: user.email, ...m, relatedUserId: user.id });
      }
    }
    // Pad to a floor so "mail was sent" and "no such account" take about the same time (production only).
    const wait = minForgotMs - (Date.now() - started); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    res.json({ ok: true });
  }));

  app.post('/api/auth/password/reset', wrap(async (req, res) => {
    if (await resetIpLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    await resetIpLimit.hit(req.ip);
    const password = req.body?.password;
    const problem = passwordProblem(password);
    if (problem) return fail(res, 400, 'validation', problem, { fields: { password: problem } });
    const passwordHash = await hashPassword(password);
    const done = await tx(db, async (db) => {
      const t = await consumeToken(db, 'PASSWORD_RESET', req.body?.token);
      if (!t) return null;
      const user = await db.get('SELECT id, email, status FROM users WHERE id = ? FOR UPDATE', [t.user_id]);
      if (!user || user.status !== 'ACTIVE' || user.email !== t.email) return null;   // address changed / account suspended since the mail
      await db.run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ?', [passwordHash, user.id]);
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      await db.run(`UPDATE auth_tokens SET used_at = now() WHERE user_id = ? AND purpose = 'PASSWORD_RESET' AND used_at IS NULL`, [user.id]);
      if (!(await db.get(`SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'PASSWORD'`, [user.id]))) await addIdentity(db, { userId: user.id, provider: 'PASSWORD', subject: user.id, email: user.email, verified: true });
      await db.run(`UPDATE user_identities SET email_verified = true WHERE user_id = ? AND provider = 'PASSWORD'`, [user.id]);
      await writeAudit(db, { adminUserId: user.id, action: 'PASSWORD_RESET', targetType: 'USER', targetId: user.id, metadata: {}, actorKind: 'USER' });
      return user;
    });
    if (!done) return tokenInvalid(res);
    res.json({ ok: true });
  }));

  app.post('/api/auth/email/verify', wrap(async (req, res) => {
    if (await verifyIpLimit.blocked(req.ip)) return fail(res, 429, 'rate_limited', '잠시 후 다시 시도해 주세요.');
    await verifyIpLimit.hit(req.ip);
    const ok = await tx(db, async (db) => {
      const t = await consumeToken(db, 'EMAIL_VERIFY', req.body?.token);
      if (!t) return false;
      const user = await db.get('SELECT id, email FROM users WHERE id = ?', [t.user_id]);
      if (!user || user.email !== t.email) return false;
      await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ?', [user.id]);
      await db.run(`UPDATE user_identities SET email_verified = true WHERE user_id = ? AND provider = 'PASSWORD'`, [user.id]);
      await writeAudit(db, { adminUserId: user.id, action: 'EMAIL_VERIFIED', targetType: 'USER', targetId: user.id, metadata: {}, actorKind: 'USER' });
      return true;
    });
    if (!ok) return tokenInvalid(res);
    res.json({ ok: true, email_verified: true });
  }));

  app.post('/api/auth/email/resend', requireAuth, wrap(async (req, res) => {
    if (req.user.email_verified_at) return res.json({ ok: true, already_verified: true });
    if (await resendUserLimit.blocked(req.user.id)) return fail(res, 429, 'rate_limited', '인증 메일을 너무 자주 요청했습니다. 잠시 후 다시 시도해 주세요.');
    await resendUserLimit.hit(req.user.id);
    const d = await sendVerificationEmail(db, req.user);
    if (d.status !== 'SENT') return fail(res, 502, 'email_failed', '인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    res.json({ ok: true });
  }));
}
