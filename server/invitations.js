/**
 * Invitations — two kinds with separate lifecycles:
 *   WORKSPACE_CREATE  (platform invite, SYSTEM_ADMIN → new customer): accept = create workspace + OWNER membership
 *   WORKSPACE_MEMBER  (OWNER/ADMIN → teammate):                        accept = membership in the existing workspace
 * Tokens: raw token only in the e-mail link; DB holds sha256(secret:token). Resend rotates the token. Accept runs in one
 * transaction with SELECT … FOR UPDATE on the invitation row, so double / concurrent accepts and partial workspace creation
 * cannot happen. E-mail sending happens after commit (email/service.js) and never blocks the invitation itself.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { newToken, sha256 } from './security.js';
import { writeAudit } from './admin.js';
import { emailConfig } from './email/config.js';
import { sendEmail } from './email/service.js';
import { platformInviteEmail, memberInviteEmail } from './email/templates.js';
import { createWorkspaceForOwner, maskEmail, normEmail } from './accounts.js';

export class InviteError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
export const INVITE_TYPES = ['WORKSPACE_CREATE', 'WORKSPACE_MEMBER'];
export const INVITE_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'];
const ROLE_LABEL = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashToken = (token, env = process.env) => sha256(`invite:${env.SESSION_SECRET || ''}:${token}`);
const expiry = (env) => new Date(Date.now() + emailConfig(env).inviteExpiryDays * 864e5).toISOString();
export const inviteLink = (token, env = process.env) => { const base = emailConfig(env).appBaseUrl; if (!base) throw new InviteError(503, 'app_base_url_missing', 'APP_BASE_URL이 설정되지 않아 초대 링크를 만들 수 없습니다.'); return `${base}/invite/${token}`; };
const checkEmail = (email) => { const e = normEmail(email); if (!EMAIL_RE.test(e) || e.length > 254) throw new ValidationError({ email: '이메일 형식을 확인해 주세요.' }); return e; };

/* ---------- reads ---------- */
const COLS = `i.id, i.type, i.workspace_id, i.email, i.role, i.workspace_name, i.invitee_name, i.note, i.status, i.invited_by, i.accepted_by, i.accepted_workspace_id, i.expires_at, i.accepted_at, i.revoked_at, i.last_sent_at, i.created_at, i.updated_at,
  u.name AS invited_by_name, u.email AS invited_by_email, a.name AS accepted_by_name, w.name AS target_workspace_name, w.status AS target_workspace_status,
  (SELECT d.status FROM email_deliveries d WHERE d.invitation_id = i.id ORDER BY d.created_at DESC LIMIT 1) AS last_email_status,
  (SELECT d.error_message_safe FROM email_deliveries d WHERE d.invitation_id = i.id ORDER BY d.created_at DESC LIMIT 1) AS last_email_error`;
