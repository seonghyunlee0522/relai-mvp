/**
 * 회원 탈퇴 = hard delete (migration 56, founder 2026-10-20). hardDeleteUser() removes the users row inside the caller's transaction,
 * after the caller's own checks (server/auth/account.js DELETE /api/me: re-auth, sole OWNER, running subscription, operator).
 *
 * Every column that holds a users.id is listed in USER_REFS with what happens to it — never left to an FK ON DELETE action, so a new
 * table cannot silently cascade or block. server/test/user-harddelete.test.js fails when an FK to users is missing from the list.
 *   DELETE  personal data: the rows go (sessions, login methods, tokens, onboarding / guide state, analytics keyed by the user …)
 *   NULL    a work record in a shared workspace outlives its author: the column becomes NULL and reads '탈퇴한 사용자'
 *   ACTOR   history / activity row whose NULL actor also means "system": NULL + withdrawn_actor = true
 *   DETACH  legally retained record: NULL + withdrawn_ref = this withdrawal's pseudonym (no users FK value is left)
 * Retained, with the period purgeRetained() enforces (privacy policy 제3조):
 *   계약·동의 기록 (account_withdrawals)              5 years after the withdrawal
 *   대금결제·주문·환불 (billing_orders, payments of purged workspaces, service_orders)  5 years
 *   불만·분쟁 처리 기록 (feedback)                      3 years
 *   접속 기록 (login_records: 일시·IP)                 3 months (purgeAccountData, every row)
 *   관리자 조치 기록 (admin_audit_logs)                kept, name / e-mail removed
 */
import { randomBytes } from 'node:crypto';

export const WITHDRAWN_USER_NAME = '탈퇴한 사용자';
export const RETENTION = { CONSENT_YEARS: 5, PAYMENT_YEARS: 5, COMPLAINT_YEARS: 3 };

/** [table, column, action]. Columns without an FK (marked) hold a user id too. */
export const USER_REFS = [
  ['sessions', 'user_id', 'DELETE'],
  ['auth_tokens', 'user_id', 'DELETE'],
  ['user_identities', 'user_id', 'DELETE'],
  ['user_onboarding', 'user_id', 'DELETE'],
  ['user_feature_guides', 'user_id', 'DELETE'],
  ['integration_oauth_states', 'user_id', 'DELETE'],
  ['workspace_members', 'user_id', 'DELETE'],
  ['email_deliveries', 'related_user_id', 'DELETE'],
  ['analytics_events', 'user_id', 'DELETE'],          // no FK
  ['analytics_active_days', 'user_id', 'DELETE'],     // no FK
  ['invitations', 'invited_by', 'NULL'],              // still PENDING ones are deleted first (below)
  ['invitations', 'accepted_by', 'NULL'],
  ['workspaces', 'owner_id', 'NULL'],                 // only the closed solo workspaces still point here (shared ones were handed over)
  ['workspaces', 'deleted_by', 'NULL'],
  ['projects', 'created_by', 'NULL'],
  ['project_definitions', 'updated_by', 'NULL'],
  ['project_steps', 'completed_by', 'NULL'],
  ['activity_checklist_items', 'done_by', 'NULL'],
  ['activity_checklist_items', 'created_by', 'NULL'],
  ['activity_checklist_items', 'owner_user_id', 'NULL'],   // no FK
  ['requirements', 'owner_user_id', 'NULL'],
  ['requirements', 'created_by', 'NULL'],
  ['wbs_items', 'owner_user_id', 'NULL'],
  ['wbs_items', 'created_by', 'NULL'],
  ['wbs_dependencies', 'created_by', 'NULL'],
  ['requirement_wbs_links', 'created_by', 'NULL'],
  ['change_requests', 'reviewed_by', 'NULL'],
  ['change_requests', 'created_by', 'NULL'],
  ['change_requests', 'approver_user_id', 'NULL'],
  ['change_request_requirements', 'created_by', 'NULL'],
  ['change_request_wbs_impacts', 'created_by', 'NULL'],
  ['issues', 'owner_user_id', 'NULL'],
  ['issues', 'created_by', 'NULL'],
  ['risks', 'owner_user_id', 'NULL'],
  ['risks', 'created_by', 'NULL'],
  ['raid_links', 'created_by', 'NULL'],
  ['test_cases', 'owner_user_id', 'NULL'],
  ['test_cases', 'created_by', 'NULL'],
  ['test_executions', 'executed_by', 'NULL'],
  ['test_executions', 'performer_user_id', 'NULL'],   // no FK
  ['test_links', 'created_by', 'NULL'],
  ['acceptances', 'created_by', 'NULL'],
  ['acceptance_links', 'created_by', 'NULL'],
  ['weekly_reports', 'created_by', 'NULL'],
  ['comments', 'created_by', 'NULL'],
  ['ai_runs', 'user_id', 'NULL'],
  ['ai_wbs_plans', 'created_by', 'NULL'],
  ['credit_ledger', 'created_by', 'NULL'],
  ['integration_connections', 'connected_by', 'NULL'],
  ['integration_project_mappings', 'created_by', 'NULL'],
  ['integration_entity_links', 'created_by', 'NULL'],
  ['promotions', 'updated_by', 'NULL'],               // no FK
  ['requirement_history', 'changed_by', 'ACTOR'],
  ['wbs_history', 'changed_by', 'ACTOR'],
  ['change_request_history', 'changed_by', 'ACTOR'],
  ['raid_history', 'changed_by', 'ACTOR'],
  ['qa_history', 'changed_by', 'ACTOR'],
  ['phase_transitions', 'changed_by', 'ACTOR'],
  ['integration_activity', 'actor_id', 'ACTOR'],
  ['login_records', 'user_id', 'DETACH'],
  ['feedback', 'user_id', 'DETACH'],
  ['billing_orders', 'user_id', 'DETACH'],
  ['admin_audit_logs', 'admin_user_id', 'DETACH'],
];

