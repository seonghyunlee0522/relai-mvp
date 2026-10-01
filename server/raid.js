/**
 * Issues & Risks engine. Two entities, one link/history pattern.
 * Issue = something that already happened; Risk = something that may happen (probability × impact).
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { nextDisplayId, resolveLinkTarget, ensureNoDuplicate, linkLabel } from './common.js';

export const ISSUE_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED'];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const RISK_STATUSES = ['OPEN', 'MONITORING', 'MATERIALIZED', 'CLOSED'];
export const LEVELS3 = ['LOW', 'MEDIUM', 'HIGH'];
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const STRATEGIES = ['AVOID', 'MITIGATE', 'TRANSFER', 'ACCEPT'];
export const TARGET_TYPES = ['WBS', 'REQUIREMENT', 'CHANGE'];

/** Allowed status moves. Reopening is allowed; MATERIALIZED never goes back to OPEN/MONITORING. */
export const ISSUE_TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'BLOCKED', 'RESOLVED'], IN_PROGRESS: ['BLOCKED', 'RESOLVED', 'OPEN'], BLOCKED: ['IN_PROGRESS', 'OPEN'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: ['OPEN'],
};
export const RISK_TRANSITIONS = { OPEN: ['MONITORING', 'MATERIALIZED', 'CLOSED'], MONITORING: ['MATERIALIZED', 'CLOSED'], MATERIALIZED: ['CLOSED'], CLOSED: ['OPEN'] };

/* ---------- domain: risk matrix (probability × impact) ---------- */
const MATRIX = {
  LOW: { LOW: 'LOW', MEDIUM: 'LOW', HIGH: 'MEDIUM' },
  MEDIUM: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
  HIGH: { LOW: 'MEDIUM', MEDIUM: 'HIGH', HIGH: 'CRITICAL' },
};
export const computeRiskLevel = (probability, impact) => MATRIX[probability]?.[impact] ?? 'MEDIUM';
/** Risk level → issue severity when a risk materialises (names coincide by design). */
export const severityFromRiskLevel = (level) => (SEVERITIES.includes(level) ? level : 'MEDIUM');

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const TODAY = 'CURRENT_DATE';

const addHistory = async (db, type, id, action, { field = null, oldValue = null, newValue = null } = {}, userId, ts = now()) =>
  (await db.run(`INSERT INTO raid_history (id, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at) VALUES (?,?,?,?,?,?,?,?,?)`, [randomUUID(), type, id, action, field, oldValue, newValue, userId, ts]));
const table = (type) => (type === 'ISSUE' ? 'issues' : 'risks');
const touch = async (db, type, id, ts = now()) => (await db.run(`UPDATE ${table(type)} SET updated_at = ? WHERE id = ?`, [ts, id]));


