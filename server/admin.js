/**
 * Admin Console service (Phase 10B). Operator-level reads over users / workspaces / usage and the two state
 * changes an operator may make (suspend / reactivate), each written together with its admin_audit_logs row in one
 * transaction. Never touches project content (requirements, tests, documents) — only counts and metadata.
 *
 * System role vs workspace role: `users.system_role` (NONE | SYSTEM_ADMIN) is checked by requireSystemAdmin in
 * app.js; `workspace_members.role` is never consulted here and admin status never grants workspace membership.
 */
import { randomUUID } from 'node:crypto';
import { tx } from './db.js';
import { ValidationError } from './validate.js';
import { DEFAULT_PLAN, PLANS } from './plans.js';
import { workspaceUsage, workspacesNearLimit } from './usage.js';
import { billingDashboard, workspaceSubscription } from './billing-admin.js';

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];
export const WORKSPACE_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'];
export const SYSTEM_ROLES = ['NONE', 'SYSTEM_ADMIN'];
export const AUDIT_ACTIONS = ['SUSPEND_USER', 'REACTIVATE_USER', 'SUSPEND_WORKSPACE', 'REACTIVATE_WORKSPACE'];
export const ACTIVATION = ['REGISTERED', 'WORKSPACE_CREATED', 'PROJECT_CREATED', 'ACTIVE_USER'];
const ACTIVE_WINDOW_DAYS = 14;

export class AdminError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/* ---------- paging / query parsing ---------- */
export function paging(q = {}, { def = 50, max = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const size = Math.min(max, Math.max(1, Number.parseInt(q.size, 10) || def));
  return { page, size, offset: (page - 1) * size };
}
const like = (s) => `%${String(s).replace(/[%_\\]/g, (c) => '\\' + c)}%`;
const oneOf = (v, list) => (v && list.includes(v) ? v : '');

/** Activation state is computed, never stored. */
export const activationOf = (r) => {
  const owned = Number(r.owned_workspaces || 0); const projects = Number(r.projects_created || 0);
  if (!owned && !projects) return 'REGISTERED';
  if (!projects) return 'WORKSPACE_CREATED';
  const recent = r.last_login_at && Date.now() - new Date(r.last_login_at).getTime() < ACTIVE_WINDOW_DAYS * 86400e3;
  return recent ? 'ACTIVE_USER' : 'PROJECT_CREATED';
};

const USER_COLS = `u.id, u.name, u.email, u.status, u.system_role, u.created_at, u.last_login_at, u.suspended_at,
  (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspace_count,
  (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id AND m.role = 'OWNER') AS owned_workspaces,
  (SELECT COUNT(*) FROM projects p WHERE p.created_by = u.id) AS projects_created,
  (SELECT MAX(p.created_at) FROM projects p WHERE p.created_by = u.id) AS last_project_created_at`;
const shapeUser = (r) => ({ ...r, email_verified: null, activation: activationOf(r) });   // email verification does not exist yet → null, not false

/* ---------- users ---------- */
const USER_SORTS = { created: 'u.created_at DESC', last_login: 'u.last_login_at DESC NULLS LAST', name: 'u.name, u.email', email: 'u.email' };
export async function listUsers(db, q = {}) {
  const { page, size, offset } = paging(q);
  const where = []; const params = [];
  if (q.q) { where.push('(u.name ILIKE ? OR u.email ILIKE ?)'); params.push(like(q.q), like(q.q)); }
  const status = oneOf(q.status, USER_STATUSES); if (status) { where.push('u.status = ?'); params.push(status); }
  const role = oneOf(q.system_role, SYSTEM_ROLES); if (role) { where.push('u.system_role = ?'); params.push(role); }
  if (q.since) { where.push('u.created_at >= ?'); params.push(q.since); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) AS n FROM users u ${w}`, params)).n;
  const items = (await db.all(`SELECT ${USER_COLS} FROM users u ${w} ORDER BY ${USER_SORTS[q.sort] || USER_SORTS.created}, u.id LIMIT ? OFFSET ?`, [...params, size, offset])).map(shapeUser);
  return { items, page, size, total };
}
export async function getUser(db, id) {
  const u = await db.get(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`, [id]);
  if (!u) return null;
  const workspaces = await db.all(`SELECT w.id, w.name, w.status, m.role, m.created_at AS joined_at,
      (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status != 'ARCHIVED') AS project_count,
      (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = w.id AND o.role = 'OWNER') AS owner_count
    FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at`, [id]);
  // Basic activity only: logins and project create/archive events (dates + workspace, no project content/names).
  const activity = await db.all(`SELECT 'PROJECT_CREATED' AS type, p.created_at AS at, w.name AS workspace_name FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.created_by = ?
    ORDER BY p.created_at DESC LIMIT 10`, [id]);
  if (u.last_login_at) activity.push({ type: 'LOGIN', at: u.last_login_at, workspace_name: null });
  activity.sort((a, b) => (a.at < b.at ? 1 : -1));
  const audit = await listAudit(db, { target_type: 'USER', target_id: id, size: 20 });
  return {
    user: shapeUser(u),
    workspaces: workspaces.map((w) => ({ ...w, plan: DEFAULT_PLAN, plan_label: PLANS[DEFAULT_PLAN].label, sole_owner: w.role === 'OWNER' && Number(w.owner_count) === 1 })),
    activity: activity.slice(0, 10),
    audit: audit.items,
  };
}

