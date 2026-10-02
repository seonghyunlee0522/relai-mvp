/**
 * Credential encryption + minimal JWT (HS256) for provider webhooks. No third-party dependencies.
 * - AES-256-GCM, random 96-bit IV, format `v1.<iv>.<tag>.<ciphertext>` (base64url). Key from INTEGRATION_ENCRYPTION_KEY
 *   (32 bytes as hex / base64 / base64url). Outside production a key is derived from SESSION_SECRET so local development
 *   works without extra setup; production refuses to start the integration layer without an explicit key.
 * - Tokens are never logged: callers pass ciphertext around and decrypt only at the HTTP boundary.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class IntegrationConfigError extends Error { constructor(msg) { super(msg); this.code = 'integration_config'; this.status = 503; } }

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, s.includes('-') || s.includes('_') ? 'base64url' : 'base64');
  if (b.length === 32) return b;
  return createHash('sha256').update(s).digest();   // any other secret string → derived 32-byte key
}

let cachedKey = null; let cachedFrom = null;
export function encryptionKey(env = process.env) {
  const raw = env.INTEGRATION_ENCRYPTION_KEY || '';
  const src = raw || (env.NODE_ENV === 'production' ? '' : `dev:${env.SESSION_SECRET || 'relai-dev'}`);
  if (!src) throw new IntegrationConfigError('INTEGRATION_ENCRYPTION_KEY가 설정되지 않았습니다.');
  if (cachedKey && cachedFrom === src) return cachedKey;
  cachedKey = parseKey(src); cachedFrom = src;
  return cachedKey;
}

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

/* ---------- JWT HS256 (Atlassian OAuth webhooks are bearer JWTs signed with the app's client secret) ---------- */
export function signJwt(claims, secret, { alg = 'HS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, typ: 'JWT' })); const p = b64u(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
/** Returns the claims or null. Checks: structure, HS256 signature (constant time), exp/nbf when present. */
export function verifyJwt(token, secret, { now = Date.now() } = {}) {
  if (!token || !secret) return null;
  const parts = String(token).split('.'); if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header; let claims;
  try { header = JSON.parse(fromB64u(h).toString('utf8')); claims = JSON.parse(fromB64u(p).toString('utf8')); } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;
  const expect = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let got; try { got = fromB64u(sig); } catch { return null; }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  const t = Math.floor(now / 1000);
  if (typeof claims.exp === 'number' && claims.exp < t - 60) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > t + 60) return null;
  return claims;
}
export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 24) => randomBytes(n).toString('base64url');