/* ---------- validation ---------- */
function common(b, partial, f, out) {
  const has = (k) => !partial || b[k] !== undefined; const given = (k) => b[k] !== undefined;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '제목을 200자 이내로 입력해 주세요.'; }
  if (given('description')) { out.description = str(b.description); if (out.description.length > 5000) f.description = '설명은 5,000자 이내로 입력해 주세요.'; }
  if (given('owner_user_id')) out.owner_user_id = b.owner_user_id ? String(b.owner_user_id) : null;
  for (const k of ['identified_at', 'due_date', 'review_date']) {
    if (!given(k)) continue; const v = b[k] || null;
    if (v !== null && !isDate(v)) f[k] = '날짜 형식이 올바르지 않습니다.'; else out[k] = v;
  }
}
export function parseIssue(b = {}, { partial = false } = {}) {
  const f = {}; const out = {}; common(b, partial, f, out);
  if (b.severity !== undefined) { const v = b.severity || 'MEDIUM'; if (!SEVERITIES.includes(v)) f.severity = 'Severity 값이 올바르지 않습니다.'; else out.severity = v; }
  if (b.status !== undefined) { if (!ISSUE_STATUSES.includes(b.status)) f.status = '상태 값이 올바르지 않습니다.'; else out.status = b.status; }
  if (b.resolution !== undefined) { out.resolution = str(b.resolution); if (out.resolution.length > 2000) f.resolution = '해결 내용은 2,000자 이내로 입력해 주세요.'; }
  delete out.review_date;
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}
export function parseRisk(b = {}, { partial = false } = {}) {
  const f = {}; const out = {}; common(b, partial, f, out);
  for (const k of ['probability', 'impact']) if (b[k] !== undefined) { const v = b[k] || 'MEDIUM'; if (!LEVELS3.includes(v)) f[k] = `${k === 'probability' ? 'Probability' : 'Impact'} 값이 올바르지 않습니다.`; else out[k] = v; }
  if (b.response_strategy !== undefined) { const v = b.response_strategy || null; if (v !== null && !STRATEGIES.includes(v)) f.response_strategy = '대응 전략 값이 올바르지 않습니다.'; else out.response_strategy = v; }
  if (b.mitigation_plan !== undefined) { out.mitigation_plan = str(b.mitigation_plan); if (out.mitigation_plan.length > 5000) f.mitigation_plan = '대응 계획은 5,000자 이내로 입력해 주세요.'; }
  if (b.status !== undefined) { if (!RISK_STATUSES.includes(b.status)) f.status = '상태 값이 올바르지 않습니다.'; else out.status = b.status; }
  delete out.due_date;
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}

/* ---------- reads ---------- */
const linkCountSql = (type, target) => `(SELECT COUNT(*) FROM raid_links l WHERE l.source_type = '${type}' AND l.source_id = x.id AND l.target_type = '${target}')`;
const ISSUE_COLS = `x.*, u.name AS owner_name, (x.due_date IS NOT NULL AND x.due_date < ${TODAY} AND x.status NOT IN ('RESOLVED','CLOSED'))::int AS is_overdue,
  ${linkCountSql('ISSUE', 'WBS')} AS wbs_count, ${linkCountSql('ISSUE', 'REQUIREMENT')} AS requirement_count, ${linkCountSql('ISSUE', 'CHANGE')} AS change_count,
  (SELECT display_id FROM risks r WHERE r.id = x.source_risk_id) AS source_risk_display_id, (SELECT title FROM risks r WHERE r.id = x.source_risk_id) AS source_risk_title,
  (SELECT t.id FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE e.id = x.source_test_execution_id) AS source_test_id,
  (SELECT t.display_id || ' #' || e.execution_number FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE e.id = x.source_test_execution_id) AS source_test_label`;
const RISK_COLS = `x.*, u.name AS owner_name, (x.review_date IS NOT NULL AND x.review_date < ${TODAY} AND x.status NOT IN ('CLOSED','MATERIALIZED'))::int AS needs_review,
  ${linkCountSql('RISK', 'WBS')} AS wbs_count, ${linkCountSql('RISK', 'REQUIREMENT')} AS requirement_count, ${linkCountSql('RISK', 'CHANGE')} AS change_count,
  (SELECT display_id FROM issues i WHERE i.source_risk_id = x.id AND i.archived_at IS NULL LIMIT 1) AS converted_issue_display_id,
  (SELECT id FROM issues i WHERE i.source_risk_id = x.id AND i.archived_at IS NULL LIMIT 1) AS converted_issue_id`;