/* ---------- workspaces ---------- */
const WS_COLS = `w.id, w.name, w.status, w.created_at, w.suspended_at,
  o.id AS owner_id, o.name AS owner_name, o.email AS owner_email,
  (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
  (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id AND p.status != 'ARCHIVED') AS project_count,
  GREATEST(w.created_at,
    COALESCE((SELECT MAX(p.updated_at) FROM projects p WHERE p.workspace_id = w.id), w.created_at),
    COALESCE((SELECT MAX(m.created_at) FROM workspace_members m WHERE m.workspace_id = w.id), w.created_at)) AS last_activity_at`;
// "Owner" column = the earliest OWNER member (the creator unless ownership was transferred); the LATERAL join keeps it one query.
const WS_FROM = `FROM workspaces w LEFT JOIN LATERAL (SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
  WHERE m.workspace_id = w.id AND m.role = 'OWNER' ORDER BY m.created_at, u.email LIMIT 1) o ON true`;
const WS_SORTS = { created: 'w.created_at DESC', activity: 'last_activity_at DESC', name: 'w.name', members: 'member_count DESC', projects: 'project_count DESC' };
const shapeWorkspace = (r) => ({ ...r, plan: DEFAULT_PLAN, plan_label: PLANS[DEFAULT_PLAN].label });

