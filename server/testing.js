/**
 * Test & acceptance engine: test cases, immutable executions (latest = last result), requirement/WBS links,
 * requirement verification status, coverage, fail → issue, acceptance workflow.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { nextDisplayId, resolveLinkTarget, ensureNoDuplicate, linkLabel } from './common.js';
import { createIssue } from './raid.js';

export const TC_STATUSES = ['DRAFT', 'READY', 'BLOCKED', 'COMPLETED'];
export const TC_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const RESULTS = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];
export const ACC_STATUSES = ['DRAFT', 'REQUESTED', 'ACCEPTED', 'REJECTED', 'REWORK_REQUIRED'];
export const ACC_TRANSITIONS = { submit: ['DRAFT', 'REQUESTED'], accept: ['REQUESTED', 'ACCEPTED'], rework: ['REQUESTED', 'REWORK_REQUIRED'], reject: ['REQUESTED', 'REJECTED'], resubmit: ['REWORK_REQUIRED', 'REQUESTED'] };

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addHistory = async (db, type, id, action, { field = null, oldValue = null, newValue = null } = {}, userId, ts = now()) =>
  (await db.run('INSERT INTO qa_history (id, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at) VALUES (?,?,?,?,?,?,?,?,?)', [randomUUID(), type, id, action, field, oldValue, newValue, userId, ts]));
const history = async (db, type, id) => (await db.all(`SELECT h.*, u.name AS changed_by_name FROM qa_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.entity_type = ? AND h.entity_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [type, id]));

/* ---------- domain: verification status from a list of latest results ---------- */
/** results: array of last_result values (null = never run). UNLINKED | FAILED | VERIFIED | IN_PROGRESS */
export function verificationStatus(results) {
  if (!results.length) return 'UNLINKED';
  if (results.some((r) => r === 'FAIL')) return 'FAILED';
  if (results.every((r) => r === 'PASS')) return 'VERIFIED';
  return 'IN_PROGRESS';
}
export const summarizeResults = (results) => ({
  total: results.length, pass: results.filter((r) => r === 'PASS').length, fail: results.filter((r) => r === 'FAIL').length,
  blocked: results.filter((r) => r === 'BLOCKED').length, not_run: results.filter((r) => !r || r === 'NOT_RUN').length, verification: verificationStatus(results),
});

/* ---------- validation ---------- */
export function parseTest(b = {}, { partial = false } = {}) {
  const f = {}; const out = {};
  const has = (k) => !partial || b[k] !== undefined; const given = (k) => b[k] !== undefined;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '제목을 200자 이내로 입력해 주세요.'; }
  for (const [k, max] of [['description', 5000], ['precondition', 2000], ['expected_result', 2000]]) if (given(k)) { out[k] = str(b[k]); if (out[k].length > max) f[k] = `${max.toLocaleString()}자 이내로 입력해 주세요.`; }
  if (given('steps')) {
    const arr = Array.isArray(b.steps) ? b.steps : null;
    if (!arr || arr.length > 50) f.steps = '테스트 절차 형식이 올바르지 않습니다.';
    else out.steps = JSON.stringify(arr.map((s) => (typeof s === 'string' ? { instruction: s.trim(), expected: '' } : { instruction: str(s?.instruction).slice(0, 1000), expected: str(s?.expected).slice(0, 1000) })).filter((s) => s.instruction));
  }
  if (given('status')) { if (!TC_STATUSES.includes(b.status)) f.status = '상태 값이 올바르지 않습니다.'; else out.status = b.status; }
  if (given('priority')) { const v = b.priority || 'MEDIUM'; if (!TC_PRIORITIES.includes(v)) f.priority = '우선순위 값이 올바르지 않습니다.'; else out.priority = v; }
  if (given('owner_user_id')) out.owner_user_id = b.owner_user_id ? String(b.owner_user_id) : null;
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}
export function parseExecution(b = {}) {
  const f = {}; const result = b.result;
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(result)) f.result = '결과는 PASS / FAIL / BLOCKED 중 하나여야 합니다.';
  const actual_result = str(b.actual_result); const note = str(b.note);
  if (actual_result.length > 5000) f.actual_result = '실제 결과는 5,000자 이내로 입력해 주세요.';
  if (note.length > 2000) f.note = '메모는 2,000자 이내로 입력해 주세요.';
  if (Object.keys(f).length) throw new ValidationError(f);
  return { result, actual_result, note };
}
export function parseAcceptance(b = {}, { partial = false } = {}) {
  const f = {}; const out = {};
  const has = (k) => !partial || b[k] !== undefined; const given = (k) => b[k] !== undefined;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '제목을 200자 이내로 입력해 주세요.'; }
  if (given('description')) { out.description = str(b.description); if (out.description.length > 5000) f.description = '설명은 5,000자 이내로 입력해 주세요.'; }
  if (given('decision_note')) { out.decision_note = str(b.decision_note); if (out.decision_note.length > 2000) f.decision_note = '결정 메모는 2,000자 이내로 입력해 주세요.'; }
  if (given('due_date')) { const v = b.due_date || null; if (v !== null && !isDate(v)) f.due_date = '날짜 형식이 올바르지 않습니다.'; else out.due_date = v; }
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}

