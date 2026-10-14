import { assertEncryptionConfig } from './integrations/crypto.js';
import { assertEmailConfig } from './email/config.js';

/** Startup config gate shared by every entry (server/index.js, api/index.js). Throws on a config that must not serve traffic. */
export function assertStartupConfig(env = process.env) {
  if (env.NODE_ENV === 'production' && !String(env.SESSION_SECRET || '').trim()) throw new Error('SESSION_SECRET is required in production');
  assertEncryptionConfig(env);
  const email = assertEmailConfig(env);
  if (env.NODE_ENV === 'production' && email.provider === 'fake') console.warn('[config] EMAIL_PROVIDER=fake in production: invitation e-mails are NOT delivered');
}