const FROM = `FROM invitations i LEFT JOIN users u ON u.id = i.invited_by LEFT JOIN users a ON a.id = i.accepted_by LEFT JOIN workspaces w ON w.id = i.workspace_id`;
/** Effective status: a PENDING row past its expiry reads (and is stored) as EXPIRED. */
const effective = (r) => (r && r.status === 'PENDING' && new Date(r.expires_at) < new Date() ? { ...r, status: 'EXPIRED' } : r);
export async function getInvitation(db, id) { const r = await db.get(`SELECT ${COLS} ${FROM} WHERE i.id = ?`, [id]); return effective(r); }
export async function getByToken(db, token, env = process.env) {
  if (!token || String(token).length > 200) return null;
  const r = await db.get(`SELECT ${COLS} ${FROM} WHERE i.token_hash = ?`, [hashToken(String(token), env)]);
  if (r && r.status === 'PENDING' && new Date(r.expires_at) < new Date()) await db.run(`UPDATE invitations SET status = 'EXPIRED', updated_at = now() WHERE id = ? AND status = 'PENDING'`, [r.id]);
  return effective(r);
}
/** Public landing model — masked e-mail, no ids beyond what the page needs. `me` = the current session user (or null). */
export function publicView(inv, me) {
  if (!inv) return null;
  const base = { type: inv.type, status: inv.status, email_masked: maskEmail(inv.email), expires_at: inv.expires_at, inviter_name: inv.invited_by_name || null,
    workspace_name: inv.type === 'WORKSPACE_CREATE' ? inv.workspace_name : inv.target_workspace_name, role: inv.role, role_label: inv.role ? ROLE_LABEL[inv.role] : null, invitee_name: inv.invitee_name || null };
  if (me) base.me = { logged_in: true, email_matches: normEmail(me.email) === inv.email, name: me.name };
  else base.me = { logged_in: false };
  return base;
}
export async function listInvitations(db, { type = '', status = '', q = '', workspaceId = null, page = 1, size = 50 } = {}) {
  const where = []; const params = [];
  if (type && INVITE_TYPES.includes(type)) { where.push('i.type = ?'); params.push(type); }
  if (workspaceId) { where.push('i.workspace_id = ?'); params.push(workspaceId); }
  if (status && INVITE_STATUSES.includes(status)) { if (status === 'EXPIRED') where.push(`(i.status = 'EXPIRED' OR (i.status = 'PENDING' AND i.expires_at < now()))`); else if (status === 'PENDING') where.push(`(i.status = 'PENDING' AND i.expires_at >= now())`); else { where.push('i.status = ?'); params.push(status); } }
  if (q) { where.push('(i.email ILIKE ? OR i.workspace_name ILIKE ? OR w.name ILIKE ?)'); const l = `%${String(q).replace(/[%_\\]/g, (c) => '\\' + c)}%`; params.push(l, l, l); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) n ${FROM} ${w}`, params)).n;
  const items = (await db.all(`SELECT ${COLS} ${FROM} ${w} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size])).map(effective);
  return { items, total, page, size };
}
export const pendingForWorkspace = (db, workspaceId) => listInvitations(db, { workspaceId, status: 'PENDING', size: 200 }).then((r) => r.items);

/* ---------- e-mail ---------- */
async function deliver(db, inv, token, env = process.env) {
  const cfg = emailConfig(env); const link = inviteLink(token, env);
  const msg = inv.type === 'WORKSPACE_CREATE'
    ? platformInviteEmail({ workspaceName: inv.workspace_name, inviteeName: inv.invitee_name, link, expiresAt: inv.expires_at, support: cfg.supportEmail })
    : memberInviteEmail({ workspaceName: inv.target_workspace_name || inv.workspace_name, inviterName: inv.invited_by_name, roleLabel: ROLE_LABEL[inv.role] || inv.role, link, expiresAt: inv.expires_at, support: cfg.supportEmail });
  const r = await sendEmail(db, { type: inv.type === 'WORKSPACE_CREATE' ? 'PLATFORM_INVITE' : 'WORKSPACE_MEMBER_INVITE', to: inv.email, ...msg, invitationId: inv.id, workspaceId: inv.workspace_id || null }, env);
  await db.run('UPDATE invitations SET last_sent_at = now(), updated_at = now() WHERE id = ?', [inv.id]);
  return r;
}

