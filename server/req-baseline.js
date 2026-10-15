/**
 * 요구사항 기준선 승인 (02 BASELINE_APPROVAL, Phase 2 US-1) — the 01 착수 결과 승인 record reused for the requirement baseline.
 *
 * Storage: project_definitions.req_approval (same shape as `approval`: approver_id | approver_name/title, date, method, evidence,
 * conditions). Completion is the REQUIREMENTS step BASELINE_APPROVAL in project_steps, so What's Next, the LNB and the phase gate
 * read one source. Validation, approver resolution and the "직접 입력 → 이해관계자에도 추가" rule are definition.js's shared helpers.
 *
 * 완료 처리 = 승인 기록 + (선택) 범위 내 미확정 일괄 확정, one transaction: with confirm_unconfirmed (기본 ON) every in-scope
 * requirement that is not CONFIRMED becomes CONFIRMED through the same update path as the bulk API (one history row each), so CONFIRM
 * (derived from data) completes with it. Without it and with unconfirmed left → 400, nothing saved.
 * No change detection after approval (spec OUT): later edits to confirmed requirements go through the US-3 change-request prompt.
 * "[승인 전 진행] 사유 · 날짜 · 이름" lines in the step note (02→03 dialog) are read with the 01 parser.
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

/** One-line state for the activity row / Drawer header: "이수진 차장 · 2026-11-20 · 이메일 회신" or "승인 전 진행 · 사유 있음". */
export function baselineSummary(m) {
  if (m.status !== 'COMPLETED' && m.bypass) return '승인 전 진행 · 사유 있음';
  const a = m.approval; const who = m.approver; const parts = [];
  if (who) parts.push(`${who.name}${who.title ? ` ${who.title}` : ''}`); if (a.date) parts.push(a.date); if (a.method) parts.push(D.REQ_APPROVAL_METHODS[a.method]);
  return parts.join(' · ');
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
    bypass: status === 'COMPLETED' ? null : D.parseBypass(st && st.note), missing: D.approvalMissing(approval, approver),
    counts: { total: n(s.total), in_scope: n(s.in_scope), in_scope_confirmed: n(s.in_scope_confirmed), in_scope_unconfirmed: n(s.in_scope) - n(s.in_scope_confirmed), out_of_scope: n(s.out_of_scope) },
    stakeholders: stakeholders.filter((x) => x && x.name).map(({ id, org_type, org, department, name, role }) => ({ id, org_type, org, department, name, role })) };
  m.summary = baselineSummary(m);
  return m;
}

/** Partial save (임시저장). Direct-entry approver + 이해관계자에도 추가 → a CLIENT stakeholder linked as approver (01 rule). */
export async function saveBaseline(db, project, body = {}, userId = null) {
  if (!body || body.approval === undefined) throw new ValidationError({ approval: '저장할 내용이 없습니다.' });
  const { add_to_stakeholders: addSh, ...a } = D.cleanApproval(body.approval, D.REQ_APPROVAL_METHODS);
  if (!a.approver_id && a.approver_name && addSh) {
    const sh = D.approverStakeholder(project, a, '요구사항 확정 승인');
    await D.appendStakeholder(db, project, sh, userId); a.approver_id = sh.id;
  }
  if (a.approver_id) { a.approver_name = ''; a.approver_title = ''; }
  await D.ensureRow(db, project.id, userId);
  await db.run('UPDATE project_definitions SET req_approval = ?, updated_by = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify(a), userId, new Date().toISOString(), project.id]);
}

/**
 * complete | reopen. complete may carry { approval, confirm_unconfirmed } so one click saves, confirms and completes.
 * Errors: not_found (no step — project without the 02 activity), ValidationError (missing fields / unconfirmed left).
 */
export async function setBaselineStatus(db, project, action, userId, body = null) {
  const st = await baselineStep(db, project.id);
  if (!st) return { error: 'not_found' };
  if (action === 'reopen') { await updateStep(db, project, st.id, { status: 'TODO' }, userId); return { ok: true }; }
  if (body && body.approval !== undefined) await saveBaseline(db, project, body, userId);
  const m = await loadBaseline(db, project);
  if (m.missing.length) throw new ValidationError({ section: m.missing[0], missing: m.missing.join('\n') });
  if (!m.counts.in_scope) throw new ValidationError({ section: '아직 범위 내 요구사항이 없습니다. 요구사항을 등록하고 범위 내로 분류한 뒤 승인을 기록하세요.' });   // no empty baseline (Q6-2)
  const open = await db.all(`SELECT * FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' AND status NOT IN ('CONFIRMED','REJECTED') ORDER BY sequence_number`, [project.id]);
  if (open.length) {
    if (!(body && body.confirm_unconfirmed)) throw new ValidationError({ section: `범위 내 미확정 ${open.length}건이 있습니다. 먼저 확정하세요.`, unconfirmed: String(open.length) });
    for (const r of open) await R.updateRequirement(db, project, r, { status: 'CONFIRMED' }, userId);   // same per-row update + history as the bulk API
  }
  await updateStep(db, project, st.id, { status: 'COMPLETED' }, userId);
  return { ok: true, confirmed: open.length };
}
