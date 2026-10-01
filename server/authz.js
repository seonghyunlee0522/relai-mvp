/**
 * Workspace role policy (Phase 10 groundwork). Roles live on workspace_members.role and are loaded by requireMember into req.role.
 *
 *   OWNER  — everything: members, settings, billing (Phase 10), subscription cancel, workspace delete
 *   ADMIN  — projects (create/edit/archive), members, general settings; no billing, no workspace delete
 *   MEMBER — project work (requirements, WBS, changes, issues, tests, reports …); no member/settings/billing
 *
 * There is no per-project permission model: every workspace member can work inside every project of the workspace.
 */
export const ROLES = ['OWNER', 'ADMIN', 'MEMBER'];
export const POLICY = {
  project_manage: ['OWNER', 'ADMIN'],      // create / edit / archive projects
  member_manage: ['OWNER', 'ADMIN'],       // add / remove members, change MEMBER↔ADMIN
  owner_grant: ['OWNER'],                  // grant or revoke the OWNER role (ownership transfer)
  workspace_settings: ['OWNER', 'ADMIN'],  // rename etc.
  billing: ['OWNER'],                      // Phase 10: upgrade, payment method, cancel, resume, plan change
  workspace_delete: ['OWNER'],
};

/** Express middleware factory. Must run after requireMember (needs req.role). 403 keeps the workspace visible (the caller IS a member). */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.role) return res.status(401).json({ error: { code: 'unauthenticated', message: '로그인이 필요합니다.' } });
  if (!roles.includes(req.role)) return res.status(403).json({ error: { code: 'forbidden', message: '이 작업을 할 권한이 없습니다.', required: roles } });
  next();
};
export const requireAction = (action) => requireRole(...POLICY[action]);
export const requireOwner = () => requireRole('OWNER');
export const can = (role, action) => (POLICY[action] || []).includes(role);

/* ---------- member management (service; caller wraps in tx) ---------- */
export async function listMembers(db, workspaceId) {
  return db.all(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`, [workspaceId]);
}
export async function ownerCount(db, workspaceId) {
  return (await db.get(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'OWNER'`, [workspaceId])).n;
}
/** Add an existing user by email. Returns { error } for unknown user / already a member. */
export async function addMember(db, workspaceId, email, role, actorRole) {
  if (!ROLES.includes(role)) return { error: 'bad_role' };
  if (role === 'OWNER' && !can(actorRole, 'owner_grant')) return { error: 'owner_only' };
  const user = await db.get('SELECT id, name, email FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
  if (!user) return { error: 'user_not_found' };
  if (await db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, user.id])) return { error: 'already_member' };
  await db.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)', [workspaceId, user.id, role]);
  return { user };
}
/** Change a member's role. The last OWNER can never be demoted; granting/revoking OWNER needs an OWNER actor. */
export async function changeRole(db, workspaceId, userId, role, actorRole) {
  if (!ROLES.includes(role)) return { error: 'bad_role' };
  const m = await db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? FOR UPDATE', [workspaceId, userId]);
  if (!m) return { error: 'not_member' };
  if ((role === 'OWNER' || m.role === 'OWNER') && !can(actorRole, 'owner_grant')) return { error: 'owner_only' };
  if (m.role === 'OWNER' && role !== 'OWNER' && (await ownerCount(db, workspaceId)) <= 1) return { error: 'last_owner' };
  if (m.role === role) return { ok: true, unchanged: true };
  await db.run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [role, workspaceId, userId]);
  return { ok: true };
}
/** Remove a member. The last OWNER cannot be removed; removing an OWNER needs an OWNER actor. */
export async function removeMember(db, workspaceId, userId, actorRole) {
  const m = await db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? FOR UPDATE', [workspaceId, userId]);
  if (!m) return { error: 'not_member' };
  if (m.role === 'OWNER' && !can(actorRole, 'owner_grant')) return { error: 'owner_only' };
  if (m.role === 'OWNER' && (await ownerCount(db, workspaceId)) <= 1) return { error: 'last_owner' };
  await db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
  return { ok: true };
}