function listWhere(type, q, vals) {
  const where = ['x.project_id = ?'];
  if (q.include_archived !== '1') where.push('x.archived_at IS NULL');
  const multi = (k, list) => { if (!q[k]) return; const v = String(q[k]).split(',').filter((s) => list.includes(s)); if (v.length) { where.push(`x.${k} IN (${v.map(() => '?').join(',')})`); vals.push(...v); } };
  if (type === 'ISSUE') { multi('status', ISSUE_STATUSES); multi('severity', SEVERITIES); if (q.overdue === '1') where.push(`x.due_date IS NOT NULL AND x.due_date < ${TODAY} AND x.status NOT IN ('RESOLVED','CLOSED')`); }
  else { multi('status', RISK_STATUSES); multi('probability', LEVELS3); multi('impact', LEVELS3); multi('risk_level', RISK_LEVELS); multi('response_strategy', STRATEGIES); if (q.review === '1') where.push(`x.review_date IS NOT NULL AND x.review_date < ${TODAY} AND x.status NOT IN ('CLOSED','MATERIALIZED')`); }
  if (q.owner === 'none') where.push('x.owner_user_id IS NULL'); else if (q.owner) { where.push('x.owner_user_id = ?'); vals.push(String(q.owner)); }
  for (const [param, target] of [['wbs', 'WBS'], ['requirement', 'REQUIREMENT'], ['change', 'CHANGE']]) {
    if (q[param]) { where.push(`EXISTS (SELECT 1 FROM raid_links l WHERE l.source_type = '${type}' AND l.source_id = x.id AND l.target_type = '${target}' AND l.target_id = ?)`); vals.push(String(q[param])); }
  }
  if (q.q) { const term = `%${String(q.q).trim().replace(/[%_]/g, '\\$&')}%`; where.push(`(x.display_id ILIKE ? ESCAPE '\\' OR x.title ILIKE ? ESCAPE '\\' OR x.description ILIKE ? ESCAPE '\\')`); vals.push(term, term, term); }
  return where.join(' AND ');
}
export async function listIssues(db, project, q = {}) { const vals = [project.id]; const w = listWhere('ISSUE', q, vals); return (await db.all(`SELECT ${ISSUE_COLS} FROM issues x LEFT JOIN users u ON u.id = x.owner_user_id WHERE ${w} ORDER BY x.sequence_number DESC`, [...vals])); }
export async function listRisks(db, project, q = {}) { const vals = [project.id]; const w = listWhere('RISK', q, vals); return (await db.all(`SELECT ${RISK_COLS} FROM risks x LEFT JOIN users u ON u.id = x.owner_user_id WHERE ${w} ORDER BY x.sequence_number DESC`, [...vals])); }

export async function issueStats(db, projectId) {
  return (await db.get(`SELECT COUNT(*) AS total,
    COALESCE(SUM((status = 'OPEN')::int), 0) AS open, COALESCE(SUM((status = 'IN_PROGRESS')::int), 0) AS in_progress, COALESCE(SUM((status = 'BLOCKED')::int), 0) AS blocked,
    COALESCE(SUM((status = 'RESOLVED')::int), 0) AS resolved, COALESCE(SUM((status = 'CLOSED')::int), 0) AS closed,
    COALESCE(SUM((status NOT IN ('RESOLVED','CLOSED'))::int), 0) AS active,
    COALESCE(SUM((severity = 'CRITICAL' AND status NOT IN ('RESOLVED','CLOSED'))::int), 0) AS critical,
    COALESCE(SUM((due_date IS NOT NULL AND due_date < ${TODAY} AND status NOT IN ('RESOLVED','CLOSED'))::int), 0) AS overdue
    FROM issues WHERE project_id = ? AND archived_at IS NULL`, [projectId]));
}
export async function riskStats(db, projectId) {
  return (await db.get(`SELECT COUNT(*) AS total,
    COALESCE(SUM((status = 'OPEN')::int), 0) AS open, COALESCE(SUM((status = 'MONITORING')::int), 0) AS monitoring,
    COALESCE(SUM((status = 'MATERIALIZED')::int), 0) AS materialized, COALESCE(SUM((status = 'CLOSED')::int), 0) AS closed,
    COALESCE(SUM((risk_level = 'HIGH' AND status IN ('OPEN','MONITORING'))::int), 0) AS high,
    COALESCE(SUM((risk_level = 'CRITICAL' AND status IN ('OPEN','MONITORING'))::int), 0) AS critical,
    COALESCE(SUM((risk_level IN ('HIGH','CRITICAL') AND status IN ('OPEN','MONITORING'))::int), 0) AS high_or_critical,
    COALESCE(SUM((review_date IS NOT NULL AND review_date < ${TODAY} AND status NOT IN ('CLOSED','MATERIALIZED'))::int), 0) AS review_needed
    FROM risks WHERE project_id = ? AND archived_at IS NULL`, [projectId]));
}

