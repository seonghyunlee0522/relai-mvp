/**
 * Google Sign-In (OpenID Connect, authorization code + PKCE).
 *   start    → server-made state + nonce + PKCE verifier stored (hashed / encrypted) in auth_oauth_states, consent URL returned
 *   callback → state lookup (single use, expiry), code exchange, ID token verified with Google's JWKS (RS256, iss, aud, exp) and
 *              the nonce; then the identity is resolved: GOOGLE identity by `sub` → user; else a verified e-mail equal to an
 *              existing RELAI account links the identity to that user; else a new user (direct signup → personal workspace;
 *              invite intent → no personal workspace, the invitation is accepted explicitly afterwards).
 * Google access/refresh tokens are never stored. Only RELAI's own session is created by the route layer.
 * The provider is swappable (fake for tests / INTEGRATION-free local demos); this module never touches Jira's OAuth tables.
 */
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { newToken, sha256 } from './../security.js';
import { encrypt, decrypt } from '../integrations/crypto.js';
import { createUser, createDirectSignupUser, addIdentity, touchIdentity, normEmail } from '../accounts.js';
import { writeAudit } from '../admin.js';

export class GoogleAuthError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const str = (v) => String(v ?? '').trim();
export function googleConfig(env = process.env) {
  const clientId = str(env.GOOGLE_CLIENT_ID); const clientSecret = str(env.GOOGLE_CLIENT_SECRET); const redirectUri = str(env.GOOGLE_REDIRECT_URI);
  return { configured: Boolean(clientId && clientSecret && redirectUri), clientId, clientSecret, redirectUri, scopes: ['openid', 'email', 'profile'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'], stateTtlMs: 10 * 60 * 1000, timeoutMs: 10000, provider: (str(env.GOOGLE_PROVIDER) || 'live').toLowerCase() };
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256b64u = (s) => { return b64u(Buffer.from(sha256(s), 'hex')); };

/* ---------- providers ---------- */
let jwks = null;
export function liveGoogleProvider(cfg, fetchImpl = globalThis.fetch) {
  return {
    name: 'live',
    authorizeUrl: ({ state, nonce, codeChallenge, loginHint }) => {
      const p = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', scope: cfg.scopes.join(' '), redirect_uri: cfg.redirectUri, state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account' });
      if (loginHint) p.set('login_hint', loginHint);
      return `${cfg.authorizeUrl}?${p.toString()}`;
    },
    async exchange({ code, codeVerifier }) {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), cfg.timeoutMs);
      let res; let json = null;
      try { res = await fetchImpl(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }), signal: ac.signal }); json = await res.json().catch(() => null); }
      catch { clearTimeout(t); throw new GoogleAuthError('google_unavailable', 'Google 인증 서버에 연결할 수 없습니다.', 502); }
      clearTimeout(t);
      if (!res.ok || !json?.id_token) throw new GoogleAuthError('google_exchange_failed', 'Google 인증에 실패했습니다. 다시 시도해 주세요.', 400);   // never echo Google's error body (may contain the code)
      return { idToken: json.id_token };
    },
    async verifyIdToken(idToken, { nonce }) {
      jwks = jwks || createRemoteJWKSet(new URL(cfg.jwksUrl));
      let payload;
      try { ({ payload } = await jwtVerify(idToken, jwks, { issuer: cfg.issuers, audience: cfg.clientId, algorithms: ['RS256'], clockTolerance: 60 })); }
      catch { throw new GoogleAuthError('google_id_token_invalid', 'Google 인증 정보를 확인할 수 없습니다.', 401); }
      if (!payload.nonce || payload.nonce !== nonce) throw new GoogleAuthError('google_nonce_mismatch', 'Google 인증 정보를 확인할 수 없습니다. (nonce)', 401);
      return payload;
    },
  };
}
/** Fake Google for tests/dev. An "ID token" is `fake.<base64url(json claims)>`; the fake checks aud/iss/exp/nonce like the live one. */
export function fakeGoogleProvider(cfg = { clientId: 'fake-client' }) {
  const f = { name: 'fake', clientId: cfg.clientId || 'fake-client', codes: new Map(), calls: [],
    mint({ sub, email, email_verified = true, name = 'Google User', nonce, exp, aud, iss = 'https://accounts.google.com', picture = null }) {
      const claims = { iss, aud: aud || f.clientId, sub: String(sub), email, email_verified, name, picture, nonce, iat: Math.floor(Date.now() / 1000), exp: exp ?? Math.floor(Date.now() / 1000) + 3600 };
      return `fake.${b64u(JSON.stringify(claims))}`;
    },
    /** Registers a one-time authorization code that will yield the given ID token claims (nonce filled from the state at exchange time). */
    issueCode(claims) { const code = `code-${randomUUID()}`; f.codes.set(code, claims); return code; },
    // Dev/E2E: a local consent page (mounted by routes.js, never in production) stands in for Google's screen.
    authorizeUrl: ({ state, nonce, codeChallenge, loginHint }) => `/api/_dev/google/consent?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}&cc=${encodeURIComponent(codeChallenge)}${loginHint ? `&login_hint=${encodeURIComponent(loginHint)}` : ''}`,
    async exchange({ code }) { f.calls.push(['exchange', code]); const c = f.codes.get(code); if (!c) throw new GoogleAuthError('google_exchange_failed', 'Google 인증에 실패했습니다. 다시 시도해 주세요.', 400); f.codes.delete(code); return { idToken: c.rawIdToken || f.mint({ ...c, nonce: c.nonce ?? f.pendingNonce }) }; },
    async verifyIdToken(idToken, { nonce }) {
      f.calls.push(['verify']);
      if (!String(idToken).startsWith('fake.')) throw new GoogleAuthError('google_id_token_invalid', 'Google 인증 정보를 확인할 수 없습니다.', 401);
      let p; try { p = JSON.parse(Buffer.from(String(idToken).slice(5), 'base64url').toString('utf8')); } catch { throw new GoogleAuthError('google_id_token_invalid', 'Google 인증 정보를 확인할 수 없습니다.', 401); }
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(p.iss) || p.aud !== f.clientId || !(p.exp > Math.floor(Date.now() / 1000) - 60)) throw new GoogleAuthError('google_id_token_invalid', 'Google 인증 정보를 확인할 수 없습니다.', 401);
      if (!p.nonce || p.nonce !== nonce) throw new GoogleAuthError('google_nonce_mismatch', 'Google 인증 정보를 확인할 수 없습니다. (nonce)', 401);
      return p;
    },
  };
  return f;
}
let override = null;
export function getGoogleProvider(env = process.env) { if (override) return override; const cfg = googleConfig(env); if (cfg.provider === 'fake') { override = fakeGoogleProvider(); return override; } return liveGoogleProvider(cfg); }
export function setGoogleProvider(p) { override = p; }

