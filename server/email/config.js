/** E-mail configuration. Links are always built from APP_BASE_URL — never from a request Host header. */
const str = (v) => String(v ?? '').trim();
export class EmailConfigError extends Error { constructor(msg) { super(msg); this.code = 'email_config'; } }
export function emailConfig(env = process.env) {
  const provider = (str(env.EMAIL_PROVIDER) || (env.NODE_ENV === 'production' ? 'resend' : 'fake')).toLowerCase();
  const appBaseUrl = str(env.APP_BASE_URL).replace(/\/+$/, '');
  return {
    provider, resendApiKey: str(env.RESEND_API_KEY), from: str(env.EMAIL_FROM) || 'RELAI <no-reply@relai.local>', supportEmail: str(env.SUPPORT_EMAIL) || '',
    appBaseUrl, inviteExpiryDays: Number(env.INVITE_EXPIRY_DAYS) > 0 ? Number(env.INVITE_EXPIRY_DAYS) : 7,
    timeoutMs: Number(env.EMAIL_HTTP_TIMEOUT_MS) > 0 ? Number(env.EMAIL_HTTP_TIMEOUT_MS) : 10000,
  };
}
/** Production sanity: provider configured, https base URL. Throws EmailConfigError. */
export function assertEmailConfig(env = process.env) {
  const c = emailConfig(env);
  if (env.NODE_ENV !== 'production') return c;
  if (!c.appBaseUrl) throw new EmailConfigError('APP_BASE_URL이 설정되지 않았습니다. (초대 메일 링크의 기준 URL)');
  if (!/^https:\/\//.test(c.appBaseUrl)) throw new EmailConfigError('APP_BASE_URL은 production에서 https URL이어야 합니다.');
  if (c.provider === 'resend' && !c.resendApiKey) throw new EmailConfigError('EMAIL_PROVIDER=resend에는 RESEND_API_KEY가 필요합니다.');
  if (!['resend', 'fake'].includes(c.provider)) throw new EmailConfigError(`알 수 없는 EMAIL_PROVIDER: ${c.provider}`);
  return c;
}
