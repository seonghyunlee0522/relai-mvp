/**
 * 관리자 › 테스트 계정 정리 — one-off purge before launch (founder decision 2026-10-20: every account in production is a test
 * account). Keeps the logged-in operator and every workspace they belong to; deletes every other user and every workspace no
 * kept user belongs to, with all of that workspace's projects and data (FK cascades from workspaces / projects / users).
 *
 *   GET  /api/admin/purge-test-accounts   dry run: the counts of what would be deleted (nothing is written)
 *   POST /api/admin/purge-test-accounts   { confirm: '삭제' } → deletes in ONE transaction + one admin_audit_logs row (counts only)
 *
 * Refused on a Vercel preview deploy (it shares the production database) and above PURGE_MAX_USERS users (safety cap).
 * Rows in KEPT workspaces that point at a deleted user (created_by, owner_user_id, …) are reassigned to the operator when
 * the column is NOT NULL, else set to NULL — found from the FK catalog, so a new table cannot block the purge.
 * Never names an e-mail address: "kept" is only ever the operator's own user id.
 */
import { tx } from './db.js';
import { AdminError, writeAudit } from './admin.js';
import { userFkColumns, NULLABLE_SINCE_56 } from './auth/user-delete.js';

export const PURGE_MAX_USERS = 500;
export const PURGE_CONFIRM = '삭제';

/** [key, label, SQL counting rows that the purge removes] — computed before anything is deleted, so the dry run equals the real run. */
const COUNTS = [
  ['users', '회원', 'SELECT COUNT(*)::int AS n FROM purge_users'],
  ['workspaces', '워크스페이스', 'SELECT COUNT(*)::int AS n FROM purge_ws'],
  ['projects', '프로젝트', 'SELECT COUNT(*)::int AS n FROM projects WHERE workspace_id IN (SELECT id FROM purge_ws)'],
  ['requirements', '요구사항', 'SELECT COUNT(*)::int AS n FROM requirements WHERE project_id IN (SELECT id FROM projects WHERE workspace_id IN (SELECT id FROM purge_ws))'],
  ['wbs_items', 'WBS', 'SELECT COUNT(*)::int AS n FROM wbs_items WHERE project_id IN (SELECT id FROM projects WHERE workspace_id IN (SELECT id FROM purge_ws))'],
  ['test_cases', '테스트 케이스', 'SELECT COUNT(*)::int AS n FROM test_cases WHERE project_id IN (SELECT id FROM projects WHERE workspace_id IN (SELECT id FROM purge_ws))'],
  ['weekly_reports', '주간보고', 'SELECT COUNT(*)::int AS n FROM weekly_reports WHERE project_id IN (SELECT id FROM projects WHERE workspace_id IN (SELECT id FROM purge_ws))'],
  ['invitations', '초대', 'SELECT COUNT(*)::int AS n FROM invitations WHERE workspace_id IN (SELECT id FROM purge_ws)'],
  ['feedback', '의견', 'SELECT COUNT(*)::int AS n FROM feedback WHERE user_id IN (SELECT id FROM purge_users) OR workspace_id IN (SELECT id FROM purge_ws)'],
  ['sessions', '로그인 세션', 'SELECT COUNT(*)::int AS n FROM sessions WHERE user_id IN (SELECT id FROM purge_users)'],
  ['ai_runs', 'AI 실행 기록', 'SELECT COUNT(*)::int AS n FROM ai_runs WHERE workspace_id IN (SELECT id FROM purge_ws) OR user_id IN (SELECT id FROM purge_users)'],
  ['email_deliveries', '메일 발송 기록', 'SELECT COUNT(*)::int AS n FROM email_deliveries WHERE related_user_id IN (SELECT id FROM purge_users) OR workspace_id IN (SELECT id FROM purge_ws)'],
];
export const PURGE_LABELS = Object.fromEntries(COUNTS.map(([k, l]) => [k, l]));

const isPreview = (env) => env.VERCEL_ENV === 'preview';