/** Links of one issue/risk, grouped by target type, with target display info (archived targets flagged). */
export async function linksOf(db, type, id) {
  const rows = (await db.all(`SELECT l.id, l.target_type, l.target_id,
      CASE l.target_type WHEN 'WBS' THEN (SELECT wbs_code FROM wbs_items t WHERE t.id = l.target_id) WHEN 'REQUIREMENT' THEN (SELECT display_id FROM requirements t WHERE t.id = l.target_id) ELSE (SELECT display_id FROM change_requests t WHERE t.id = l.target_id) END AS code,
      CASE l.target_type WHEN 'WBS' THEN (SELECT title FROM wbs_items t WHERE t.id = l.target_id) WHEN 'REQUIREMENT' THEN (SELECT title FROM requirements t WHERE t.id = l.target_id) ELSE (SELECT title FROM change_requests t WHERE t.id = l.target_id) END AS title,
      CASE l.target_type WHEN 'WBS' THEN (SELECT status FROM wbs_items t WHERE t.id = l.target_id) WHEN 'REQUIREMENT' THEN (SELECT status FROM requirements t WHERE t.id = l.target_id) ELSE (SELECT status FROM change_requests t WHERE t.id = l.target_id) END AS target_status,
      CASE l.target_type WHEN 'WBS' THEN (SELECT archived_at FROM wbs_items t WHERE t.id = l.target_id) WHEN 'REQUIREMENT' THEN (SELECT archived_at FROM requirements t WHERE t.id = l.target_id) ELSE (SELECT archived_at FROM change_requests t WHERE t.id = l.target_id) END AS archived_at
    FROM raid_links l WHERE l.source_type = ? AND l.source_id = ? ORDER BY l.target_type, code`, [type, id]));
  return { wbs: rows.filter((r) => r.target_type === 'WBS'), requirements: rows.filter((r) => r.target_type === 'REQUIREMENT'), changes: rows.filter((r) => r.target_type === 'CHANGE') };
}
/** Reverse lookup for WBS / requirement detail panels (active issues/risks linked to a target). */
export async function linkedRaid(db, targetType, targetId) {
  const issues = (await db.all(`SELECT i.id, i.display_id, i.title, i.status, i.severity FROM raid_links l JOIN issues i ON i.id = l.source_id
    WHERE l.source_type = 'ISSUE' AND l.target_type = ? AND l.target_id = ? AND i.archived_at IS NULL ORDER BY i.sequence_number DESC`, [targetType, targetId]));
  const risks = (await db.all(`SELECT r.id, r.display_id, r.title, r.status, r.risk_level FROM raid_links l JOIN risks r ON r.id = l.source_id
    WHERE l.source_type = 'RISK' AND l.target_type = ? AND l.target_id = ? AND r.archived_at IS NULL ORDER BY r.sequence_number DESC`, [targetType, targetId]));
  return { issues, risks };
}

