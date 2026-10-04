/**
 * Requirement management: first-class entity, project-scoped numbering, criteria, history.
 * Every function takes a project row already resolved through workspace membership.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { nextDisplayId, resolveLinkTarget, formatDisplayId, reserveProjectSequence } from './common.js';
import { listComments } from './comments.js';
import { linkCountsByRequirement, linksForRequirement, traceStats } from './trace.js';
import { linkedRaid } from './raid.js';
import { testsFor, acceptancesFor } from './testing.js';
import { changesFor } from './changes.js';

export const REQ_TYPES = ['UNSPECIFIED', 'FUNCTIONAL', 'NON_FUNCTIONAL', 'INTERFACE', 'DATA', 'SECURITY', 'OPERATION', 'OTHER'];
export const REQ_PRIORITIES = ['UNSPECIFIED', 'HIGH', 'MEDIUM', 'LOW'];
export const REQ_SCOPES = ['UNDECIDED', 'IN_SCOPE', 'OUT_OF_SCOPE'];
export const REQ_STATUSES = ['DRAFT', 'REVIEWING', 'CONFIRMED', 'ON_HOLD', 'REJECTED'];

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/* ---------- validation ---------- */
/** partial=true for PATCH: only supplied keys are validated/returned. */
export function parseRequirement(b = {}, { partial = false } = {}) {
  const f = {}; const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '제목을 200자 이내로 입력해 주세요.'; }
  if (has('description')) { out.description = str(b.description); if (out.description.length > 5000) f.description = '설명은 5,000자 이내로 입력해 주세요.'; }
  const enumField = (k, list, label) => {
    if (!has(k)) return;
    const v = b[k] === undefined || b[k] === null || b[k] === '' ? list[0] : b[k];
    if (!list.includes(v)) f[k] = `${label} 값이 올바르지 않습니다.`; else out[k] = v;
  };
  enumField('type', REQ_TYPES, '유형'); enumField('priority', REQ_PRIORITIES, '우선순위');
  enumField('scope', REQ_SCOPES, 'Scope'); enumField('status', REQ_STATUSES, '상태');
  if (has('requester_name')) { out.requester_name = str(b.requester_name); if (out.requester_name.length > 100) f.requester_name = '요청자는 100자 이내로 입력해 주세요.'; }
  if (has('requester_organization')) { out.requester_organization = str(b.requester_organization); if (out.requester_organization.length > 100) f.requester_organization = '소속은 100자 이내로 입력해 주세요.'; }
  if (has('owner_user_id')) { out.owner_user_id = b.owner_user_id ? String(b.owner_user_id) : null; }
  if (Object.keys(f).length) throw new ValidationError(f);
  return out;
}

export function parseCriterion(b = {}) {
  const content = str(b.content);
  if (!content || content.length > 1000) throw new ValidationError({ content: '완료 조건을 1,000자 이내로 입력해 주세요.' });
  return { content };
}

/* ---------- helpers ---------- */
export const isWorkspaceMember = async (db, workspaceId, userId) =>
  Boolean((await db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId])));

const addHistory = async (db, reqId, action, { field = null, oldValue = null, newValue = null, sourceChangeRequestId = null } = {}, userId, ts = now()) =>
  (await db.run(`INSERT INTO requirement_history (id, requirement_id, action_type, field_name, old_value, new_value, changed_by, changed_at, source_change_request_id)
    VALUES (?,?,?,?,?,?,?,?,?)`, [randomUUID(), reqId, action, field, oldValue, newValue, userId, ts, sourceChangeRequestId]));

/**
 * Resolves an optional "source change request" for a requirement edit (Phase 6 traceability: CR → REQ history).
 * Returns the CR row (same project, not archived) or null when no source was given. Throws ValidationError on a bad id.
 */
export async function resolveSourceChange(db, project, sourceId) {
  if (!sourceId) return null;
  const r = (await resolveLinkTarget(db, project, 'CHANGE', sourceId));
  if (r.error) throw new ValidationError({ source_change_request_id: '변경 요청을 찾을 수 없습니다.' });
  return r.row;
}

const REQ_COLS = `r.*, u.name AS owner_name, u.email AS owner_email,
  (SELECT COUNT(*) FROM requirement_criteria c WHERE c.requirement_id = r.id) AS criteria_count,
  (SELECT COUNT(*) FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id
     WHERE l.requirement_id = r.id AND w.archived_at IS NULL) AS linked_wbs_count`;