/* ---------- test cases: reads ---------- */
const LAST = `(SELECT result FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1)`;
const TC_COLS = `t.*, u.name AS owner_name, ${LAST} AS last_result,
  (SELECT executed_at FROM test_executions e WHERE e.test_case_id = t.id ORDER BY e.execution_number DESC LIMIT 1) AS last_run_at,
  (SELECT COUNT(*) FROM test_executions e WHERE e.test_case_id = t.id) AS execution_count,
  (SELECT COUNT(*) FROM test_links l JOIN requirements r ON r.id = l.target_id WHERE l.test_case_id = t.id AND l.target_type = 'REQUIREMENT' AND r.archived_at IS NULL) AS requirement_count,
  (SELECT COUNT(*) FROM test_links l JOIN wbs_items w ON w.id = l.target_id WHERE l.test_case_id = t.id AND l.target_type = 'WBS' AND w.archived_at IS NULL) AS wbs_count`;

export async function listTests(db, project, q = {}) {
  const where = ['t.project_id = ?']; const vals = [project.id];
  if (q.include_archived !== '1') where.push('t.archived_at IS NULL');
  const multi = (k, list) => { if (!q[k]) return; const v = String(q[k]).split(',').filter((s) => list.includes(s)); if (v.length) { where.push(`t.${k} IN (${v.map(() => '?').join(',')})`); vals.push(...v); } };
  multi('status', TC_STATUSES); multi('priority', TC_PRIORITIES);
  if (q.owner === 'none') where.push('t.owner_user_id IS NULL'); else if (q.owner) { where.push('t.owner_user_id = ?'); vals.push(String(q.owner)); }
  if (q.last_result === 'NOT_RUN') where.push(`COALESCE(${LAST}, 'NOT_RUN') = 'NOT_RUN'`);
  else if (q.last_result && RESULTS.includes(q.last_result)) { where.push(`${LAST} = ?`); vals.push(q.last_result); }
  if (q.requirement) { where.push(`EXISTS (SELECT 1 FROM test_links l WHERE l.test_case_id = t.id AND l.target_type = 'REQUIREMENT' AND l.target_id = ?)`); vals.push(String(q.requirement)); }
  if (q.wbs) { where.push(`EXISTS (SELECT 1 FROM test_links l WHERE l.test_case_id = t.id AND l.target_type = 'WBS' AND l.target_id = ?)`); vals.push(String(q.wbs)); }
  if (q.q) { const term = `%${String(q.q).trim().replace(/[%_]/g, '\\$&')}%`; where.push(`(t.display_id ILIKE ? ESCAPE '\\' OR t.title ILIKE ? ESCAPE '\\' OR t.description ILIKE ? ESCAPE '\\')`); vals.push(term, term, term); }
  return (await db.all(`SELECT ${TC_COLS} FROM test_cases t LEFT JOIN users u ON u.id = t.owner_user_id WHERE ${where.join(' AND ')} ORDER BY t.sequence_number DESC`, [...vals])).map(parseSteps);
}
const parseSteps = (t) => (t ? { ...t, steps: safeJson(t.steps) } : t);
const safeJson = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