/* ---------- state ---------- */
const stateHash = (s, env) => sha256(`gstate:${env.SESSION_SECRET || ''}:${s}`);
const nonceHash = (s, env) => sha256(`gnonce:${env.SESSION_SECRET || ''}:${s}`);
/** Creates a pending state. intent: LOGIN | SIGNUP | INVITE (+ invitationId). returnPath is encrypted (it may carry an invite token). */
export async function startGoogleAuth(db, { intent = 'LOGIN', invitationId = null, returnPath = '/app', loginHint = null } = {}, env = process.env) {
  const cfg = googleConfig(env); const p = getGoogleProvider(env);
  if (!cfg.configured && p.name !== 'fake') throw new GoogleAuthError('google_not_configured', 'Google 로그인이 아직 설정되지 않았습니다.', 503);
  const state = newToken(); const nonce = newToken(); const verifier = newToken() + newToken();
  const challenge = sha256b64u(verifier);
  await db.run('DELETE FROM auth_oauth_states WHERE expires_at < now()');
  await db.run('INSERT INTO auth_oauth_states (state_hash, nonce_hash, code_verifier_encrypted, intent, invitation_id, return_path_encrypted, expires_at) VALUES (?,?,?,?,?,?,?)',
    [stateHash(state, env), nonceHash(nonce, env), encrypt(verifier, env), intent, invitationId, encrypt(String(returnPath || '/app'), env), new Date(Date.now() + cfg.stateTtlMs).toISOString()]);
  if (p.name === 'fake') { p.pendingNonce = nonce; p.pendingState = state; }
  return { url: p.authorizeUrl({ state, nonce, codeChallenge: challenge, loginHint }), state };
}

/**
 * Completes the flow. Returns { userId, created, linked, intent, invitationId, returnPath }. Throws GoogleAuthError.
 * `createPersonalWorkspace` (LOGIN/SIGNUP intents) is what makes a brand-new Google user a direct signup; INVITE intent skips it.
 */