export async function getIssue(db, project, id) {
  const x = (await db.get(`SELECT ${ISSUE_COLS} FROM issues x LEFT JOIN users u ON u.id = x.owner_user_id WHERE x.project_id = ? AND x.id = ?`, [project.id, id]));
  if (!x) return null;
  return { ...x, links: (await linksOf(db, 'ISSUE', id)), history: (await history(db, 'ISSUE', id)) };
}
export async function getRisk(db, project, id) {
  const x = (await db.get(`SELECT ${RISK_COLS} FROM risks x LEFT JOIN users u ON u.id = x.owner_user_id WHERE x.project_id = ? AND x.id = ?`, [project.id, id]));
  if (!x) return null;
  return { ...x, links: (await linksOf(db, 'RISK', id)), history: (await history(db, 'RISK', id)) };
}
const history = async (db, type, id) => (await db.all(`SELECT h.*, u.name AS changed_by_name FROM raid_history h LEFT JOIN users u ON u.id = h.changed_by
  WHERE h.entity_type = ? AND h.entity_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [type, id]));

/* ---------- writes (caller wraps in tx) ---------- */
export async function createIssue(db, project, input, userId, { sourceRiskId = null } = {}) {
  const { sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'ISSUE')); const id = randomUUID(); const ts = now();
  (await db.run(`INSERT INTO issues (id, project_id, sequence_number, display_id, title, description, status, severity, owner_user_id, identified_at, due_date, source_risk_id, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', input.severity ?? 'MEDIUM', input.owner_user_id ?? null, input.identified_at ?? ts.slice(0, 10), input.due_date ?? null, sourceRiskId, userId, ts, ts]));
  (await addHistory(db, 'ISSUE', id, 'CREATED', {}, userId, ts));
  return id;
}
export async function createRisk(db, project, input, userId) {
  const { sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'RISK')); const id = randomUUID(); const ts = now();
  const probability = input.probability ?? 'MEDIUM'; const impact = input.impact ?? 'MEDIUM';
  (await db.run(`INSERT INTO risks (id, project_id, sequence_number, display_id, title, description, probability, impact, risk_level, response_strategy, mitigation_plan, status, owner_user_id, identified_at, review_date, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', probability, impact, computeRiskLevel(probability, impact), input.response_strategy ?? null, input.mitigation_plan ?? '', input.owner_user_id ?? null, input.identified_at ?? ts.slice(0, 10), input.review_date ?? null, userId, ts, ts]));
  (await addHistory(db, 'RISK', id, 'CREATED', {}, userId, ts));
  return id;
}

const ISSUE_TRACKED = ['title', 'severity', 'owner_user_id', 'due_date', 'identified_at'];
const RISK_TRACKED = ['title', 'probability', 'impact', 'owner_user_id', 'review_date', 'identified_at', 'response_strategy'];
/** Partial update with guarded status transitions. Returns {changed} or {error}. */
export async function updateEntity(db, type, existing, input, userId) {
  const ts = now(); const sets = []; const vals = []; const changed = [];
  const tracked = type === 'ISSUE' ? ISSUE_TRACKED : RISK_TRACKED;
  const next = { ...input };
  if (next.status !== undefined && next.status !== existing.status) {
    const allowed = (type === 'ISSUE' ? ISSUE_TRANSITIONS : RISK_TRANSITIONS)[existing.status] || [];
    if (!allowed.includes(next.status)) return { error: 'invalid_transition', from: existing.status, to: next.status };
    sets.push('status = ?'); vals.push(next.status); changed.push('status');
    (await addHistory(db, type, existing.id, 'STATUS_CHANGED', { field: 'status', oldValue: existing.status, newValue: next.status }, userId, ts));
    if (type === 'ISSUE') {
      if (next.status === 'RESOLVED') { sets.push('resolved_at = ?'); vals.push(ts); }
      if (next.status === 'CLOSED') { sets.push('closed_at = ?'); vals.push(ts); }
      if (['OPEN', 'IN_PROGRESS', 'BLOCKED'].includes(next.status)) { sets.push('resolved_at = NULL', 'closed_at = NULL'); }
    } else {
      if (next.status === 'MATERIALIZED') { sets.push('materialized_at = ?'); vals.push(ts); }
      if (next.status === 'CLOSED') { sets.push('closed_at = ?'); vals.push(ts); }
      if (next.status === 'OPEN') sets.push('closed_at = NULL');
    }
  }
  delete next.status;
  if (type === 'RISK' && (next.probability !== undefined || next.impact !== undefined)) {
    const level = computeRiskLevel(next.probability ?? existing.probability, next.impact ?? existing.impact);
    if (level !== existing.risk_level) { sets.push('risk_level = ?'); vals.push(level); changed.push('risk_level'); (await addHistory(db, type, existing.id, 'UPDATED', { field: 'risk_level', oldValue: existing.risk_level, newValue: level }, userId, ts)); }
  }
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === existing[k]) continue;
    sets.push(`${k} = ?`); vals.push(v); changed.push(k);
    if (tracked.includes(k)) (await addHistory(db, type, existing.id, 'UPDATED', { field: k, oldValue: existing[k], newValue: v }, userId, ts));
  }
  if (!sets.length) return { changed };
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE ${table(type)} SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return { changed };
}

export async function archiveEntity(db, type, existing, userId) {
  if (existing.archived_at) return false;
  const ts = now();
  (await db.run(`UPDATE ${table(type)} SET archived_at = ?, updated_at = ? WHERE id = ?`, [ts, ts, existing.id]));
  (await addHistory(db, type, existing.id, 'ARCHIVED', {}, userId, ts));
  return true;
}

/** Risk → Issue. Copies title/description/owner/links, maps level → severity, marks the risk MATERIALIZED. */
export async function convertRiskToIssue(db, project, risk, userId) {
  if (risk.archived_at) return { error: 'archived' };
  if (risk.status === 'CLOSED') return { error: 'closed' };
  const dup = (await db.get('SELECT display_id FROM issues WHERE source_risk_id = ? AND archived_at IS NULL', [risk.id]));
  if (dup) return { error: 'already_converted', display_id: dup.display_id };
  const issueId = (await createIssue(db, project, { title: risk.title, description: risk.description, severity: severityFromRiskLevel(risk.risk_level), owner_user_id: risk.owner_user_id }, userId, { sourceRiskId: risk.id }));
  const links = (await db.all("SELECT target_type, target_id FROM raid_links WHERE source_type = 'RISK' AND source_id = ?", [risk.id]));
  for (const l of links) (await db.run('INSERT INTO raid_links (id, project_id, source_type, source_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', [randomUUID(), project.id, 'ISSUE', issueId, l.target_type, l.target_id, userId]));
  const ts = now();
  const issue = (await db.get('SELECT display_id FROM issues WHERE id = ?', [issueId]));
  (await addHistory(db, 'ISSUE', issueId, 'CONVERTED', { oldValue: `${risk.display_id} ${risk.title}` }, userId, ts));
  if (risk.status !== 'MATERIALIZED') {
    (await db.run('UPDATE risks SET status = ?, materialized_at = ?, updated_at = ? WHERE id = ?', ['MATERIALIZED', ts, ts, risk.id]));
    (await addHistory(db, 'RISK', risk.id, 'STATUS_CHANGED', { field: 'status', oldValue: risk.status, newValue: 'MATERIALIZED' }, userId, ts));
  }
  (await addHistory(db, 'RISK', risk.id, 'CONVERTED', { newValue: `${issue.display_id} ${risk.title}` }, userId, ts));
  return { ok: true, issueId };
}

/* ---------- links ---------- */
export async function addLink(db, project, type, entity, targetType, targetId, userId) {
  const t = (await resolveLinkTarget(db, project, targetType, targetId, TARGET_TYPES)); if (t.error) return t;
  (await ensureNoDuplicate(db, 'raid_links', 'source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?', [type, entity.id, targetType, t.row.id]));
  (await db.run('INSERT INTO raid_links (id, project_id, source_type, source_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?,?)', [randomUUID(), project.id, type, entity.id, targetType, t.row.id, userId]));
  (await addHistory(db, type, entity.id, 'LINKED', { field: targetType, newValue: t.label }, userId));
  (await touch(db, type, entity.id));
  return { ok: true };
}
export async function removeLink(db, type, entity, linkId, userId) {
  const l = (await db.get('SELECT * FROM raid_links WHERE id = ? AND source_type = ? AND source_id = ?', [linkId, type, entity.id]));
  if (!l) return false;
  const label = (await linkLabel(db, l.target_type, l.target_id));
  (await db.run('DELETE FROM raid_links WHERE id = ?', [linkId]));
  (await addHistory(db, type, entity.id, 'UNLINKED', { field: l.target_type, oldValue: label }, userId));
  (await touch(db, type, entity.id));
  return true;
}
