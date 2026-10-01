/**
 * Change requests: project-scoped numbering (CR-001), guarded status workflow, N:M links to requirements,
 * WBS impact records, and WBS candidates derived from requirement ↔ WBS traceability.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { nextDisplayId, resolveLinkTarget, ensureNoDuplicate } from './common.js';

export const CR_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const CR_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'IMPLEMENTED'];
export const RELATION_TYPES = ['MODIFIES', 'ADDS', 'REMOVES'];
export const IMPACT_TYPES = ['SCHEDULE', 'SCOPE', 'REWORK', 'NEW_WORK', 'NONE'];
/** Allowed transitions: action → [from, to]. */
export const TRANSITIONS = {
  submit: ['DRAFT', 'UNDER_REVIEW'],
  approve: ['UNDER_REVIEW', 'APPROVED'],
  reject: ['UNDER_REVIEW', 'REJECTED'],
  implement: ['APPROVED', 'IMPLEMENTED'],
};

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const addHistory = async (db, crId, action, { field = null, oldValue = null, newValue = null } = {}, userId, ts = now()) =>
  (await db.run(`INSERT INTO change_request_history (id, change_request_id, action_type, field_name, old_value, new_value, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?,?)`, [randomUUID(), crId, action, field, oldValue, newValue, userId, ts]));
const touch = async (db, crId, ts = now()) => (await db.run('UPDATE change_requests SET updated_at = ? WHERE id = ?', [ts, crId]));

/* ---------- validation ---------- */
export function parseChange(b = {}, { partial = false } = {}) {
  const f = {}; const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  const given = (k) => b[k] !== undefined;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '제목을 200자 이내로 입력해 주세요.'; }
  for (const [k, max, label] of [['description', 5000, '설명'], ['reason', 2000, '요청 사유'], ['decision_note', 2000, '결정 메모'], ['requester_name', 100, '요청자'], ['requester_organization', 100, '요청자 조직']]) {
    if (given(k)) { out[k] = str(b[k]); if (out[k].length > max) f[k] = `${label}은(는) ${max.toLocaleString()}자 이내로 입력해 주세요.`; }
  }
  if (given('priority')) { const v = b.priority || 'MEDIUM'; if (!CR_PRIORITIES.includes(v)) f.priority = '우선순위 값이 올바르지 않습니다.'; else out.priority = v; }
  if (given('requested_at')) { const v = b.requested_at || null; if (v !== null && !isDate(v)) f.requested_at = '요청일 형식이 올바르지 않습니다.'; else out.requested_at = v; }
  const num = (k, { integer, label, unit }) => {
    if (!given(k)) return;
    if (b[k] === null || b[k] === '') { out[k] = null; return; }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) f[k] = `${label}은(는) 0 이상의 ${integer ? '정수' : '숫자'}${unit ? `(${unit})` : ''}여야 합니다.`;
    else out[k] = integer ? n : Math.round(n * 100) / 100;
  };
  num('schedule_impact_days', { integer: true, label: '일정 영향', unit: '일' });
  num('effort_impact_md', { integer: false, label: '공수 영향', unit: 'MD' });
  num('cost_impact', { integer: true, label: '비용 영향', unit: '원' });
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}
export const parseRelationType = (v) => { const t = v || 'MODIFIES'; if (!RELATION_TYPES.includes(t)) throw new ValidationError({ relation_type: '관계 유형이 올바르지 않습니다.' }); return t; };
export const parseImpactType = (v) => { const t = v || 'SCHEDULE'; if (!IMPACT_TYPES.includes(t)) throw new ValidationError({ impact_type: '영향 유형이 올바르지 않습니다.' }); return t; };


/* ---------- reads ---------- */
const CR_COLS = `c.*, rb.name AS reviewed_by_name,
  (SELECT COUNT(*) FROM change_request_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.change_request_id = c.id AND r.archived_at IS NULL) AS requirement_count,
  (SELECT COUNT(*) FROM change_request_wbs_impacts x JOIN wbs_items w ON w.id = x.wbs_item_id WHERE x.change_request_id = c.id AND w.archived_at IS NULL) AS impact_count`;