/* ---------- create ---------- */
async function insertInvite(db, row, env) {
  const token = newToken(); const id = randomUUID();
  await db.run(`INSERT INTO invitations (id, type, workspace_id, email, role, workspace_name, invitee_name, note, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, row.type, row.workspace_id || null, row.email, row.role || null, row.workspace_name || null, row.invitee_name || null, row.note || null, hashToken(token, env), row.invited_by, expiry(env)]);
  return { id, token };
}
const dupError = (e) => (e && e.code === '23505' && /uq_inv_/.test(e.constraint || e.message || ''));

/** SYSTEM_ADMIN → new customer. Any e-mail domain is accepted; an existing RELAI account is fine too (they will log in to accept). */
export async function createPlatformInvite(db, { email, workspaceName, inviteeName = '', note = '' }, admin, env = process.env) {
  const em = checkEmail(email); const ws = String(workspaceName || '').trim();
  if (!ws || ws.length > 100) throw new ValidationError({ workspace_name: 'Workspace 이름을 1~100자로 입력하세요.' });
  const dup = await db.get(`SELECT id FROM invitations WHERE type = 'WORKSPACE_CREATE' AND email = ? AND status = 'PENDING' AND expires_at >= now()`, [em]);
  if (dup) throw new InviteError(409, 'invite_pending', '이미 초대가 진행 중입니다. 재발송을 사용하세요.', { invitation_id: dup.id });
  await db.run(`UPDATE invitations SET status = 'EXPIRED', updated_at = now() WHERE type = 'WORKSPACE_CREATE' AND email = ? AND status = 'PENDING' AND expires_at < now()`, [em]);
  let created;
  try { created = await insertInvite(db, { type: 'WORKSPACE_CREATE', email: em, workspace_name: ws.slice(0, 100), invitee_name: String(inviteeName || '').trim().slice(0, 100), note: String(note || '').trim().slice(0, 500), invited_by: admin.id }, env); }
  catch (e) { if (dupError(e)) throw new InviteError(409, 'invite_pending', '이미 초대가 진행 중입니다. 재발송을 사용하세요.'); throw e; }
  await writeAudit(db, { adminUserId: admin.id, action: 'PLATFORM_INVITE_CREATED', targetType: 'INVITATION', targetId: created.id, metadata: { email: em, workspace_name: ws } });
  const inv = await getInvitation(db, created.id);
  const email_delivery = await deliver(db, inv, created.token, env);   // after the insert — a mail failure leaves the invitation in place
  return { invitation: await getInvitation(db, created.id), email_delivery };
}

/** OWNER → MEMBER/ADMIN, ADMIN → MEMBER (consistent with member_manage: ADMIN manages MEMBER↔ADMIN but never grants OWNER; invites follow the same ceiling). */
export async function createMemberInvite(db, { workspaceId, email, role }, actor, actorRole, env = process.env) {
  const em = checkEmail(email); const r = String(role || 'MEMBER').toUpperCase();
  if (!['MEMBER', 'ADMIN'].includes(r)) throw new ValidationError({ role: '초대 역할은 MEMBER 또는 ADMIN만 가능합니다. OWNER는 멤버 설정에서 역할을 변경해 부여하세요.' });
  if (r === 'ADMIN' && actorRole !== 'OWNER') throw new InviteError(403, 'forbidden', 'ADMIN 초대는 OWNER만 할 수 있습니다.');
  const ws = await db.get('SELECT id, name, status FROM workspaces WHERE id = ?', [workspaceId]);
  if (!ws) throw new InviteError(404, 'not_found', 'Workspace를 찾을 수 없습니다.');
  if (ws.status !== 'ACTIVE') throw new InviteError(403, 'workspace_suspended', '정지된 Workspace에서는 초대할 수 없습니다.');
  const member = await db.get('SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?', [workspaceId, em]);
  if (member) throw new InviteError(409, 'already_member', '이미 Workspace 멤버입니다.');
  const dup = await db.get(`SELECT id FROM invitations WHERE type = 'WORKSPACE_MEMBER' AND workspace_id = ? AND email = ? AND status = 'PENDING' AND expires_at >= now()`, [workspaceId, em]);
  if (dup) throw new InviteError(409, 'invite_pending', '이미 초대가 진행 중입니다. 재발송을 사용하세요.', { invitation_id: dup.id });
  await db.run(`UPDATE invitations SET status = 'EXPIRED', updated_at = now() WHERE type = 'WORKSPACE_MEMBER' AND workspace_id = ? AND email = ? AND status = 'PENDING' AND expires_at < now()`, [workspaceId, em]);
  let created;
  try { created = await insertInvite(db, { type: 'WORKSPACE_MEMBER', workspace_id: workspaceId, email: em, role: r, invited_by: actor.id }, env); }
  catch (e) { if (dupError(e)) throw new InviteError(409, 'invite_pending', '이미 초대가 진행 중입니다. 재발송을 사용하세요.'); throw e; }
  await writeAudit(db, { adminUserId: actor.id, action: 'WORKSPACE_INVITE_CREATED', targetType: 'INVITATION', targetId: created.id, metadata: { email: em, workspace_id: workspaceId, workspace_name: ws.name, role: r }, actorKind: 'USER' });
  const inv = await getInvitation(db, created.id);
  const email_delivery = await deliver(db, inv, created.token, env);
  return { invitation: await getInvitation(db, created.id), email_delivery };
}

/* ---------- resend / revoke ---------- */
/** New token, old one invalid, expiry renewed, mail sent again. */
export async function resendInvite(db, inv, actor, env = process.env) {
  if (inv.status !== 'PENDING' && inv.status !== 'EXPIRED') throw new InviteError(409, 'invite_not_pending', '진행 중인 초대만 재발송할 수 있습니다.');
  if (inv.type === 'WORKSPACE_MEMBER' && inv.target_workspace_status !== 'ACTIVE') throw new InviteError(403, 'workspace_suspended', '정지된 Workspace의 초대는 재발송할 수 없습니다.');
  const token = newToken();
  await db.run(`UPDATE invitations SET token_hash = ?, expires_at = ?, status = 'PENDING', updated_at = now() WHERE id = ?`, [hashToken(token, env), expiry(env), inv.id]);
  await writeAudit(db, { adminUserId: actor.id, action: inv.type === 'WORKSPACE_CREATE' ? 'PLATFORM_INVITE_RESENT' : 'WORKSPACE_INVITE_RESENT', targetType: 'INVITATION', targetId: inv.id, metadata: { email: inv.email }, actorKind: inv.type === 'WORKSPACE_CREATE' ? 'ADMIN' : 'USER' });
  const fresh = await getInvitation(db, inv.id);
  const email_delivery = await deliver(db, fresh, token, env);
  return { invitation: await getInvitation(db, inv.id), email_delivery };
}
export async function revokeInvite(db, inv, actor) {
  if (inv.status !== 'PENDING' && inv.status !== 'EXPIRED') throw new InviteError(409, 'invite_not_pending', '진행 중인 초대만 취소할 수 있습니다.');
  await db.run(`UPDATE invitations SET status = 'REVOKED', revoked_at = now(), updated_at = now() WHERE id = ?`, [inv.id]);
  await writeAudit(db, { adminUserId: actor.id, action: inv.type === 'WORKSPACE_CREATE' ? 'PLATFORM_INVITE_REVOKED' : 'WORKSPACE_INVITE_REVOKED', targetType: 'INVITATION', targetId: inv.id, metadata: { email: inv.email }, actorKind: inv.type === 'WORKSPACE_CREATE' ? 'ADMIN' : 'USER' });
  return getInvitation(db, inv.id);
}

/* ---------- accept (inside the caller's tx) ---------- */
/** Locks the row and validates everything that must hold at acceptance time. Returns the locked row. */
async function lockForAccept(db, invitationId, user) {
  const inv = await db.get('SELECT * FROM invitations WHERE id = ? FOR UPDATE', [invitationId]);
  if (!inv) throw new InviteError(404, 'invite_not_found', '초대를 찾을 수 없습니다.');
  if (inv.status === 'ACCEPTED') throw new InviteError(409, 'invite_accepted', '이미 수락된 초대입니다.');
  if (inv.status === 'REVOKED') throw new InviteError(410, 'invite_revoked', '취소된 초대입니다.');
  if (inv.status === 'EXPIRED' || new Date(inv.expires_at) < new Date()) throw new InviteError(410, 'invite_expired', '만료된 초대입니다. 초대한 사람에게 재발송을 요청하세요.');
  if (!user || user.status !== 'ACTIVE') throw new InviteError(403, 'account_suspended', '정지된 계정은 초대를 수락할 수 없습니다.');
  if (normEmail(user.email) !== inv.email) throw new InviteError(403, 'invite_email_mismatch', '초대받은 이메일 계정으로 로그인해 주세요.', { email_masked: maskEmail(inv.email) });
  return inv;
}
/** WORKSPACE_CREATE: workspace + OWNER + AI account + ACCEPTED, atomically. Returns { workspaceId }. */
export async function acceptWorkspaceCreationInvite(db, invitationId, user) {
  const inv = await lockForAccept(db, invitationId, user);
  if (inv.type !== 'WORKSPACE_CREATE') throw new InviteError(400, 'invite_type', '초대 유형이 올바르지 않습니다.');
  const workspaceId = await createWorkspaceForOwner(db, { ownerId: user.id, name: inv.workspace_name });
  await db.run(`UPDATE invitations SET status = 'ACCEPTED', accepted_by = ?, accepted_at = now(), accepted_workspace_id = ?, updated_at = now() WHERE id = ?`, [user.id, workspaceId, inv.id]);
  await writeAudit(db, { adminUserId: user.id, action: 'PLATFORM_INVITE_ACCEPTED', targetType: 'INVITATION', targetId: inv.id, metadata: { email: inv.email, workspace_id: workspaceId, workspace_name: inv.workspace_name }, actorKind: 'USER' });
  await writeAudit(db, { adminUserId: user.id, action: 'WORKSPACE_CREATED_FROM_INVITE', targetType: 'WORKSPACE', targetId: workspaceId, metadata: { name: inv.workspace_name, invitation_id: inv.id }, actorKind: 'USER' });
  return { workspaceId, type: inv.type };
}
/** WORKSPACE_MEMBER: membership with the invited role + ACCEPTED. Never creates a workspace. */
export async function acceptWorkspaceMemberInvite(db, invitationId, user) {
  const inv = await lockForAccept(db, invitationId, user);
  if (inv.type !== 'WORKSPACE_MEMBER') throw new InviteError(400, 'invite_type', '초대 유형이 올바르지 않습니다.');
  const ws = await db.get('SELECT id, name, status FROM workspaces WHERE id = ?', [inv.workspace_id]);
  if (!ws) throw new InviteError(410, 'workspace_gone', 'Workspace가 더 이상 존재하지 않습니다.');
  if (ws.status !== 'ACTIVE') throw new InviteError(403, 'workspace_suspended', '정지된 Workspace의 초대는 수락할 수 없습니다.');
  const existing = await db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [ws.id, user.id]);
  if (!existing) await db.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)', [ws.id, user.id, inv.role || 'MEMBER']);
  await db.run(`UPDATE invitations SET status = 'ACCEPTED', accepted_by = ?, accepted_at = now(), accepted_workspace_id = ?, updated_at = now() WHERE id = ?`, [user.id, ws.id, inv.id]);
  await writeAudit(db, { adminUserId: user.id, action: 'WORKSPACE_INVITE_ACCEPTED', targetType: 'INVITATION', targetId: inv.id, metadata: { email: inv.email, workspace_id: ws.id, workspace_name: ws.name, role: inv.role }, actorKind: 'USER' });
  return { workspaceId: ws.id, type: inv.type, already_member: Boolean(existing) };
}
export const acceptInvite = (db, inv, user) => (inv.type === 'WORKSPACE_CREATE' ? acceptWorkspaceCreationInvite(db, inv.id, user) : acceptWorkspaceMemberInvite(db, inv.id, user));