export async function testStats(db, projectId) {
  const t = (await db.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM((status = 'DRAFT')::int), 0) AS draft, COALESCE(SUM((status = 'READY')::int), 0) AS ready, COALESCE(SUM((status = 'BLOCKED')::int), 0) AS blocked, COALESCE(SUM((status = 'COMPLETED')::int), 0) AS completed,
      COALESCE(SUM((EXISTS (SELECT 1 FROM test_executions e WHERE e.test_case_id = t.id))::int), 0) AS executed,
      COALESCE(SUM((${LAST} = 'PASS')::int), 0) AS last_pass, COALESCE(SUM((${LAST} = 'FAIL')::int), 0) AS last_fail, COALESCE(SUM((${LAST} = 'BLOCKED')::int), 0) AS last_blocked
    FROM test_cases t WHERE t.project_id = ? AND t.archived_at IS NULL`, [projectId]));
  const c = (await db.get(`SELECT COUNT(*) AS in_scope,
      COALESCE(SUM((EXISTS (SELECT 1 FROM test_links l JOIN test_cases tc ON tc.id = l.test_case_id WHERE l.target_type = 'REQUIREMENT' AND l.target_id = r.id AND tc.archived_at IS NULL))::int), 0) AS in_scope_tested
    FROM requirements r WHERE r.project_id = ? AND r.archived_at IS NULL AND r.scope = 'IN_SCOPE'`, [projectId]));
  const fi = (await db.get(`SELECT COUNT(*) AS n FROM issues i WHERE i.project_id = ? AND i.archived_at IS NULL AND i.source_test_execution_id IS NOT NULL AND i.status NOT IN ('RESOLVED','CLOSED')`, [projectId])).n;
  return { ...t, in_scope: c.in_scope, in_scope_tested: c.in_scope_tested, in_scope_untested: c.in_scope - c.in_scope_tested,
    coverage: c.in_scope ? Math.round((c.in_scope_tested / c.in_scope) * 100) : null, fail_issues_open: fi };
}

/** Coverage view: every active IN_SCOPE requirement with its latest-result summary (one query for links, grouped in JS). */
export async function coverage(db, projectId) {
  const reqs = (await db.all(`SELECT id, display_id, title, status, scope FROM requirements WHERE project_id = ? AND archived_at IS NULL AND scope = 'IN_SCOPE' ORDER BY sequence_number`, [projectId]));
  const rows = (await db.all(`SELECT l.target_id AS requirement_id, t.id, t.display_id, t.title, t.status, ${LAST} AS last_result
    FROM test_links l JOIN test_cases t ON t.id = l.test_case_id WHERE l.project_id = ? AND l.target_type = 'REQUIREMENT' AND t.archived_at IS NULL ORDER BY t.sequence_number`, [projectId]));
  const by = new Map(); for (const r of rows) { if (!by.has(r.requirement_id)) by.set(r.requirement_id, []); by.get(r.requirement_id).push(r); }
  return reqs.map((r) => { const tests = by.get(r.id) || []; return { ...r, tests, ...summarizeResults(tests.map((t) => t.last_result)) }; });
}
/** Tests linked to one requirement / WBS, with latest result + summary (for detail panels). */
export async function testsFor(db, targetType, targetId) {
  const tests = (await db.all(`SELECT t.id, t.display_id, t.title, t.status, ${LAST} AS last_result FROM test_links l JOIN test_cases t ON t.id = l.test_case_id
    WHERE l.target_type = ? AND l.target_id = ? AND t.archived_at IS NULL ORDER BY t.sequence_number`, [targetType, targetId]));
  return { tests, summary: summarizeResults(tests.map((t) => t.last_result)) };
}

export async function getTest(db, project, id) {
  const t = (await db.get(`SELECT ${TC_COLS} FROM test_cases t LEFT JOIN users u ON u.id = t.owner_user_id WHERE t.project_id = ? AND t.id = ?`, [project.id, id]));
  if (!t) return null;
  const links = (await db.all(`SELECT l.id, l.target_type, l.target_id,
      CASE l.target_type WHEN 'REQUIREMENT' THEN (SELECT display_id FROM requirements x WHERE x.id = l.target_id) ELSE (SELECT wbs_code FROM wbs_items x WHERE x.id = l.target_id) END AS code,
      CASE l.target_type WHEN 'REQUIREMENT' THEN (SELECT title FROM requirements x WHERE x.id = l.target_id) ELSE (SELECT title FROM wbs_items x WHERE x.id = l.target_id) END AS title,
      CASE l.target_type WHEN 'REQUIREMENT' THEN (SELECT archived_at FROM requirements x WHERE x.id = l.target_id) ELSE (SELECT archived_at FROM wbs_items x WHERE x.id = l.target_id) END AS archived_at
    FROM test_links l WHERE l.test_case_id = ? ORDER BY l.target_type, code`, [id]));
  const executions = (await db.all(`SELECT e.*, u.name AS executed_by_name, (SELECT display_id FROM issues i WHERE i.source_test_execution_id = e.id AND i.archived_at IS NULL) AS issue_display_id,
      (SELECT id FROM issues i WHERE i.source_test_execution_id = e.id AND i.archived_at IS NULL) AS issue_id, (SELECT status FROM issues i WHERE i.source_test_execution_id = e.id AND i.archived_at IS NULL) AS issue_status
    FROM test_executions e LEFT JOIN users u ON u.id = e.executed_by WHERE e.test_case_id = ? ORDER BY e.execution_number DESC`, [id]));
  const acceptances = (await db.all(`SELECT a.id, a.display_id, a.title, a.status FROM acceptance_links l JOIN acceptances a ON a.id = l.acceptance_id WHERE l.target_type = 'TEST' AND l.target_id = ? AND a.archived_at IS NULL`, [id]));
  return { ...parseSteps(t), links: { requirements: links.filter((l) => l.target_type === 'REQUIREMENT'), wbs: links.filter((l) => l.target_type === 'WBS') }, executions, acceptances, history: (await history(db, 'TEST', id)) };
}

/* ---------- test cases: writes (caller wraps in tx) ---------- */
export async function createTest(db, project, input, userId) {
  const { sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'TEST')); const id = randomUUID(); const ts = now();
  (await db.run(`INSERT INTO test_cases (id, project_id, sequence_number, display_id, title, description, precondition, steps, expected_result, status, priority, owner_user_id, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', input.precondition ?? '', input.steps ?? '[]', input.expected_result ?? '', input.status ?? 'DRAFT', input.priority ?? 'MEDIUM', input.owner_user_id ?? null, userId, ts, ts]));
  (await addHistory(db, 'TEST', id, 'CREATED', {}, userId, ts));
  return id;
}
const TC_TRACKED = ['title', 'status', 'priority', 'owner_user_id'];
export async function updateTest(db, existing, input, userId) {
  const ts = now(); const sets = []; const vals = []; const changed = [];
  const current = { ...existing, steps: JSON.stringify(existing.steps || []) };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === current[k]) continue;
    sets.push(`${k} = ?`); vals.push(v); changed.push(k);
    if (TC_TRACKED.includes(k)) (await addHistory(db, 'TEST', existing.id, k === 'status' ? 'STATUS_CHANGED' : 'UPDATED', { field: k, oldValue: current[k], newValue: v }, userId, ts));
    else if (k === 'steps') (await addHistory(db, 'TEST', existing.id, 'STEPS_CHANGED', { field: 'steps' }, userId, ts));
  }
  if (!sets.length) return changed;
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE test_cases SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return changed;
}
export async function archiveTest(db, existing, userId) {
  if (existing.archived_at) return false;
  const ts = now(); (await db.run('UPDATE test_cases SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, existing.id]));
  (await addHistory(db, 'TEST', existing.id, 'ARCHIVED', {}, userId, ts)); return true;
}
/** Append an execution; execution_number = max+1 inside the caller's IMMEDIATE transaction. */
export async function addExecution(db, test, input, userId) {
  const n = (await db.get('SELECT COALESCE(MAX(execution_number), 0) + 1 AS n FROM test_executions WHERE test_case_id = ?', [test.id])).n;
  const id = randomUUID(); const ts = now();
  (await db.run('INSERT INTO test_executions (id, test_case_id, execution_number, result, actual_result, note, executed_by, executed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [id, test.id, n, input.result, input.actual_result, input.note, userId, ts, ts]));
  (await addHistory(db, 'TEST', test.id, 'EXECUTED', { field: `#${n}`, newValue: input.result }, userId, ts));
  (await db.run('UPDATE test_cases SET updated_at = ? WHERE id = ?', [ts, test.id]));
  return { id, execution_number: n };
}
export async function addTestLink(db, project, test, targetType, targetId, userId) {
  const t = (await resolveLinkTarget(db, project, targetType, targetId, ['REQUIREMENT', 'WBS'])); if (t.error) return t;
  (await ensureNoDuplicate(db, 'test_links', 'test_case_id = ? AND target_type = ? AND target_id = ?', [test.id, targetType, t.row.id]));
  (await db.run('INSERT INTO test_links (id, project_id, test_case_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?)', [randomUUID(), project.id, test.id, targetType, t.row.id, userId]));
  (await addHistory(db, 'TEST', test.id, 'LINKED', { field: targetType, newValue: t.label }, userId));
  return { ok: true };
}
export async function removeTestLink(db, test, linkId, userId) {
  const l = (await db.get('SELECT * FROM test_links WHERE id = ? AND test_case_id = ?', [linkId, test.id]));
  if (!l) return false;
  const label = (await linkLabel(db, l.target_type, l.target_id));
  (await db.run('DELETE FROM test_links WHERE id = ?', [linkId]));
  (await addHistory(db, 'TEST', test.id, 'UNLINKED', { field: l.target_type, oldValue: label }, userId));
  return true;
}
/** FAIL execution → issue with the test's requirement/WBS links copied. One issue per execution. */
export async function raiseIssueFromExecution(db, project, test, execution, userId) {
  if (execution.result !== 'FAIL') return { error: 'not_failed' };
  const dup = (await db.get('SELECT id, display_id FROM issues WHERE source_test_execution_id = ? AND archived_at IS NULL', [execution.id]));
  if (dup) return { error: 'already_raised', issue: dup };
  const description = [`${test.display_id} ${test.title} 테스트 #${execution.execution_number} 실패`, execution.actual_result ? `실제 결과: ${execution.actual_result}` : '', test.expected_result ? `기대 결과: ${test.expected_result}` : '', execution.note ? `메모: ${execution.note}` : ''].filter(Boolean).join('\n');
  const issueId = (await createIssue(db, project, { title: `[${test.display_id}] ${test.title} 실패`, description, severity: test.priority === 'HIGH' ? 'HIGH' : 'MEDIUM', owner_user_id: test.owner_user_id }, userId));
  (await db.run('UPDATE issues SET source_test_execution_id = ? WHERE id = ?', [execution.id, issueId]));
  const links = (await db.all('SELECT target_type, target_id FROM test_links WHERE test_case_id = ?', [test.id]));
  for (const l of links) (await db.run('INSERT INTO raid_links (id, project_id, source_type, source_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', [randomUUID(), project.id, 'ISSUE', issueId, l.target_type, l.target_id, userId]));
  const issue = (await db.get('SELECT display_id FROM issues WHERE id = ?', [issueId]));
  (await addHistory(db, 'TEST', test.id, 'ISSUE_RAISED', { field: `#${execution.execution_number}`, newValue: issue.display_id }, userId));
  (await db.run("INSERT INTO raid_history (id, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), 'ISSUE', issueId, 'CONVERTED', 'TEST', `${test.display_id} #${execution.execution_number} FAIL`, null, userId]));
  return { ok: true, issueId };
}

/* ---------- acceptances ---------- */
const ACC_COLS = `a.*,
  (SELECT COUNT(*) FROM acceptance_links l JOIN requirements r ON r.id = l.target_id WHERE l.acceptance_id = a.id AND l.target_type = 'REQUIREMENT' AND r.archived_at IS NULL) AS requirement_count,
  (SELECT COUNT(*) FROM acceptance_links l JOIN test_cases t ON t.id = l.target_id WHERE l.acceptance_id = a.id AND l.target_type = 'TEST' AND t.archived_at IS NULL) AS test_count`;
export async function listAcceptances(db, project, q = {}) {
  const where = ['a.project_id = ?']; const vals = [project.id];
  if (q.include_archived !== '1') where.push('a.archived_at IS NULL');
  if (q.status) { const v = String(q.status).split(',').filter((s) => ACC_STATUSES.includes(s)); if (v.length) { where.push(`a.status IN (${v.map(() => '?').join(',')})`); vals.push(...v); } }
  if (q.requirement) { where.push(`EXISTS (SELECT 1 FROM acceptance_links l WHERE l.acceptance_id = a.id AND l.target_type = 'REQUIREMENT' AND l.target_id = ?)`); vals.push(String(q.requirement)); }
  if (q.q) { const term = `%${String(q.q).trim().replace(/[%_]/g, '\\$&')}%`; where.push(`(a.display_id ILIKE ? ESCAPE '\\' OR a.title ILIKE ? ESCAPE '\\' OR a.description ILIKE ? ESCAPE '\\')`); vals.push(term, term, term); }
  const rows = (await db.all(`SELECT ${ACC_COLS} FROM acceptances a WHERE ${where.join(' AND ')} ORDER BY a.sequence_number DESC`, [...vals]));
  // test summary per acceptance (one query for all)
  const tr = (await db.all(`SELECT l.acceptance_id, ${LAST} AS last_result FROM acceptance_links l JOIN test_cases t ON t.id = l.target_id WHERE l.project_id = ? AND l.target_type = 'TEST' AND t.archived_at IS NULL`, [project.id]));
  const by = new Map(); for (const r of tr) { if (!by.has(r.acceptance_id)) by.set(r.acceptance_id, []); by.get(r.acceptance_id).push(r.last_result); }
  return rows.map((a) => ({ ...a, test_summary: summarizeResults(by.get(a.id) || []) }));
}
export async function acceptanceStats(db, projectId) {
  const s = (await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM((status = 'DRAFT')::int), 0) AS draft, COALESCE(SUM((status = 'REQUESTED')::int), 0) AS requested,
      COALESCE(SUM((status = 'ACCEPTED')::int), 0) AS accepted, COALESCE(SUM((status = 'REJECTED')::int), 0) AS rejected, COALESCE(SUM((status = 'REWORK_REQUIRED')::int), 0) AS rework
    FROM acceptances WHERE project_id = ? AND archived_at IS NULL`, [projectId]));
  const t = (await db.get(`SELECT COUNT(DISTINCT CASE WHEN l.target_type = 'REQUIREMENT' THEN l.target_id END) AS target_requirements,
      COUNT(DISTINCT CASE WHEN l.target_type = 'TEST' AND ${LAST} = 'FAIL' THEN l.target_id END) AS target_fail_tests
    FROM acceptance_links l JOIN acceptances a ON a.id = l.acceptance_id LEFT JOIN test_cases t ON t.id = l.target_id AND l.target_type = 'TEST'
    WHERE l.project_id = ? AND a.archived_at IS NULL AND a.status IN ('DRAFT','REQUESTED','REWORK_REQUIRED')`, [projectId]));
  return { ...s, in_progress: s.requested + s.rework, target_requirements: t.target_requirements, target_fail_tests: t.target_fail_tests };
}
export async function getAcceptance(db, project, id) {
  const a = (await db.get(`SELECT ${ACC_COLS}, u.name AS created_by_name FROM acceptances a LEFT JOIN users u ON u.id = a.created_by WHERE a.project_id = ? AND a.id = ?`, [project.id, id]));
  if (!a) return null;
  const reqs = [];
  for (const r of await db.all(`SELECT l.id AS link_id, r.id, r.display_id, r.title, r.status, r.scope, r.archived_at FROM acceptance_links l JOIN requirements r ON r.id = l.target_id WHERE l.acceptance_id = ? AND l.target_type = 'REQUIREMENT' ORDER BY r.sequence_number`, [id]))
    reqs.push({ ...r, verification: (await testsFor(db, 'REQUIREMENT', r.id)).summary.verification });
  const tests = (await db.all(`SELECT l.id AS link_id, t.id, t.display_id, t.title, t.status, t.archived_at, ${LAST} AS last_result,
      (SELECT i.display_id FROM issues i JOIN test_executions e ON e.id = i.source_test_execution_id WHERE e.test_case_id = t.id AND i.archived_at IS NULL AND i.status NOT IN ('RESOLVED','CLOSED') ORDER BY e.execution_number DESC LIMIT 1) AS open_issue
    FROM acceptance_links l JOIN test_cases t ON t.id = l.target_id WHERE l.acceptance_id = ? AND l.target_type = 'TEST' ORDER BY t.sequence_number`, [id]));
  const live = tests.filter((t) => !t.archived_at);
  return { ...a, requirements: reqs, tests, test_summary: summarizeResults(live.map((t) => t.last_result)), history: (await history(db, 'ACCEPTANCE', id)) };
}
export async function createAcceptance(db, project, input, userId) {
  const { sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'ACCEPTANCE')); const id = randomUUID(); const ts = now();
  (await db.run(`INSERT INTO acceptances (id, project_id, sequence_number, display_id, title, description, status, due_date, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', input.due_date ?? null, userId, ts, ts]));
  (await addHistory(db, 'ACCEPTANCE', id, 'CREATED', {}, userId, ts));
  return id;
}
export async function updateAcceptance(db, existing, input, userId) {
  const ts = now(); const sets = []; const vals = []; const changed = [];
  for (const [k, v] of Object.entries(input)) { if (v === undefined || v === existing[k]) continue; sets.push(`${k} = ?`); vals.push(v); changed.push(k); if (['title', 'due_date'].includes(k)) (await addHistory(db, 'ACCEPTANCE', existing.id, 'UPDATED', { field: k, oldValue: existing[k], newValue: v }, userId, ts)); }
  if (!sets.length) return changed;
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE acceptances SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return changed;
}
export async function transitionAcceptance(db, existing, action, { note }, userId) {
  const t = ACC_TRANSITIONS[action]; if (!t) return { error: 'bad_action' };
  const [from, to] = t; if (existing.status !== from) return { error: 'invalid_transition', from: existing.status, to };
  if ((action === 'reject' || action === 'rework') && !str(note)) throw new ValidationError({ decision_note: action === 'reject' ? '반려 사유를 입력해 주세요.' : '보완이 필요한 내용을 입력해 주세요.' });
  const ts = now(); const sets = ['status = ?', 'updated_at = ?']; const vals = [to, ts];
  if (to === 'REQUESTED') { sets.push('requested_at = ?'); vals.push(ts); }
  if (action === 'accept') { sets.push('accepted_at = ?'); vals.push(ts); }
  if (action === 'reject') { sets.push('rejected_at = ?'); vals.push(ts); }
  if (str(note)) { sets.push('decision_note = ?'); vals.push(str(note)); }
  vals.push(existing.id);
  (await db.run(`UPDATE acceptances SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  (await addHistory(db, 'ACCEPTANCE', existing.id, 'STATUS_CHANGED', { field: 'status', oldValue: from, newValue: to }, userId, ts));
  return { ok: true };
}
export async function archiveAcceptance(db, existing, userId) {
  if (existing.archived_at) return false;
  const ts = now(); (await db.run('UPDATE acceptances SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, existing.id]));
  (await addHistory(db, 'ACCEPTANCE', existing.id, 'ARCHIVED', {}, userId, ts)); return true;
}
export async function addAcceptanceLink(db, project, acc, targetType, targetId, userId) {
  const t = (await resolveLinkTarget(db, project, targetType, targetId, ['REQUIREMENT', 'TEST'])); if (t.error) return t;
  (await ensureNoDuplicate(db, 'acceptance_links', 'acceptance_id = ? AND target_type = ? AND target_id = ?', [acc.id, targetType, t.row.id]));
  (await db.run('INSERT INTO acceptance_links (id, project_id, acceptance_id, target_type, target_id, created_by) VALUES (?,?,?,?,?,?)', [randomUUID(), project.id, acc.id, targetType, t.row.id, userId]));
  (await addHistory(db, 'ACCEPTANCE', acc.id, 'LINKED', { field: targetType, newValue: t.label }, userId));
  (await db.run('UPDATE acceptances SET updated_at = ? WHERE id = ?', [now(), acc.id]));
  return { ok: true };
}
export async function removeAcceptanceLink(db, acc, linkId, userId) {
  const l = (await db.get('SELECT * FROM acceptance_links WHERE id = ? AND acceptance_id = ?', [linkId, acc.id]));
  if (!l) return false;
  const label = (await linkLabel(db, l.target_type, l.target_id));
  (await db.run('DELETE FROM acceptance_links WHERE id = ?', [linkId]));
  (await addHistory(db, 'ACCEPTANCE', acc.id, 'UNLINKED', { field: l.target_type, oldValue: label }, userId));
  return true;
}
/** Acceptances that include a requirement (for the requirement detail drill-down). */
export const acceptancesFor = async (db, requirementId) => (await db.all(`SELECT a.id, a.display_id, a.title, a.status FROM acceptance_links l JOIN acceptances a ON a.id = l.acceptance_id
  WHERE l.target_type = 'REQUIREMENT' AND l.target_id = ? AND a.archived_at IS NULL ORDER BY a.sequence_number DESC`, [requirementId]));