export async function listChanges(db, project, q = {}) {
  const where = ['c.project_id = ?']; const vals = [project.id];
  if (q.include_archived !== '1') where.push('c.archived_at IS NULL');
  const multi = (k, list) => { if (!q[k]) return; const v = String(q[k]).split(',').filter((x) => list.includes(x)); if (v.length) { where.push(`c.${k} IN (${v.map(() => '?').join(',')})`); vals.push(...v); } };
  multi('status', CR_STATUSES); multi('priority', CR_PRIORITIES);
  if (q.requester) { where.push('(c.requester_name = ? OR c.requester_organization = ?)'); vals.push(String(q.requester), String(q.requester)); }
  if (q.requirement) { where.push('EXISTS (SELECT 1 FROM change_request_requirements x WHERE x.change_request_id = c.id AND x.requirement_id = ?)'); vals.push(String(q.requirement)); }
  if (q.wbs) { where.push('EXISTS (SELECT 1 FROM change_request_wbs_impacts x WHERE x.change_request_id = c.id AND x.wbs_item_id = ?)'); vals.push(String(q.wbs)); }
  if (q.schedule === '1') where.push('c.schedule_impact_days > 0');
  if (q.cost === '1') where.push('c.cost_impact > 0');
  if (q.q) {
    const term = `%${String(q.q).trim().replace(/[%_]/g, '\\$&')}%`;
    where.push(`(c.display_id ILIKE ? ESCAPE '\\' OR c.title ILIKE ? ESCAPE '\\' OR c.description ILIKE ? ESCAPE '\\' OR c.requester_name ILIKE ? ESCAPE '\\' OR c.requester_organization ILIKE ? ESCAPE '\\')`);
    vals.push(term, term, term, term, term);
  }
  return (await db.all(`SELECT ${CR_COLS} FROM change_requests c LEFT JOIN users rb ON rb.id = c.reviewed_by WHERE ${where.join(' AND ')} ORDER BY c.sequence_number DESC`, [...vals]));
}

export async function changeStats(db, projectId) {
  const s = (await db.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM((status = 'DRAFT')::int), 0) AS draft,
      COALESCE(SUM((status = 'UNDER_REVIEW')::int), 0) AS under_review,
      COALESCE(SUM((status = 'APPROVED')::int), 0) AS approved,
      COALESCE(SUM((status = 'REJECTED')::int), 0) AS rejected,
      COALESCE(SUM((status = 'IMPLEMENTED')::int), 0) AS implemented,
      COALESCE(SUM(CASE WHEN status IN ('APPROVED','IMPLEMENTED') THEN schedule_impact_days ELSE 0 END), 0) AS approved_schedule_days,
      COALESCE(SUM(CASE WHEN status IN ('APPROVED','IMPLEMENTED') THEN effort_impact_md ELSE 0 END), 0) AS approved_effort_md,
      COALESCE(SUM(CASE WHEN status IN ('APPROVED','IMPLEMENTED') THEN cost_impact ELSE 0 END), 0) AS approved_cost
    FROM change_requests WHERE project_id = ? AND archived_at IS NULL`, [projectId]));
  return { ...s, approved_unimplemented: s.approved };
}

/** Distinct requester labels for the filter dropdown. */
/** Change requests linked to one requirement / WBS item (for Delivery Trace on detail panels). */
export const changesFor = async (db, targetType, targetId) => (targetType === 'WBS'
  ? (await db.all(`SELECT c.id, c.display_id, c.title, c.status, x.impact_type AS relation FROM change_request_wbs_impacts x JOIN change_requests c ON c.id = x.change_request_id WHERE x.wbs_item_id = ? AND c.archived_at IS NULL ORDER BY c.sequence_number DESC`, [targetId]))
  : (await db.all(`SELECT c.id, c.display_id, c.title, c.status, x.relation_type AS relation FROM change_request_requirements x JOIN change_requests c ON c.id = x.change_request_id WHERE x.requirement_id = ? AND c.archived_at IS NULL ORDER BY c.sequence_number DESC`, [targetId])));
export const requesterOptions = async (db, projectId) =>
  (await db.all(`SELECT DISTINCT requester_name AS v FROM change_requests WHERE project_id = ? AND requester_name <> ''
    UNION SELECT DISTINCT requester_organization FROM change_requests WHERE project_id = ? AND requester_organization <> '' ORDER BY v`, [projectId, projectId])).map((r) => r.v);

export async function getChange(db, project, id) {
  const c = (await db.get(`SELECT ${CR_COLS}, cb.name AS created_by_name FROM change_requests c LEFT JOIN users rb ON rb.id = c.reviewed_by LEFT JOIN users cb ON cb.id = c.created_by
    WHERE c.project_id = ? AND c.id = ?`, [project.id, id]));
  if (!c) return null;
  c.requirements = (await db.all(`SELECT x.id, x.relation_type, r.id AS requirement_id, r.display_id, r.title, r.status, r.scope, r.archived_at
    FROM change_request_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.change_request_id = ? ORDER BY r.archived_at IS NOT NULL, r.sequence_number`, [id]));
  c.impacts = (await db.all(`SELECT x.id, x.impact_type, x.impact_note, w.id AS wbs_item_id, w.wbs_code, w.title, w.item_type, w.status, w.archived_at, u.name AS owner_name
    FROM change_request_wbs_impacts x JOIN wbs_items w ON w.id = x.wbs_item_id LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE x.change_request_id = ? ORDER BY w.archived_at IS NOT NULL, w.sequence, w.wbs_code`, [id]));
  // Candidates: active WBS linked (requirement_wbs_links) to any of this CR's active requirements, not yet recorded as impact.
  c.wbs_candidates = (await db.all(`SELECT w.id AS wbs_item_id, w.wbs_code, w.title, w.item_type, w.status, u.name AS owner_name,
      STRING_AGG(DISTINCT r.display_id, ',') AS via
    FROM change_request_requirements x
    JOIN requirements r ON r.id = x.requirement_id AND r.archived_at IS NULL
    JOIN requirement_wbs_links l ON l.requirement_id = r.id
    JOIN wbs_items w ON w.id = l.wbs_item_id AND w.archived_at IS NULL
    LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE x.change_request_id = ?
      AND NOT EXISTS (SELECT 1 FROM change_request_wbs_impacts i WHERE i.change_request_id = x.change_request_id AND i.wbs_item_id = w.id)
    GROUP BY w.id, u.name ORDER BY w.sequence, w.wbs_code`, [id]));
  c.history = (await db.all(`SELECT h.*, u.name AS changed_by_name FROM change_request_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.change_request_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [id]));
  return c;
}