/* ---------- reads ---------- */
export async function listRequirements(db, project, q = {}) {
  const where = ['r.project_id = ?']; const vals = [project.id];
  if (q.include_archived !== '1') where.push('r.archived_at IS NULL');
  const multi = (k, list) => {
    if (!q[k]) return;
    const v = String(q[k]).split(',').filter((x) => list.includes(x));
    if (v.length) { where.push(`r.${k} IN (${v.map(() => '?').join(',')})`); vals.push(...v); }
  };
  multi('type', REQ_TYPES); multi('priority', REQ_PRIORITIES); multi('scope', REQ_SCOPES); multi('status', REQ_STATUSES);
  if (q.owner === 'none') where.push('r.owner_user_id IS NULL');
  else if (q.owner) { where.push('r.owner_user_id = ?'); vals.push(String(q.owner)); }
  if (q.link === 'linked') where.push('EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = r.id AND w.archived_at IS NULL)');
  else if (q.link === 'unlinked') where.push('NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.requirement_id = r.id AND w.archived_at IS NULL)');
  if (q.q) {
    const term = `%${String(q.q).trim().replace(/[%_]/g, '\\$&')}%`;
    where.push(`(r.display_id ILIKE ? ESCAPE '\\' OR r.title ILIKE ? ESCAPE '\\' OR r.description ILIKE ? ESCAPE '\\')`);
    vals.push(term, term, term);
  }
  const rows = (await db.all(`SELECT ${REQ_COLS} FROM requirements r LEFT JOIN users u ON u.id = r.owner_user_id
    WHERE ${where.join(' AND ')} ORDER BY r.sequence_number`, [...vals]));
  return rows;
}

/** Counts over non-archived requirements. Shared by the Requirements summary and the guided checklist. */
export async function requirementStats(db, projectId) {
  const base = (await db.get(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM((scope = 'IN_SCOPE')::int), 0) AS in_scope,
      COALESCE(SUM((scope = 'OUT_OF_SCOPE')::int), 0) AS out_of_scope,
      COALESCE(SUM((scope = 'UNDECIDED')::int), 0) AS scope_undecided,
      COALESCE(SUM((status = 'CONFIRMED')::int), 0) AS confirmed,
      COALESCE(SUM((status = 'REVIEWING')::int), 0) AS reviewing,
      COALESCE(SUM((status = 'DRAFT')::int), 0) AS draft,
      COALESCE(SUM((type = 'UNSPECIFIED')::int), 0) AS type_unspecified,
      COALESCE(SUM((priority = 'UNSPECIFIED')::int), 0) AS priority_unspecified,
      COALESCE(SUM((scope = 'IN_SCOPE' AND status = 'CONFIRMED')::int), 0) AS in_scope_confirmed,
      COALESCE(SUM((type IN ('INTERFACE','DATA','SECURITY'))::int), 0) AS non_functional
    FROM requirements WHERE project_id = ? AND archived_at IS NULL`, [projectId]));
  const t = (await traceStats(db, projectId));
  return { ...base, in_scope_linked: t.in_scope_linked, in_scope_unlinked: t.in_scope_unlinked, coverage: t.coverage, confirmed_unlinked: t.confirmed_unlinked };
}

export async function getRequirement(db, project, id) {
  const r = (await db.get(`SELECT ${REQ_COLS} FROM requirements r LEFT JOIN users u ON u.id = r.owner_user_id
    WHERE r.project_id = ? AND r.id = ?`, [project.id, id]));
  if (!r) return null;
  r.criteria = (await db.all('SELECT * FROM requirement_criteria WHERE requirement_id = ? ORDER BY sequence', [id]));
  r.links = (await linksForRequirement(db, id));
  r.raid = (await linkedRaid(db, 'REQUIREMENT', id));
  r.changes = (await changesFor(db, 'REQUIREMENT', id));
  r.testing = (await testsFor(db, 'REQUIREMENT', id));
  r.acceptances = (await acceptancesFor(db, id));
  r.history = (await db.all(`SELECT h.*, u.name AS changed_by_name,
      c.display_id AS source_change_display_id, c.title AS source_change_title, c.status AS source_change_status, c.archived_at AS source_change_archived_at
    FROM requirement_history h LEFT JOIN users u ON u.id = h.changed_by LEFT JOIN change_requests c ON c.id = h.source_change_request_id
    WHERE h.requirement_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [id]));
  r.comments = (await listComments(db, 'REQUIREMENT', id));
  return r;
}

/* ---------- writes (caller wraps in tx) ---------- */
/** input.display_id (optional, `REQ-nnn`, used by the Excel import): claims that number and advances the counter past it.
 *  `reservedSequences`: numbers that explicit ids elsewhere in the same batch will claim — auto-numbering skips them. */
