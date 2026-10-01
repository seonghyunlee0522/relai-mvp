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

/** Tiny in-memory limiter for login/signup brute force. Swap for Redis when scaled out. */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    blocked(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, arr);
      return arr.length >= max;
    },
    hit(key) {
      const arr = hits.get(key) || [];
      arr.push(Date.now());
      hits.set(key, arr);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