export async function listWorkspaces(db, q = {}) {
  const { page, size, offset } = paging(q);
  const where = []; const params = [];
  if (q.q) { where.push('(w.name ILIKE ? OR o.email ILIKE ?)'); params.push(like(q.q), like(q.q)); }
  const status = oneOf(q.status, WORKSPACE_STATUSES); if (status) { where.push('w.status = ?'); params.push(status); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) AS n ${WS_FROM} ${w}`, params)).n;
  const items = (await db.all(`SELECT ${WS_COLS} ${WS_FROM} ${w} ORDER BY ${WS_SORTS[q.sort] || WS_SORTS.created}, w.id LIMIT ? OFFSET ?`, [...params, size, offset])).map(shapeWorkspace);
  return { items, page, size, total };
}
export async function getWorkspace(db, id) {
  const w = await db.get(`SELECT ${WS_COLS} ${WS_FROM} WHERE w.id = ?`, [id]);
  if (!w) return null;
  const members = await db.all(`SELECT u.id, u.name, u.email, u.status, m.role, m.created_at AS joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`, [id]);
  const projects = await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((status = 'ARCHIVED')::int), 0) AS archived, COALESCE(SUM((status != 'ARCHIVED')::int), 0) AS active FROM projects WHERE workspace_id = ?`, [id]);
  const activity = await db.all(`SELECT type, at FROM (
      SELECT 'PROJECT_CREATED' AS type, created_at AS at FROM projects WHERE workspace_id = ?
      UNION ALL SELECT 'PROJECT_ARCHIVED', updated_at FROM projects WHERE workspace_id = ? AND status = 'ARCHIVED'
      UNION ALL SELECT 'MEMBER_JOINED', created_at FROM workspace_members WHERE workspace_id = ?
      UNION ALL SELECT 'WEEKLY_REPORT', wr.created_at FROM weekly_reports wr JOIN projects p ON p.id = wr.project_id WHERE p.workspace_id = ?) x
    ORDER BY at DESC LIMIT 15`, [id, id, id, id]);
  const subscription = await workspaceSubscription(db, id);
  const planKey = subscription?.plan && PLANS[subscription.plan] ? subscription.plan : DEFAULT_PLAN;
  const usage = await workspaceUsage(db, id, planKey);
  const audit = await listAudit(db, { target_type: 'WORKSPACE', target_id: id, size: 20 });
  const owners = members.filter((m) => m.role === 'OWNER');
  return {
    workspace: { ...shapeWorkspace(w), plan: planKey, plan_label: PLANS[planKey].label },
    owners, members, projects,
    subscription,                                   // null until Billing exists
    usage, activity, audit: audit.items,
    warnings: owners.length && owners.every((o) => o.status !== 'ACTIVE') ? ['모든 OWNER 계정이 정지 상태입니다. Workspace를 관리할 수 있는 사용자가 없습니다.'] : [],
  };
}

