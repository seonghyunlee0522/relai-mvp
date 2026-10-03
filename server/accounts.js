/**
 * Account primitives shared by direct signup, invitation acceptance and Google sign-in. All functions run inside the
 * caller's transaction (tx) and never create a session — the route layer does that.
 *   createUser            users + PASSWORD/GOOGLE identity (no workspace)
 *   createWorkspaceForOwner  workspaces + OWNER membership + AI credit account (the one place this initialization lives)
 *   createDirectSignupUser   user + personal workspace (existing signup behaviour)
 */
import { randomUUID } from 'node:crypto';
import { ensureAccount } from './ai/credits.js';

export const normEmail = (e) => String(e || '').trim().toLowerCase();
/** p***@acme.co.kr — public invite pages never show the raw address. */
export const maskEmail = (email) => { const [l, d] = String(email || '').split('@'); if (!d) return '***'; return `${l.slice(0, Math.min(2, Math.max(1, l.length - 1)))}***@${d}`; };

export async function createUser(db, { email, name, passwordHash = null, identity = null, emailVerifiedAt = null }) {
  const id = randomUUID();
  await db.run('INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?,?,?,?,?)', [id, normEmail(email), String(name).trim(), passwordHash, emailVerifiedAt]);
  if (passwordHash) await addIdentity(db, { userId: id, provider: 'PASSWORD', subject: id, email: normEmail(email), verified: false });
  if (identity) await addIdentity(db, { userId: id, ...identity });
  return id;
}
export async function addIdentity(db, { userId, provider, subject, email = null, verified = false }) {
  const id = randomUUID();
  await db.run('INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, last_used_at) VALUES (?,?,?,?,?,?,now())', [id, userId, provider, String(subject), email ? normEmail(email) : null, Boolean(verified)]);
  return id;
}
export const touchIdentity = (db, provider, subject) => db.run('UPDATE user_identities SET last_used_at = now() WHERE provider = ? AND provider_subject = ?', [provider, String(subject)]);
export const identitiesOf = (db, userId) => db.all('SELECT provider, email, email_verified, created_at, last_used_at FROM user_identities WHERE user_id = ? ORDER BY created_at', [userId]);

export async function createWorkspaceForOwner(db, { ownerId, name }) {
  const wsId = randomUUID();
  await db.run('INSERT INTO workspaces (id, name, owner_id) VALUES (?,?,?)', [wsId, String(name).trim().slice(0, 100), ownerId]);
  await db.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)', [wsId, ownerId, 'OWNER']);
  await ensureAccount(db, wsId);   // AI credit account (trial / dev starter credits per policy)
  return wsId;
}
/** Direct signup: user + "{name}님의 Workspace". Returns { userId, workspaceId }. */
export async function createDirectSignupUser(db, { email, name, passwordHash = null, identity = null, emailVerifiedAt = null }) {
  const userId = await createUser(db, { email, name, passwordHash, identity, emailVerifiedAt });
  const workspaceId = await createWorkspaceForOwner(db, { ownerId: userId, name: `${String(name).trim()}님의 Workspace` });
  return { userId, workspaceId };
}