/** Author columns that were NOT NULL before migration 56 (schema.sql relaxed them). 테스트 계정 정리 (purge.js) still hands these to the operator. */
export const NULLABLE_SINCE_56 = new Set(['workspaces.owner_id', 'projects.created_by', 'requirements.created_by', 'wbs_items.created_by', 'change_requests.created_by',
  'issues.created_by', 'risks.created_by', 'test_cases.created_by', 'acceptances.created_by', 'weekly_reports.created_by', 'comments.created_by', 'admin_audit_logs.admin_user_id']);

/** Every FK column that references users(id) in the current schema: [{ tbl, col, notnull, deltype }]. Shared with 테스트 계정 정리 (purge.js). */
export const userFkColumns = (db) => db.all(`SELECT cl.relname AS tbl, a.attname AS col, a.attnotnull AS notnull, c.confdeltype AS deltype FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND ns.nspname = current_schema() ORDER BY 1, 2`);

/** JSON records that copied a name: [table, column, id key, name key]. The name is replaced; the dangling id is only a pseudonym now. */
const JSON_NAMES = [
  ['project_definitions', 'go_live', 'by', 'by_name'],
  ['project_definitions', 'handover', 'by', 'by_name'],
  ['acceptances', 'customer_approval', 'recorded_by', 'recorded_by_name'],
];

export const newWithdrawalRef = () => `wd_${randomBytes(12).toString('hex')}`;

/**
 * Delete the users row and handle every reference to it. Runs inside the caller's transaction (db = tx handle). Idempotent: an id that
 * is already gone returns null. source 'BACKFILL' = a pre-56 tombstone (status DEACTIVATED, name / e-mail already replaced).
 * Returns { ref }.
 */
