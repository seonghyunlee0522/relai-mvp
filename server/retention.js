/**
 * Personal-data retention (migration 65). Closes the gaps in hive research/relai-retention-legal.md (G-1..G-6, G-8) with the founder's
 * answer of 2026-10-21 ("1년 후 파기. 그 외는 말한대로"). Runs daily from purgeExpired (GET /api/cron/purge). Every period here is
 * written in the privacy policy 제3조 (server/legal.js) — change both together; server/test/retention.test.js checks the text.
 *
 *   이용 분석 (analytics_events, analytics_active_days)   1 year after the event / day            G-4, company policy
 *   AI 실행 기록 (ai_runs)                                1 year after the run                    G-4 (크레딧 차감 내역 credit_ledger stays with the workspace)
 *   이메일 발송 기록 (email_deliveries)                   1 year after sending                    G-4
 *   만료·취소된 초대 (invitations not ACCEPTED)            30 days after expiry / revocation        G-2, §21① purpose achieved
 *   가입 크레딧 지급 기록 (free_credit_claims)             3 years after the grant                  G-1
 *   의견·문의 (feedback), every member                    3 years after it was sent               G-3 (user-delete.js purgeRetained)
 *   결제 기록 (withdrawn billing_orders, service_orders,   until 6 years after the transaction's    G-6 (user-delete.js taxCutoffSql)
 *     deleted workspaces' payments)                       year ends = 법정신고기한 + 5 years or more
 *   운영자 접속기록 (admin_access_logs)                   2 years (고시 §8: 1 year or more; 2 years once 50,000+ people)   G-5
 *   1년 미이용 계정                                       e-mail 30 days ahead, then 회원 탈퇴 (withdrawAccount)         G-8
 */
import { withdrawAccount } from './auth/account.js';
import { sendEmail } from './email/service.js';
import { emailConfig } from './email/config.js';
import { inactiveAccountEmail } from './email/templates.js';

export const RETENTION_POLICY = {
  LOG_YEARS: 1,                // analytics, AI runs, e-mail deliveries
  ENDED_INVITE_DAYS: 30,       // expired / revoked invitations
  FREE_CLAIM_YEARS: 3,         // free_credit_claims
  ADMIN_ACCESS_YEARS: 2,       // admin_access_logs
  INACTIVE_YEARS: 1,           // no sign-in / signed-in request for this long → account deleted
  INACTIVE_NOTICE_DAYS: 30,    // the e-mail goes out this many days before
};

/** Last time the person used RELAI: sign-up, last sign-in, last signed-in day (analytics_active_days), newest session start. */
const LAST_ACTIVE_SQL = `GREATEST(u.created_at, COALESCE(u.last_login_at, u.created_at),
  COALESCE((SELECT (MAX(a.day) + 1)::timestamp AT TIME ZONE 'Asia/Seoul' FROM analytics_active_days a WHERE a.user_id = u.id), u.created_at),
  COALESCE((SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id), u.created_at))`;

const count = async (db, sql, p = []) => Number((await db.get(`WITH d AS (${sql} RETURNING 1) SELECT COUNT(*) AS n FROM d`, p)).n);

/** G-1, G-2, G-4, G-5: rows whose period is over. Idempotent. */
export async function purgePersonalLogs(db, P = RETENTION_POLICY) {
  return {
    analytics_events: await count(db, `DELETE FROM analytics_events WHERE created_at < now() - (?::int * interval '1 year')`, [P.LOG_YEARS]),
    analytics_active_days: await count(db, `DELETE FROM analytics_active_days WHERE day < (now() AT TIME ZONE 'Asia/Seoul')::date - (?::int * interval '1 year')`, [P.LOG_YEARS]),
    ai_runs: await count(db, `DELETE FROM ai_runs WHERE created_at < now() - (?::int * interval '1 year')`, [P.LOG_YEARS]),
    email_deliveries: await count(db, `DELETE FROM email_deliveries WHERE created_at < now() - (?::int * interval '1 year')`, [P.LOG_YEARS]),
    ended_invitations: await count(db, `DELETE FROM invitations WHERE status <> 'ACCEPTED' AND LEAST(expires_at, COALESCE(revoked_at, expires_at)) < now() - (?::int * interval '1 day')`, [P.ENDED_INVITE_DAYS]),
    free_credit_claims: await count(db, `DELETE FROM free_credit_claims WHERE granted_at < now() - (?::int * interval '1 year')`, [P.FREE_CLAIM_YEARS]),
    admin_access_logs: await count(db, `DELETE FROM admin_access_logs WHERE created_at < now() - (?::int * interval '1 year')`, [P.ADMIN_ACCESS_YEARS]),
  };
}