/* ---------- writes (caller wraps in tx) ---------- */
export async function createChange(db, project, input, userId) {
  const { sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'CHANGE')); const id = randomUUID(); const ts = now();
  (await db.run(`INSERT INTO change_requests (id, project_id, sequence_number, display_id, title, description, reason, requester_name, requester_organization,
      priority, status, requested_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', input.reason ?? '', input.requester_name ?? '', input.requester_organization ?? '', input.priority ?? 'MEDIUM', input.requested_at ?? ts.slice(0, 10), userId, ts, ts]));
  (await addHistory(db, id, 'CREATED', {}, userId, ts));
  return id;
}

const TRACKED = ['title', 'description', 'reason', 'requester_name', 'requester_organization', 'priority', 'requested_at', 'schedule_impact_days', 'effort_impact_md', 'cost_impact', 'decision_note'];
export async function updateChange(db, existing, input, userId) {
  const ts = now(); const sets = []; const vals = []; const changed = [];
  for (const k of TRACKED) {
    if (input[k] === undefined || input[k] === existing[k]) continue;
    sets.push(`${k} = ?`); vals.push(input[k]); changed.push(k);
    if (!['description', 'reason', 'decision_note'].includes(k)) (await addHistory(db, existing.id, 'UPDATED', { field: k, oldValue: existing[k], newValue: input[k] }, userId, ts));
  }
  if (!sets.length) return changed;
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return changed;
}

/** Guarded workflow. Returns {error} on an invalid transition. */
export async function transition(db, existing, action, { note }, userId) {
  const t = TRANSITIONS[action];
  if (!t) return { error: 'bad_action' };
  const [from, to] = t;
  if (existing.status !== from) return { error: 'invalid_transition', from: existing.status, to };
  if (action === 'reject' && !str(note)) throw new ValidationError({ decision_note: '반려 사유를 입력해 주세요.' });
  const ts = now(); const sets = ['status = ?', 'updated_at = ?']; const vals = [to, ts];
  if (action === 'submit') { sets.push('submitted_at = ?'); vals.push(ts); }
  if (action === 'approve' || action === 'reject') {
    sets.push('reviewed_by = ?', 'reviewed_at = ?', action === 'approve' ? 'approved_at = ?' : 'rejected_at = ?'); vals.push(userId, ts, ts);
    if (str(note)) { sets.push('decision_note = ?'); vals.push(str(note)); }
  }
  if (action === 'implement') { sets.push('implemented_at = ?'); vals.push(ts); }
  vals.push(existing.id);
  (await db.run(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  (await addHistory(db, existing.id, 'STATUS_CHANGED', { field: 'status', oldValue: from, newValue: to }, userId, ts));
  return { ok: true };
}

export async function archiveChange(db, existing, userId) {
  if (existing.archived_at) return false;
  const ts = now();
  (await db.run('UPDATE change_requests SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, existing.id]));
  (await addHistory(db, existing.id, 'ARCHIVED', {}, userId, ts));
  return true;
}

/* ---------- requirement links ---------- */
export async function linkRequirement(db, project, cr, requirementId, relationType, userId) {
  const t = (await resolveLinkTarget(db, project, 'REQUIREMENT', requirementId)); if (t.error) return t;
  const r = t.row;
  (await ensureNoDuplicate(db, 'change_request_requirements', 'change_request_id = ? AND requirement_id = ?', [cr.id, r.id], 'requirement_id'));
  (await db.run('INSERT INTO change_request_requirements (id, change_request_id, requirement_id, relation_type, created_by) VALUES (?,?,?,?,?)', [randomUUID(), cr.id, r.id, relationType, userId]));
  (await addHistory(db, cr.id, 'REQUIREMENT_LINKED', { newValue: `${r.display_id} ${r.title} (${relationType})` }, userId));
  (await touch(db, cr.id));
  return { ok: true };
}
export async function updateRequirementLink(db, cr, linkId, relationType, userId) {
  const x = (await db.get('SELECT x.*, r.display_id FROM change_request_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.id = ? AND x.change_request_id = ?', [linkId, cr.id]));
  if (!x) return false;
  if (x.relation_type !== relationType) {
    (await db.run('UPDATE change_request_requirements SET relation_type = ? WHERE id = ?', [relationType, linkId]));
    (await addHistory(db, cr.id, 'UPDATED', { field: 'relation_type', oldValue: `${x.display_id} ${x.relation_type}`, newValue: `${x.display_id} ${relationType}` }, userId));
    (await touch(db, cr.id));
  }
  return true;
}
export async function unlinkRequirement(db, cr, linkId, userId) {
  const x = (await db.get('SELECT x.*, r.display_id, r.title FROM change_request_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.id = ? AND x.change_request_id = ?', [linkId, cr.id]));
  if (!x) return false;
  (await db.run('DELETE FROM change_request_requirements WHERE id = ?', [linkId]));
  (await addHistory(db, cr.id, 'REQUIREMENT_UNLINKED', { oldValue: `${x.display_id} ${x.title}` }, userId));
  (await touch(db, cr.id));
  return true;
}

/* ---------- wbs impacts ---------- */
export async function addImpact(db, project, cr, wbsId, impactType, note, userId) {
  const t = (await resolveLinkTarget(db, project, 'WBS', wbsId)); if (t.error) return t;
  const w = t.row;
  (await ensureNoDuplicate(db, 'change_request_wbs_impacts', 'change_request_id = ? AND wbs_item_id = ?', [cr.id, w.id], 'wbs_item_id'));
  (await db.run('INSERT INTO change_request_wbs_impacts (id, change_request_id, wbs_item_id, impact_type, impact_note, created_by) VALUES (?,?,?,?,?,?)', [randomUUID(), cr.id, w.id, impactType, str(note), userId]));
  (await addHistory(db, cr.id, 'WBS_IMPACT_ADDED', { newValue: `${w.wbs_code} ${w.title} (${impactType})` }, userId));
  (await touch(db, cr.id));
  return { ok: true };
}
export async function updateImpact(db, cr, impactId, { impact_type, impact_note }, userId) {
  const x = (await db.get('SELECT x.*, w.wbs_code FROM change_request_wbs_impacts x JOIN wbs_items w ON w.id = x.wbs_item_id WHERE x.id = ? AND x.change_request_id = ?', [impactId, cr.id]));
  if (!x) return false;
  const sets = []; const vals = []; const ts = now();
  if (impact_type !== undefined && impact_type !== x.impact_type) { sets.push('impact_type = ?'); vals.push(impact_type); (await addHistory(db, cr.id, 'WBS_IMPACT_UPDATED', { oldValue: `${x.wbs_code} ${x.impact_type}`, newValue: `${x.wbs_code} ${impact_type}` }, userId, ts)); }
  if (impact_note !== undefined && str(impact_note) !== x.impact_note) { sets.push('impact_note = ?'); vals.push(str(impact_note).slice(0, 1000)); }
  if (!sets.length) return true;
  sets.push('updated_at = ?'); vals.push(ts, impactId);
  (await db.run(`UPDATE change_request_wbs_impacts SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  (await touch(db, cr.id, ts));
  return true;
}
export async function removeImpact(db, cr, impactId, userId) {
  const x = (await db.get('SELECT x.*, w.wbs_code, w.title FROM change_request_wbs_impacts x JOIN wbs_items w ON w.id = x.wbs_item_id WHERE x.id = ? AND x.change_request_id = ?', [impactId, cr.id]));
  if (!x) return false;
  (await db.run('DELETE FROM change_request_wbs_impacts WHERE id = ?', [impactId]));
  (await addHistory(db, cr.id, 'WBS_IMPACT_REMOVED', { oldValue: `${x.wbs_code} ${x.title}` }, userId));
  (await touch(db, cr.id));
  return true;
}
