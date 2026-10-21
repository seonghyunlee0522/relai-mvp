/**
 * 요구사항 확정 확인 (02 BASELINE_APPROVAL) — a 진행 여부 체크 since 2026-10-21 (승인 절차 제거; was 요구사항 기준선 승인).
 *
 * Storage: project_definitions.req_approval (same shape as `approval`: checked · note · checked_by/_name/_at, plus the legacy
 * approver/date/method/evidence of records made before). The check is the REQUIREMENTS step BASELINE_APPROVAL in project_steps,
 * so What's Next, the LNB and the phase list read one source.
 *
 * 체크 = step COMPLETED (+ optional confirm_unconfirmed: every in-scope requirement that is not CONFIRMED becomes CONFIRMED through
 * the same update path as the bulk API). Nothing is required and nothing blocks the next phase.
 */
import { ValidationError } from './validate.js';
import { updateStep } from './guide.js';
import * as D from './definition.js';
import * as R from './requirements.js';

export const STEP_KEY = 'BASELINE_APPROVAL';
const parse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
const n = (v) => Number(v) || 0;

async function baselineStep(db, projectId) {
  return db.get(`SELECT s.*, u.name AS completed_by_name FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id LEFT JOIN users u ON u.id = s.completed_by
    WHERE p.project_id = ? AND p.phase_key = 'REQUIREMENTS' AND s.step_key = ?`, [projectId, STEP_KEY]);
}

/** One-line state for the activity row / Drawer header: "✓ 확인 · 홍길동 · 2026-11-20 · 메모" ('' while unchecked). */
export function baselineSummary(m) {
  return D.checkSummary(m.status === 'COMPLETED', { completed_at: m.completed_at, completed_by_name: m.completed_by_name }, m.approval);
}

/** Read model for the Drawer, guidance, activity row and the 요구사항 정의서. */
export async function loadBaseline(db, project, { stats = null } = {}) {
  const def = await db.get('SELECT req_approval, stakeholders FROM project_definitions WHERE project_id = ?', [project.id]);
  const approval = D.approvalOf(def ? parse(def.req_approval, {}) : {});
  const stakeholders = def ? parse(def.stakeholders, []) : [];
  const st = await baselineStep(db, project.id);
  const approver = D.approverOf({ stakeholders }, approval);
  const s = stats || (await R.requirementStats(db, project.id));
  const status = st && st.status === 'COMPLETED' ? 'COMPLETED' : 'TODO';
  const m = { step_id: st ? st.id : null, status, completed_at: st ? st.completed_at : null, completed_by_name: st ? st.completed_by_name : null,
    approval, approver, method_label: D.REQ_APPROVAL_METHODS[approval.method] || '', methods: D.REQ_APPROVAL_METHODS,
    bypass: null, missing: [], checked: status === 'COMPLETED',   // 진행 여부 체크 (2026-10-21): nothing required, no "[승인 전 진행]" reason
    counts: { total: n(s.total), in_scope: n(s.in_scope), in_scope_confirmed: n(s.in_scope_confirmed), in_scope_unconfirmed: n(s.in_scope) - n(s.in_scope_confirmed), out_of_scope: n(s.out_of_scope) },
    stakeholders: stakeholders.filter((x) => x && x.name).map(({ id, org_type, org, department, name, role }) => ({ id, org_type, org, department, name, role })) };
  m.summary = baselineSummary(m);
  return m;
}

/** Save the check's note (and any legacy fields sent). who/when are stamped by D.stampCheck. */
export async function saveBaseline(db, project, body = {}, userId = null) {
  if (!body || body.approval === undefined) throw new ValidationError({ approval: '저장할 내용이 없습니다.' });
  const { add_to_stakeholders: addSh, ...sent } = D.cleanApproval(body.approval, D.REQ_APPROVAL_METHODS);
  await D.ensureRow(db, project.id, userId);
  const raw = parse((await db.get('SELECT req_approval FROM project_definitions WHERE project_id = ?', [project.id])).req_approval, {});
  const a = await D.stampCheck(db, D.approvalOf(raw), { ...raw, ...sent }, userId);
  if (!a.approver_id && a.approver_name && addSh && sent.approver_name !== undefined) {
    const sh = D.approverStakeholder(project, a, '요구사항 확정 승인');
    await D.appendStakeholder(db, project, sh, userId); a.approver_id = sh.id;
  }
  if (a.approver_id) { a.approver_name = ''; a.approver_title = ''; }
  await db.run('UPDATE project_definitions SET req_approval = ?, updated_by = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify(a), userId, new Date().toISOString(), project.id]);
}

/**
 * complete | reopen. complete may carry { approval, confirm_unconfirmed } so one click saves, confirms and completes.
 * Errors: not_found (no step — project without the 02 activity).
 */
export async function setBaselineStatus(db, project, action, userId, body = null) {
  const st = await baselineStep(db, project.id);
  if (!st) return { error: 'not_found' };
  // 진행 여부 체크 (2026-10-21): complete = 체크, reopen = 체크 해제. Never refused; 범위 내 미확정 are confirmed only when asked.
  if (action === 'reopen') { await saveBaseline(db, project, { approval: { ...(body && body.approval), checked: false } }, userId); await updateStep(db, project, st.id, { status: 'TODO' }, userId); return { ok: true }; }
  await saveBaseline(db, project, { approval: { ...(body && body.approval), checked: true } }, userId);
  const open = body && body.confirm_unconfirmed ? await db.all(`SELECT * FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status NOT IN ('CONFIRMED','REJECTED') ORDER BY sequence_number`, [project.id]) : [];
  for (const r of open) await R.updateRequirement(db, project, r, { status: 'CONFIRMED' }, userId);   // same per-row update + history as the bulk API
  await updateStep(db, project, st.id, { status: 'COMPLETED' }, userId);
  return { ok: true, confirmed: open.length };
}