/**
 * G-8: 1년 미이용 계정. Two passes, `batch` people each:
 *   notice  last activity older than 1 year − 30 days and no notice since then → e-mail; inactive_notice_at is set only when it was SENT
 *           (a failed send is retried the next day, so nobody is deleted without the e-mail).
 *   delete  notice at least 30 days old, no activity since the notice, last activity older than 1 year → 회원 탈퇴 (same path as
 *           DELETE /api/me). Kept, with the reason counted: operators, the only OWNER of a shared workspace, a running paid subscription.
 * Suspended accounts are left to the operator.
 */
export async function processInactiveAccounts(db, { env = process.env, batch = 50, P = RETENTION_POLICY } = {}) {
  const out = { inactive_notified: 0, inactive_notice_failed: 0, inactive_deleted: 0, inactive_kept: 0 };
  const due = await db.all(`SELECT * FROM (SELECT u.id, u.email, u.name, u.inactive_notice_at, ${LAST_ACTIVE_SQL} AS last_active FROM users u
      WHERE u.status = 'ACTIVE' AND u.system_role <> 'SYSTEM_ADMIN') x
    WHERE x.last_active < now() - (?::int * interval '1 year') + (?::int * interval '1 day')
      AND (x.inactive_notice_at IS NULL OR x.inactive_notice_at < x.last_active)
    ORDER BY x.last_active LIMIT ?`, [P.INACTIVE_YEARS, P.INACTIVE_NOTICE_DAYS, batch]);
  const cfg = emailConfig(env);
  for (const u of due) {
    const deleteOn = new Date(Date.now() + P.INACTIVE_NOTICE_DAYS * 86400e3);
    const mail = inactiveAccountEmail({ name: u.name, lastActive: u.last_active, deleteOn, link: cfg.appBaseUrl ? `${cfg.appBaseUrl}/login` : '', support: cfg.supportEmail });
    const r = await sendEmail(db, { type: 'ACCOUNT_INACTIVE_NOTICE', to: u.email, ...mail, relatedUserId: u.id }, env);
    if (r.status === 'SENT') { await db.run('UPDATE users SET inactive_notice_at = now() WHERE id = ?', [u.id]); out.inactive_notified += 1; }
    else out.inactive_notice_failed += 1;
  }

  const gone = await db.all(`SELECT * FROM (SELECT u.id, u.email, u.name, u.status, u.system_role, u.password_hash, u.inactive_notice_at, ${LAST_ACTIVE_SQL} AS last_active FROM users u
      WHERE u.status = 'ACTIVE' AND u.system_role <> 'SYSTEM_ADMIN' AND u.inactive_notice_at IS NOT NULL AND u.inactive_notice_at <= now() - (?::int * interval '1 day')) x
    WHERE x.last_active < x.inactive_notice_at AND x.last_active < now() - (?::int * interval '1 year')
    ORDER BY x.inactive_notice_at LIMIT ?`, [P.INACTIVE_NOTICE_DAYS, P.INACTIVE_YEARS, batch]);
  for (const u of gone) {
    try {
      const r = await withdrawAccount(db, u, { method: 'INACTIVE_1Y', source: 'INACTIVE' });
      if (r.blockers) { out.inactive_kept += 1; console.log(JSON.stringify({ job: 'purge', inactive_kept: u.id, reasons: r.blockers.map((b) => b.code) })); }
      else out.inactive_deleted += 1;
    } catch (e) { console.error(JSON.stringify({ job: 'purge', inactive_user: u.id, error: e.message })); }   // retried tomorrow; the others still run
  }
  return out;
}

/** G-5: one row per operator request to /api/admin/* (reads included) — 고시 §8 접속기록. Others get their 401 / 403 from the route. Never blocks. */
export function adminAccessLogger(db) {
  return async (req, res, next) => {
    if (req.user?.system_role !== 'SYSTEM_ADMIN') return next();
    try {
      await db.run('INSERT INTO admin_access_logs (admin_user_id, method, path, ip, user_agent) VALUES (?,?,?,?,?)',
        [req.user.id, req.method, String(req.originalUrl || req.url).slice(0, 500), String(req.ip || '').slice(0, 64) || null, String(req.get('user-agent') || '').slice(0, 300) || null]);
    } catch (e) { console.error(JSON.stringify({ job: 'admin_access_log', error: e.message })); }
    next();
  };
}