export async function finishGoogleAuth(db, { state, code, tx }, env = process.env) {
  const p = getGoogleProvider(env);
  const row = await db.get('SELECT * FROM auth_oauth_states WHERE state_hash = ?', [stateHash(String(state || ''), env)]);
  if (!row) throw new GoogleAuthError('oauth_state_invalid', '인증 요청을 확인할 수 없습니다. 다시 시도해 주세요.');
  await db.run('DELETE FROM auth_oauth_states WHERE state_hash = ?', [row.state_hash]);   // single use
  if (new Date(row.expires_at) < new Date() || row.consumed_at) throw new GoogleAuthError('oauth_state_expired', '인증 요청이 만료되었습니다. 다시 시도해 주세요.');
  const returnPath = row.return_path_encrypted ? decrypt(row.return_path_encrypted, env) : '/app';
  const { idToken } = await p.exchange({ code: String(code || ''), codeVerifier: row.code_verifier_encrypted ? decrypt(row.code_verifier_encrypted, env) : '' });
  // nonce: the raw nonce was never persisted — the (unverified) token's nonce must hash to the stored value, then the signed
  // token is verified against that same nonce, so a token minted for another state can never complete this one.
  const peek = peekClaims(idToken);
  if (!peek || !peek.nonce || nonceHash(String(peek.nonce), env) !== row.nonce_hash) throw new GoogleAuthError('google_nonce_mismatch', 'Google 인증 정보를 확인할 수 없습니다. (nonce)', 401);
  const claims = await p.verifyIdToken(idToken, { nonce: String(peek.nonce) });
  const sub = String(claims.sub || ''); const email = normEmail(claims.email); const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!sub || !email) throw new GoogleAuthError('google_profile_incomplete', 'Google 계정에서 이메일을 확인할 수 없습니다.');
  const name = str(claims.name) || email.split('@')[0];
  const result = await tx(db, async (db) => {
    const ident = await db.get(`SELECT user_id FROM user_identities WHERE provider = 'GOOGLE' AND provider_subject = ?`, [sub]);
    if (ident) { await touchIdentity(db, 'GOOGLE', sub); return { userId: ident.user_id, created: false, linked: false }; }
    const existing = await db.get('SELECT id, email, status FROM users WHERE email = ?', [email]);
    if (existing) {
      if (!verified) throw new GoogleAuthError('google_email_unverified', 'Google 계정의 이메일이 인증되지 않아 기존 계정과 연결할 수 없습니다.', 403);
      if (existing.status !== 'ACTIVE') throw new GoogleAuthError('account_suspended', '정지된 계정입니다. 운영자에게 문의해 주세요.', 403);
      await addIdentity(db, { userId: existing.id, provider: 'GOOGLE', subject: sub, email, verified: true });
      await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = ?', [existing.id]);
      await writeAudit(db, { adminUserId: existing.id, action: 'GOOGLE_IDENTITY_LINKED', targetType: 'USER', targetId: existing.id, metadata: { email }, actorKind: 'USER' });
      return { userId: existing.id, created: false, linked: true };
    }
    if (!verified) throw new GoogleAuthError('google_email_unverified', 'Google 계정의 이메일이 인증되지 않았습니다.', 403);
    const identity = { provider: 'GOOGLE', subject: sub, email, verified: true };
    let userId;
    if (row.intent === 'INVITE') userId = await createUser(db, { email, name, identity, emailVerifiedAt: new Date().toISOString() });   // the invitation decides the workspace
    else ({ userId } = await createDirectSignupUser(db, { email, name, identity, emailVerifiedAt: new Date().toISOString() }));
    await writeAudit(db, { adminUserId: userId, action: 'USER_CREATED', targetType: 'USER', targetId: userId, metadata: { email, method: 'GOOGLE', intent: row.intent }, actorKind: 'USER' });
    return { userId, created: true, linked: false };
  });
  return { ...result, intent: row.intent, invitationId: row.invitation_id, returnPath };
}
/** Reads claims without verifying — only used to find the nonce before the real verification. */
function peekClaims(idToken) {
  try { const s = String(idToken); if (s.startsWith('fake.')) return JSON.parse(Buffer.from(s.slice(5), 'base64url').toString('utf8')); const parts = s.split('.'); if (parts.length !== 3) return null; return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}