/** Dry run (commit = false) or the purge itself. Returns { counts, kept: { users, workspaces } }. */
export async function purgeTestAccounts(db, operatorId, { commit = false, env = process.env } = {}) {
  if (isPreview(env)) throw new AdminError(403, 'preview_refused', '미리보기 배포에서는 테스트 계정을 정리할 수 없습니다. 운영 배포에서 실행하세요.');
  return tx(db, async (t) => {
    if (!(await t.get('SELECT 1 FROM users WHERE id = ?', [operatorId]))) throw new AdminError(404, 'not_found', '운영자 계정을 찾을 수 없습니다.');
    const op = `'${String(operatorId).replace(/'/g, "''")}'`;   // CREATE TABLE AS takes no bind parameters; the id comes from the session, quoted
    await t.run(`CREATE TEMP TABLE purge_users ON COMMIT DROP AS SELECT id FROM users WHERE id <> ${op}`);
    await t.run(`CREATE TEMP TABLE purge_ws ON COMMIT DROP AS SELECT w.id FROM workspaces w WHERE w.owner_id <> ${op}
      AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = ${op})`);
    const counts = {};
    for (const [k, , sql] of COUNTS) counts[k] = (await t.get(sql)).n;
    const kept = { users: 1, workspaces: (await t.get('SELECT COUNT(*)::int AS n FROM workspaces WHERE id NOT IN (SELECT id FROM purge_ws)')).n };
    if (counts.users > PURGE_MAX_USERS) throw new AdminError(409, 'too_many_users', `삭제할 회원이 ${counts.users}명으로 안전 한도(${PURGE_MAX_USERS}명)를 넘습니다. 실행하지 않았습니다.`);
    if (!commit) return { counts, kept };

    const PU = 'SELECT id FROM purge_users'; const PW = 'SELECT id FROM purge_ws';
    // Rows that only SET NULL on delete but carry the person or the workspace: remove them outright.
    await t.run(`DELETE FROM feedback WHERE user_id IN (${PU}) OR workspace_id IN (${PW})`);
    await t.run(`DELETE FROM email_deliveries WHERE related_user_id IN (${PU}) OR workspace_id IN (${PW})`);
    await t.run(`DELETE FROM analytics_events WHERE user_id IN (${PU}) OR workspace_id IN (${PW})`);
    await t.run(`DELETE FROM analytics_active_days WHERE user_id IN (${PU})`);
    await t.run(`DELETE FROM billing_events WHERE workspace_id IN (${PW})`);
    await t.run(`DELETE FROM admin_audit_logs WHERE admin_user_id IN (${PU})`);
    // Workspaces no kept user belongs to: projects and everything under them cascade.
    await t.run(`DELETE FROM workspaces WHERE id IN (${PW})`);
    // Kept workspaces owned by a deleted user pass to the operator (already a member, so they become its OWNER).
    await t.run(`UPDATE workspace_members SET role = 'OWNER' WHERE user_id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id IN (${PU}))`, [operatorId]);
    await t.run(`UPDATE workspaces SET owner_id = ? WHERE owner_id IN (${PU})`, [operatorId]);
    // Every other reference to a deleted user in kept data (FKs without ON DELETE action, and plain id columns).
    const refs = (await userFkColumns(t)).filter((r) => r.deltype === 'a' || r.deltype === 'r')   // FKs without ON DELETE action
      .map((r) => ({ ...r, notnull: r.notnull || NULLABLE_SINCE_56.has(`${r.tbl}.${r.col}`) }));   // authors still go to the operator, as before 56
    for (const r of [...refs, { tbl: 'activity_checklist_items', col: 'owner_user_id' }, { tbl: 'test_executions', col: 'performer_user_id' }, { tbl: 'promotions', col: 'updated_by' }]) {
      await t.run(`UPDATE "${r.tbl}" SET "${r.col}" = ${r.notnull ? '?' : 'NULL'} WHERE "${r.col}" IN (${PU})`, r.notnull ? [operatorId] : []);
    }
    await t.run(`DELETE FROM users WHERE id IN (${PU})`);
    await writeAudit(t, { adminUserId: operatorId, action: 'PURGE_TEST_ACCOUNTS', targetType: 'SYSTEM', targetId: 'all', metadata: { counts, kept } });
    return { counts, kept };
  });
}

export function mountAdminPurgeRoutes(app, db, { guard, wrap, fail }) {
  const run = (commit) => wrap(async (req, res) => {
    if (commit && String(req.body?.confirm ?? '').trim() !== PURGE_CONFIRM) return fail(res, 400, 'confirm_required', `확인란에 '${PURGE_CONFIRM}'를 입력해야 실행됩니다.`);
    try {
      const r = await purgeTestAccounts(db, req.user.id, { commit });
      res.json({ ok: true, dry_run: !commit, ...r, labels: PURGE_LABELS, max_users: PURGE_MAX_USERS });
    } catch (e) { if (e instanceof AdminError) return fail(res, e.status, e.code, e.message); throw e; }
  });
  app.get('/api/admin/purge-test-accounts', guard, run(false));
  app.post('/api/admin/purge-test-accounts', guard, run(true));
}