/* ---------- audit ---------- */
const SUMMARY = {
  SUSPEND_USER: (m) => `사용자 ${m.email || ''} 정지${m.reason ? ` — ${m.reason}` : ''}${m.sole_owner_of?.length ? ` (단독 OWNER Workspace ${m.sole_owner_of.length}개)` : ''}`,
  REACTIVATE_USER: (m) => `사용자 ${m.email || ''} 정지 해제${m.reason ? ` — ${m.reason}` : ''}`,
  SUSPEND_WORKSPACE: (m) => `Workspace '${m.name || ''}' 정지${m.reason ? ` — ${m.reason}` : ''}`,
  REACTIVATE_WORKSPACE: (m) => `Workspace '${m.name || ''}' 정지 해제${m.reason ? ` — ${m.reason}` : ''}`,
};
export const auditSummary = (a) => (SUMMARY[a.action] ? SUMMARY[a.action](a.metadata || {}) : a.action);
export async function writeAudit(db, { adminUserId, action, targetType, targetId, metadata = {} }) {
  const id = randomUUID();
  await db.run('INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, metadata) VALUES (?,?,?,?,?,?)', [id, adminUserId, action, targetType, targetId, JSON.stringify(metadata)]);
  return id;
}
export async function listAudit(db, q = {}) {
  const { page, size, offset } = paging(q);
  const where = []; const params = [];
  const action = oneOf(q.action, AUDIT_ACTIONS); if (action) { where.push('a.action = ?'); params.push(action); }
  if (q.admin) { where.push('(a.admin_user_id = ? OR adm.email ILIKE ?)'); params.push(String(q.admin), like(q.admin)); }
  const tt = oneOf(q.target_type, ['USER', 'WORKSPACE', 'SUBSCRIPTION', 'PAYMENT']); if (tt) { where.push('a.target_type = ?'); params.push(tt); }
  if (q.target_id) { where.push('a.target_id = ?'); params.push(String(q.target_id)); }
  if (q.q) { where.push(`(a.target_id = ? OR a.metadata->>'email' ILIKE ? OR a.metadata->>'name' ILIKE ? OR adm.email ILIKE ?)`); params.push(String(q.q), like(q.q), like(q.q), like(q.q)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM admin_audit_logs a LEFT JOIN users adm ON adm.id = a.admin_user_id';
  const total = (await db.get(`SELECT COUNT(*) AS n ${from} ${w}`, params)).n;
  const rows = await db.all(`SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, a.admin_user_id, adm.name AS admin_name, adm.email AS admin_email
    ${from} ${w} ORDER BY a.created_at DESC, a.seq DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
  return { items: rows.map((a) => ({ ...a, summary: auditSummary(a) })), page, size, total };
}

/* ---------- admin actions (state change + audit in ONE transaction) ---------- */
const reasonOf = (body = {}) => { const r = body.reason === undefined || body.reason === null ? '' : String(body.reason).trim(); if (r.length > 500) throw new ValidationError({ reason: '사유는 500자 이내로 입력해 주세요.' }); return r; };

/** Suspend: status → SUSPENDED, every session of the user deleted (immediate lock-out), audit row. Data untouched. */
export async function suspendUser(db, admin, userId, body) {
  const reason = reasonOf(body);
  if (admin.id === userId) throw new AdminError(400, 'cannot_suspend_self', '자기 자신의 계정은 정지할 수 없습니다.');
  return tx(db, async (t) => {
    const u = await t.get('SELECT id, email, name, status FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!u) throw new AdminError(404, 'not_found', '사용자를 찾을 수 없습니다.');
    if (u.status === 'SUSPENDED') throw new AdminError(409, 'already_suspended', '이미 정지된 사용자입니다.');
    if (u.status === 'DEACTIVATED') throw new AdminError(409, 'deactivated', '탈퇴한 사용자는 정지할 수 없습니다.');
    // Operational warning only: workspaces where this user is the ONLY owner keep their data and are NOT suspended.
    const sole = await t.all(`SELECT w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'OWNER'
      AND (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = w.id AND o.role = 'OWNER') = 1 ORDER BY w.name`, [userId]);
    await t.run(`UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = ?`, [userId]);
    const sessions = (await t.run('DELETE FROM sessions WHERE user_id = ?', [userId])).changes;
    await writeAudit(t, { adminUserId: admin.id, action: 'SUSPEND_USER', targetType: 'USER', targetId: userId, metadata: { email: u.email, name: u.name, reason, sessions_revoked: sessions, sole_owner_of: sole.map((w) => w.name) } });
    return { warnings: sole.map((w) => `'${w.name}' Workspace의 유일한 OWNER입니다. 데이터는 유지되지만 해당 Workspace를 관리할 수 있는 사용자가 없습니다.`), sessions_revoked: sessions };
  });
}
export async function reactivateUser(db, admin, userId, body) {
  const reason = reasonOf(body);
  return tx(db, async (t) => {
    const u = await t.get('SELECT id, email, name, status FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!u) throw new AdminError(404, 'not_found', '사용자를 찾을 수 없습니다.');
    if (u.status !== 'SUSPENDED') throw new AdminError(409, 'not_suspended', '정지 상태의 사용자만 해제할 수 있습니다.');
    await t.run(`UPDATE users SET status = 'ACTIVE', suspended_at = NULL WHERE id = ?`, [userId]);
    await writeAudit(t, { adminUserId: admin.id, action: 'REACTIVATE_USER', targetType: 'USER', targetId: userId, metadata: { email: u.email, name: u.name, reason } });
    return { warnings: [] };
  });
}
/** Workspace suspension policy: members keep their login; every /api/workspaces/:wid/* call is refused (403 workspace_suspended). Data and any subscription untouched. */
export async function suspendWorkspace(db, admin, workspaceId, body) {
  const reason = reasonOf(body);
  return tx(db, async (t) => {
    const w = await t.get('SELECT id, name, status FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
    if (!w) throw new AdminError(404, 'not_found', 'Workspace를 찾을 수 없습니다.');
    if (w.status === 'SUSPENDED') throw new AdminError(409, 'already_suspended', '이미 정지된 Workspace입니다.');
    if (w.status === 'CLOSED') throw new AdminError(409, 'closed', '종료된 Workspace는 정지할 수 없습니다.');
    await t.run(`UPDATE workspaces SET status = 'SUSPENDED', suspended_at = now() WHERE id = ?`, [workspaceId]);
    await writeAudit(t, { adminUserId: admin.id, action: 'SUSPEND_WORKSPACE', targetType: 'WORKSPACE', targetId: workspaceId, metadata: { name: w.name, reason } });
    return { warnings: [] };
  });
}
export async function reactivateWorkspace(db, admin, workspaceId, body) {
  const reason = reasonOf(body);
  return tx(db, async (t) => {
    const w = await t.get('SELECT id, name, status FROM workspaces WHERE id = ? FOR UPDATE', [workspaceId]);
    if (!w) throw new AdminError(404, 'not_found', 'Workspace를 찾을 수 없습니다.');
    if (w.status !== 'SUSPENDED') throw new AdminError(409, 'not_suspended', '정지 상태의 Workspace만 해제할 수 있습니다.');
    await t.run(`UPDATE workspaces SET status = 'ACTIVE', suspended_at = NULL WHERE id = ?`, [workspaceId]);
    await writeAudit(t, { adminUserId: admin.id, action: 'REACTIVATE_WORKSPACE', targetType: 'WORKSPACE', targetId: workspaceId, metadata: { name: w.name, reason } });
    return { warnings: [] };
  });
}

/* ---------- dashboard ---------- */
export async function dashboard(db) {
  const k = await db.get(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE status = 'SUSPENDED') AS suspended_users,
      (SELECT COUNT(*) FROM workspaces WHERE status = 'ACTIVE') AS active_workspaces,
      (SELECT COUNT(*) FROM workspaces WHERE status = 'SUSPENDED') AS suspended_workspaces,
      (SELECT COUNT(*) FROM projects WHERE status != 'ARCHIVED') AS projects,
      (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '7 days') AS signups_7d,
      (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('day', now())) AS signups_today`);
  // Activation funnel over users who signed up in the last 7 days. Signup auto-creates a workspace, so step 2 ≈ step 1 by design.
  const f = await db.get(`SELECT COUNT(*) AS registered,
      COALESCE(SUM((EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.role = 'OWNER'))::int), 0) AS workspace_created,
      COALESCE(SUM((EXISTS (SELECT 1 FROM projects p WHERE p.created_by = u.id))::int), 0) AS project_created
    FROM users u WHERE u.created_at >= now() - interval '7 days'`);
  const suspendedUsers = await db.all(`SELECT id, name, email, suspended_at FROM users WHERE status = 'SUSPENDED' ORDER BY suspended_at DESC NULLS LAST LIMIT 10`);
  const suspendedWs = await db.all(`SELECT id, name, suspended_at FROM workspaces WHERE status = 'SUSPENDED' ORDER BY suspended_at DESC NULLS LAST LIMIT 10`);
  const noOwner = await db.all(`SELECT w.id, w.name FROM workspaces w WHERE w.status = 'ACTIVE' AND NOT EXISTS (
      SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'OWNER' AND u.status = 'ACTIVE') ORDER BY w.name LIMIT 10`);
  const nearLimit = await workspacesNearLimit(db, 90, 10);
  const billing = await billingDashboard(db);
  const recentAudit = (await listAudit(db, { size: 8 })).items;
  return {
    kpis: { users: k.users, active_workspaces: k.active_workspaces, projects: k.projects, signups_7d: k.signups_7d, signups_today: k.signups_today, ...(billing ? billing.kpis : {}) },
    funnel_7d: { registered: f.registered, workspace_created: f.workspace_created, project_created: f.project_created, ...(billing ? { paid: billing.kpis.team_workspaces } : {}) },
    attention: {
      suspended_users: { total: k.suspended_users, items: suspendedUsers },
      suspended_workspaces: { total: k.suspended_workspaces, items: suspendedWs },
      workspaces_without_active_owner: noOwner,
      near_limit: nearLimit,
      ...(billing ? billing.attention : {}),
    },
    billing: { implemented: Boolean(billing) },
    recent_audit: recentAudit,
  };
}
