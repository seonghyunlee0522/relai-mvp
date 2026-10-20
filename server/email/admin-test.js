/**
 * Operator e-mail check (관리자 › 연동 › 이메일 발송 테스트). Mounted inside mountAdminRoutes, so every route already runs
 * requireAuth → requireSystemAdmin (401 / 403).
 *   GET  /api/admin/email/status  provider, sender, whether RESEND_API_KEY is set (yes/no — never the value), sender domain
 *   POST /api/admin/email/test    { to } → one test mail through Resend, whatever EMAIL_PROVIDER says, so the sender domain can
 *                                 be verified before production is switched to EMAIL_PROVIDER=resend.
 * Limits: one well-formed recipient, 5 sends per operator per 10 minutes (shared rate_limits table). Every attempt that reaches
 * Resend writes one EMAIL_TEST audit row (to, result). Resend's own error text and the key never reach the response or a log.
 */
import { randomUUID } from 'node:crypto';
import { emailConfig, DEFAULT_EMAIL_FROM } from './config.js';
import { resendProvider, redactSecrets } from './provider.js';
import { rateLimiter } from '../security.js';
import { writeAudit } from '../admin.js';

export const EMAIL_TEST_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

let fetchOverride = null;
/** Tests: route the Resend call through a mock fetch (null restores globalThis.fetch). */
export function setEmailTestFetch(fn) { fetchOverride = fn; }

const domainOf = (from) => { const m = /@([^\s>]+)>?\s*$/.exec(String(from || '')); return m ? m[1].toLowerCase() : ''; };

/** Single recipient address check: 254 chars max, no whitespace / control characters (CR/LF header injection), no lists. */
export function validateTestRecipient(raw) {
  if (typeof raw !== 'string') return '받는 주소를 입력하세요.';
  const to = raw.trim();
  if (!to) return '받는 주소를 입력하세요.';
  if (to.length > 254) return '받는 주소가 너무 깁니다. (최대 254자)';
  if (/[\u0000-\u001f\u007f]/.test(to)) return '받는 주소에 줄바꿈이나 제어 문자를 넣을 수 없습니다.';
  if (/[,;\s<>()"]/.test(to) || (to.match(/@/g) || []).length !== 1) return '받는 주소는 한 개만 입력하세요. (예: name@example.com)';
  const [local, domain] = to.split('@');
  if (!local || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || /^\.|\.$|\.\./.test(local)) return '받는 주소 형식이 올바르지 않습니다.';
  if (!/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain)) return '받는 주소 형식이 올바르지 않습니다.';
  return null;
}

/** What the card shows. No secret: the key is reported only as present / absent. */
export function emailStatus(env = process.env) {
  const c = emailConfig(env);
  return { provider: c.provider, from: c.from, from_is_default: !String(env.EMAIL_FROM ?? '').trim(), default_from: DEFAULT_EMAIL_FROM, key_present: Boolean(c.resendApiKey), domain: domainOf(c.from) };
}

/** EmailSendError code → stable API code. */
const CODE = { http_401: 'resend_key_invalid', http_403: 'resend_domain_not_verified', http_400: 'resend_invalid', http_422: 'resend_invalid', http_429: 'resend_rate_limited', timeout: 'resend_timeout', network: 'resend_network' };

export function mountAdminEmailTestRoutes(app, db, { guard, wrap, fail }) {
  const limiter = rateLimiter(db, { name: 'admin_email_test', ...EMAIL_TEST_LIMIT });

  app.get('/api/admin/email/status', guard, wrap(async (req, res) => res.json(emailStatus())));

  app.post('/api/admin/email/test', guard, wrap(async (req, res) => {
    const bad = validateTestRecipient(req.body?.to);
    if (bad) return fail(res, 400, 'invalid_recipient', bad);
    const to = req.body.to.trim();
    // Rate limit first (review P2-3): attempts with the key missing count too, so the audit counts stay clean.
    if (await limiter.blocked(req.user.id)) return fail(res, 429, 'rate_limited', '테스트 메일은 10분에 5번까지 보낼 수 있습니다. 잠시 후 다시 시도하세요.');
    await limiter.hit(req.user.id);
    const cfg = emailConfig();
    if (!cfg.resendApiKey) return fail(res, 400, 'resend_key_missing', 'RESEND_API_KEY가 설정되지 않았습니다. Vercel 환경 변수에 키를 추가한 뒤 다시 시도하세요.');

    const provider = resendProvider(cfg, fetchOverride || globalThis.fetch);
    let sent = null; let err = null;
    try {
      sent = await provider.send({ to, subject: '[RELAI] 이메일 발송 테스트',
        text: `RELAI 이메일 발송 테스트입니다.\n발신: ${cfg.from}\n이 메일을 받았다면 발신 도메인 설정이 정상입니다.`,
        html: `<p>RELAI 이메일 발송 테스트입니다.</p><p>이 메일을 받았다면 발신 도메인 설정이 정상입니다.</p>`, tags: ['ADMIN_EMAIL_TEST'] });
    } catch (e) { err = e; }

    const result = err ? 'FAILED' : 'SENT';
    const code = err ? (CODE[err.code] || (/^http_5\d\d$/.test(err.code || '') ? 'resend_server_error' : 'resend_failed')) : null;
    const message = err ? redactSecrets(err.message || '메일 발송에 실패했습니다.', cfg.resendApiKey).slice(0, 200) : null;
    await writeAudit(db, { adminUserId: req.user.id, action: 'EMAIL_TEST', targetType: 'EMAIL', targetId: sent?.id || randomUUID(),
      metadata: { to, result, provider: 'resend', from: cfg.from, ...(code ? { error_code: code } : {}) } });

    if (err) return fail(res, 502, code, message, { result });
    return res.json({ ok: true, result, to, from: cfg.from, provider_message_id: sent?.id || null, message: `테스트 메일을 보냈습니다: ${to} — 받은편지함(스팸함 포함)을 확인하세요.` });
  }));
}
