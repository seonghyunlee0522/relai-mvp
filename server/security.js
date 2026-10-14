import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const N = 16384;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), 64, { N: Number(n) });
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Fixed-window rate limiter backed by the `rate_limits` table, so every serverless instance shares one count and a cold
 * start does not reset it. Keys are stored as sha256(name:key) — no raw IPs or e-mail addresses at rest.
 *   blocked(key) → true when the current window already holds `max` hits
 *   hit(key)     → counts one hit (opens a new window when the old one has ended)
 *   reset(key)   → forgets the key (e.g. after a successful login)
 * Expired rows are removed by purgeExpired() (server/maintenance.js).
 */
export function rateLimiter(db, { name, max, windowMs }) {
  if (!db || !name) throw new Error('rateLimiter(db, { name, max, windowMs })');
  const k = (key) => sha256(`${name}:${key}`);
  return {
    async blocked(key) {
      const row = await db.get('SELECT count FROM rate_limits WHERE key = ? AND reset_at > now()', [k(key)]);
      return Boolean(row) && Number(row.count) >= max;
    },
    async hit(key) {
      await db.run(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, now() + (?::double precision * interval '1 millisecond'))
        ON CONFLICT (key) DO UPDATE SET
          count    = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
          reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END`, [k(key), windowMs]);
    },
    async reset(key) {
      await db.run('DELETE FROM rate_limits WHERE key = ?', [k(key)]);
    },
  };
}
