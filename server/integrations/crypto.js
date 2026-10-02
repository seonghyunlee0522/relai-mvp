/**
 * Credential encryption + minimal JWT (HS256) for provider webhooks. No third-party dependencies.
 * - AES-256-GCM, random 96-bit IV, format `v1.<iv>.<tag>.<ciphertext>` (base64url). Key from INTEGRATION_ENCRYPTION_KEY
 *   (32 bytes as hex / base64 / base64url). Outside production a key is derived from SESSION_SECRET so local development
 *   works without extra setup; production refuses to start the integration layer without an explicit key.
 * - Tokens are never logged: callers pass ciphertext around and decrypt only at the HTTP boundary.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export class IntegrationConfigError extends Error { constructor(msg) { super(msg); this.code = 'integration_config'; this.status = 503; } }

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

/**
 * Key material rules:
 *   INTEGRATION_ENCRYPTION_KEY set → must be 64 hex chars, or base64/base64url that decodes to exactly 32 bytes; anything else is a
 *   configuration error in every environment (no silent SHA-256 derivation).
 *   Not set → production: IntegrationConfigError; development/test: key derived from SESSION_SECRET (so local setups work).
 */
export function parseStrictKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const isUrl = /[-_]/.test(s); const isStd = /[+/=]/.test(s);
  if (!(isUrl && isStd) && /^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s, isUrl ? 'base64url' : 'base64');
    if (b.length === 32 && (isUrl ? b.toString('base64url') === s.replace(/=+$/, '') : b.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, ''))) return b;
  }
  throw new IntegrationConfigError('INTEGRATION_ENCRYPTION_KEY는 64자리 hex 또는 32바이트로 디코딩되는 base64/base64url 값이어야 합니다.');
}
let cachedKey = null; let cachedFrom = null;
export function encryptionKey(env = process.env) {
  const raw = String(env.INTEGRATION_ENCRYPTION_KEY || '').trim();
  const prod = env.NODE_ENV === 'production';
  const src = raw ? `key:${raw}` : prod ? '' : `dev:${env.SESSION_SECRET || 'relai-dev'}`;
  if (!src) throw new IntegrationConfigError('INTEGRATION_ENCRYPTION_KEY가 설정되지 않았습니다. (production 필수: 64 hex 또는 32바이트 base64)');
  if (cachedKey && cachedFrom === src) return cachedKey;
  cachedKey = raw ? parseStrictKey(raw) : createHash('sha256').update(src).digest();   // dev fallback only
  cachedFrom = src;
  return cachedKey;
}
/** Startup check (server/index.js): throws IntegrationConfigError when the key is missing (production) or malformed (any env). */
export function assertEncryptionConfig(env = process.env) { encryptionKey(env); return true; }

export function encrypt(plain, env = process.env) {
  if (plain === null || plain === undefined) return null;
  const key = encryptionKey(env); const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
export function decrypt(blob, env = process.env) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', encryptionKey(env), fromB64u(iv));
  d.setAuthTag(fromB64u(tag));
  return Buffer.concat([d.update(fromB64u(ct)), d.final()]).toString('utf8');
}

/* ---------- JWT HS256 via `jose` (Atlassian OAuth 2.0 dynamic webhooks send a bearer JWT signed with the app's client secret) ---------- */
const secretKey = (secret) => new TextEncoder().encode(String(secret));
/** Test helper / symmetric signer. */
export async function signJwt(claims, secret, { alg = 'HS256' } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT' }).sign(secretKey(secret));
}
/**
 * Verifies signature (HS256 only), `exp` and `nbf` (60 s tolerance). No other claim is required: Atlassian does not document
 * iss/aud/qsh for OAuth-app webhooks. Returns the claims or null — never throws, never logs the token.
 */
export async function verifyJwt(token, secret, { clockTolerance = 60 } = {}) {
  if (!token || !secret) return null;
  try { const { payload } = await jwtVerify(String(token), secretKey(secret), { algorithms: ['HS256'], clockTolerance }); return payload; }
  catch { return null; }
}
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 24) => randomBytes(n).toString('base64url');