export async function hardDeleteUser(db, userId, { source = 'SELF' } = {}) {
  const u = await db.get('SELECT id, email, name, status, created_at, deleted_at, terms_version, terms_agreed_at, privacy_version, privacy_agreed_at FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!u) return null;
  const ref = newWithdrawalRef();
  const tombstone = u.status === 'DEACTIVATED';   // its name / e-mail were replaced at withdrawal: nothing personal left to copy
  await db.run(`INSERT INTO account_withdrawals (ref, withdrawn_at, signed_up_at, terms_version, terms_agreed_at, privacy_version, privacy_agreed_at, source)
    VALUES (?, COALESCE(?::timestamptz, now()), ?, ?, ?, ?, ?, ?)`, [ref, u.deleted_at, u.created_at, u.terms_version, u.terms_agreed_at, u.privacy_version, u.privacy_agreed_at, source]);

  // Before the generic pass: rows that need the person's data or a narrower rule.
  if (!tombstone) {
    await db.run('UPDATE billing_orders SET buyer_name = COALESCE(buyer_name, ?), buyer_email = COALESCE(buyer_email, ?) WHERE user_id = ?', [u.name, u.email, u.id]);
    await db.run('DELETE FROM email_deliveries WHERE lower(recipient) = ?', [u.email]);
  }
  await db.run(`DELETE FROM invitations WHERE invited_by = ? AND status = 'PENDING'`, [u.id]);
  // An accepted invitation names the address the person joined with.
  await db.run(`UPDATE invitations SET email = ? WHERE accepted_by = ?`, [`${ref}@deleted.invalid`, u.id]);
  await db.run(`UPDATE admin_audit_logs SET metadata = metadata - 'email' - 'name', target_id = ? WHERE target_type = 'USER' AND target_id = ?`, [ref, u.id]);
  for (const [table, col, idKey, nameKey] of JSON_NAMES) {
    await db.run(`UPDATE ${table} SET ${col} = jsonb_set(${col}::jsonb, '{${nameKey}}', to_jsonb(?::text))::text WHERE ${col} <> '{}' AND ${col}::jsonb->>'${idKey}' = ?`, [WITHDRAWN_USER_NAME, u.id]);
  }

  for (const [table, col, action] of USER_REFS) {
    if (action === 'DELETE') await db.run(`DELETE FROM ${table} WHERE ${col} = ?`, [u.id]);
    else if (action === 'NULL') await db.run(`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ?`, [u.id]);
    else if (action === 'ACTOR') await db.run(`UPDATE ${table} SET ${col} = NULL, withdrawn_actor = true WHERE ${col} = ?`, [u.id]);
    else if (action === 'DETACH') await db.run(`UPDATE ${table} SET ${col} = NULL, withdrawn_ref = ? WHERE ${col} = ?`, [ref, u.id]);
  }
  await db.run('DELETE FROM users WHERE id = ?', [u.id]);
  return { ref };
}

/** Migration 56 + safety net: hard-delete every account still kept as a DEACTIVATED tombstone. Idempotent (none left → 0). */
export async function hardDeleteDeactivated(db) {
  const ids = await db.all(`SELECT id FROM users WHERE status = 'DEACTIVATED' ORDER BY deleted_at NULLS FIRST, id`);
  for (const { id } of ids) await hardDeleteUser(db, id, { source: 'BACKFILL' });
  return ids.length;
}

/**
 * Daily (cron /api/cron/purge via purgeAccountData): remove each retained class once its period is over. Login records (3 months)
 * are purged for every row by purgeAccountData itself. Returns counts.
 */
export async function purgeRetained(db) {
  const count = async (sql, p = []) => Number((await db.get(`WITH d AS (${sql} RETURNING 1) SELECT COUNT(*) AS n FROM d`, p)).n);
  const out = {
    withdrawals: await count(`DELETE FROM account_withdrawals WHERE withdrawn_at < now() - (?::int * interval '1 year')`, [RETENTION.CONSENT_YEARS]),
    complaints: await count(`DELETE FROM feedback WHERE withdrawn_ref IS NOT NULL AND created_at < now() - (?::int * interval '1 year')`, [RETENTION.COMPLAINT_YEARS]),
    withdrawn_orders: await count(`DELETE FROM billing_orders WHERE withdrawn_ref IS NOT NULL AND created_at < now() - (?::int * interval '1 year')`, [RETENTION.PAYMENT_YEARS]),
    service_orders: await count(`DELETE FROM service_orders WHERE created_at < now() - (?::int * interval '1 year')`, [RETENTION.PAYMENT_YEARS]),
  };
  // A deleted workspace's tombstone only carries its payments; purged_at is after its last payment, so purged_at + 5 years keeps every one 5 years.
  const due = await db.all(`SELECT id FROM workspaces WHERE status = 'CLOSED' AND purged_at < now() - (?::int * interval '1 year') ORDER BY purged_at LIMIT 50`, [RETENTION.PAYMENT_YEARS]);
  out.workspace_payments = 0;
  for (const { id } of due) {
    try {
      await db.run('DELETE FROM billing_events WHERE workspace_id = ?', [id]);
      await db.run('DELETE FROM workspaces WHERE id = ?', [id]);   // payments, billing_orders, subscriptions (+ events) cascade
      out.workspace_payments += 1;
    } catch (e) { console.error(JSON.stringify({ job: 'purge', workspace: id, error: e.message })); }   // a stray reference: retried tomorrow, the other classes still ran
  }
  return out;
}