export async function createRequirement(db, project, input, userId, { reservedSequences = null } = {}) {
  let seq; let display_id;
  const explicit = input.display_id && /^REQ-(\d{1,6})$/.exec(input.display_id);
  if (explicit) {
    seq = Number(explicit[1]); display_id = formatDisplayId('REQUIREMENT', seq);
    (await reserveProjectSequence(db, project.id, 'REQUIREMENT', seq));
  } else {
    do { ({ sequence: seq, display_id } = (await nextDisplayId(db, project.id, 'REQUIREMENT'))); } while (reservedSequences && reservedSequences.has(seq));
  }
  const id = randomUUID(); const ts = now();
  (await db.run(`INSERT INTO requirements (id, project_id, sequence_number, display_id, title, description, type, priority, scope, status,
      requester_name, requester_organization, owner_user_id, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, project.id, seq, display_id, input.title, input.description ?? '', input.type ?? 'UNSPECIFIED', input.priority ?? 'UNSPECIFIED', input.scope ?? 'UNDECIDED', input.status ?? 'DRAFT', input.requester_name ?? '', input.requester_organization ?? '', input.owner_user_id ?? null, userId, ts, ts]));
  (await addHistory(db, id, 'CREATED', {}, userId, ts));
  let i = 0;
  for (const c of input.criteria || []) await db.run('INSERT INTO requirement_criteria (id, requirement_id, content, sequence) VALUES (?,?,?,?)', [randomUUID(), id, c.content, ++i]);
  return id;
}

const TRACKED = ['title', 'description', 'type', 'priority', 'scope', 'status', 'owner_user_id'];

/** Applies only real changes; one history row per changed field. Returns list of changed fields. */
export async function updateRequirement(db, project, existing, input, userId, { sourceChangeRequestId = null } = {}) {
  const ts = now(); const sets = []; const vals = []; const changed = [];
  for (const k of TRACKED) {
    if (input[k] === undefined || input[k] === existing[k]) continue;
    sets.push(`${k} = ?`); vals.push(input[k]); changed.push(k);
    (await addHistory(db, existing.id, 'UPDATED', { field: k, oldValue: existing[k], newValue: input[k], sourceChangeRequestId }, userId, ts));
  }
  const reqChanged = ['requester_name', 'requester_organization'].filter((k) => input[k] !== undefined && input[k] !== existing[k]);
  if (reqChanged.length) {
    for (const k of reqChanged) { sets.push(`${k} = ?`); vals.push(input[k]); }
    const fmt = (n, o) => [n, o].filter(Boolean).join(' · ') || '-';
    (await addHistory(db, existing.id, 'UPDATED', { field: 'requester', sourceChangeRequestId,
      oldValue: fmt(existing.requester_name, existing.requester_organization),
      newValue: fmt(input.requester_name ?? existing.requester_name, input.requester_organization ?? existing.requester_organization) }, userId, ts));
    changed.push('requester');
  }
  if (!sets.length) return changed;
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return changed;
}

export async function archiveRequirement(db, existing, userId) {
  if (existing.archived_at) return false;
  const ts = now();
  (await db.run('UPDATE requirements SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, existing.id]));
  (await addHistory(db, existing.id, 'ARCHIVED', {}, userId, ts));
  return true;
}

export async function addCriterion(db, reqId, content, userId) {
  const seq = ((await db.get('SELECT COALESCE(MAX(sequence), 0) AS m FROM requirement_criteria WHERE requirement_id = ?', [reqId])).m) + 1;
  const id = randomUUID(); const ts = now();
  (await db.run('INSERT INTO requirement_criteria (id, requirement_id, content, sequence, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, reqId, content, seq, ts, ts]));
  (await addHistory(db, reqId, 'CRITERION_ADDED', { newValue: content }, userId, ts));
  (await touch(db, reqId, ts));
  return id;
}

export async function updateCriterion(db, reqId, critId, { content, sequence }, userId) {
  const c = (await db.get('SELECT * FROM requirement_criteria WHERE id = ? AND requirement_id = ?', [critId, reqId]));
  if (!c) return null;
  const ts = now();
  if (content !== undefined && content !== c.content) {
    (await db.run('UPDATE requirement_criteria SET content = ?, updated_at = ? WHERE id = ?', [content, ts, critId]));
    (await addHistory(db, reqId, 'CRITERION_UPDATED', { oldValue: c.content, newValue: content }, userId, ts));
    (await touch(db, reqId, ts));
  }
  if (sequence !== undefined && Number.isInteger(sequence) && sequence !== c.sequence) {
    // Reorder: move to target position, renumber the rest. Order changes are not logged (not meaningful).
    const all = (await db.all('SELECT id FROM requirement_criteria WHERE requirement_id = ? ORDER BY sequence', [reqId])).map((x) => x.id);
    const from = all.indexOf(critId); all.splice(from, 1);
    all.splice(Math.max(0, Math.min(all.length, sequence - 1)), 0, critId);
    for (const [i, cid] of all.entries()) await db.run('UPDATE requirement_criteria SET sequence = ? WHERE id = ?', [i + 1, cid]);
  }
  return (await db.get('SELECT * FROM requirement_criteria WHERE id = ?', [critId]));
}

export async function removeCriterion(db, reqId, critId, userId) {
  const c = (await db.get('SELECT * FROM requirement_criteria WHERE id = ? AND requirement_id = ?', [critId, reqId]));
  if (!c) return false;
  const ts = now();
  (await db.run('DELETE FROM requirement_criteria WHERE id = ?', [critId]));
  const rest = (await db.all('SELECT id FROM requirement_criteria WHERE requirement_id = ? ORDER BY sequence', [reqId]));
  for (const [i, x] of rest.entries()) await db.run('UPDATE requirement_criteria SET sequence = ? WHERE id = ?', [i + 1, x.id]);
  (await addHistory(db, reqId, 'CRITERION_REMOVED', { oldValue: c.content }, userId, ts));
  (await touch(db, reqId, ts));
  return true;
}

const touch = async (db, reqId, ts) => (await db.run('UPDATE requirements SET updated_at = ? WHERE id = ?', [ts, reqId]));
