/**
 * WBS engine: hierarchy, codes, ordering, progress roll-up, finish-to-start dependencies.
 * Relationships are id-based; wbs_code is display-only and recomputed after every structural change.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { linkCountsByWbs, linksForWbs, traceStats } from './trace.js';
import { linkedRaid } from './raid.js';
import { testsFor } from './testing.js';
import { changesFor } from './changes.js';

export const WBS_TYPES = ['SUMMARY', 'TASK', 'MILESTONE'];
export const WBS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'];

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const dateOrNull = (v) => (v === undefined ? undefined : v === null || v === '' ? null : v);

/* ---------- validation ---------- */
export function parseWbs(b = {}, { partial = false, existing = null } = {}) {
  const f = {}; const out = {};
  // Required on create: item_type, title. Everything else is optional on create and partial on update.
  const has = (k) => !partial || b[k] !== undefined;
  const given = (k) => b[k] !== undefined;
  const type = has('item_type') ? b.item_type : existing?.item_type;
  if (has('item_type') && !WBS_TYPES.includes(b.item_type)) f.item_type = '항목 유형이 올바르지 않습니다.'; else if (has('item_type')) out.item_type = b.item_type;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '업무명을 200자 이내로 입력해 주세요.'; }
  if (given('description')) { out.description = str(b.description); if (out.description.length > 5000) f.description = '설명은 5,000자 이내로 입력해 주세요.'; }
  if (given('owner_user_id')) out.owner_user_id = b.owner_user_id ? String(b.owner_user_id) : null;
  if (given('status')) { if (!WBS_STATUSES.includes(b.status)) f.status = '상태 값이 올바르지 않습니다.'; else out.status = b.status; }
  if (b.progress !== undefined) {
    const n = Number(b.progress);
    if (!Number.isInteger(n) || n < 0 || n > 100) f.progress = '진행률은 0~100 사이의 정수여야 합니다.';
    else if (type !== 'TASK') f.progress = type === 'SUMMARY' ? '상위 항목의 진행률은 하위 작업에서 계산됩니다.' : '마일스톤은 진행률을 관리하지 않습니다.';
    else out.progress = n;
  }
  for (const k of ['planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'milestone_date']) {
    const v = dateOrNull(b[k]);
    if (v === undefined) continue;
    if (v !== null && !isDate(v)) f[k] = '날짜 형식이 올바르지 않습니다.'; else out[k] = v;
  }
  const merged = { ...(existing || {}), ...out };
  if (merged.planned_start_date && merged.planned_end_date && merged.planned_end_date < merged.planned_start_date && !f.planned_end_date) f.planned_end_date = '종료일은 시작일보다 이전일 수 없습니다.';
  if (merged.actual_start_date && merged.actual_end_date && merged.actual_end_date < merged.actual_start_date && !f.actual_end_date) f.actual_end_date = '실제 종료일은 실제 시작일보다 이전일 수 없습니다.';
  if (Object.keys(f).length) throw new ValidationError(f);
  // Completing a task sets progress to 100 unless an explicit progress came with it.
  if (out.status === 'COMPLETED' && type === 'TASK' && out.progress === undefined) out.progress = 100;
  return out;
}

/* ---------- hierarchy helpers ---------- */
const liveItems = async (db, projectId) =>
  (await db.all('SELECT * FROM wbs_items WHERE project_id = ? AND archived_at IS NULL ORDER BY parent_id, sequence, created_at', [projectId]));

/** Recompute sequence (1..n per parent) and wbs_code for the whole project. Archived items are skipped and keep stale codes. */
export async function renumber(db, projectId) {
  const items = (await liveItems(db, projectId));
  const byParent = new Map();
  for (const it of items) { const k = it.parent_id || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(it); }
  const walk = async (parentId, prefix) => {
    for (const [i, it] of (byParent.get(parentId || '') || []).entries()) {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      await db.run('UPDATE wbs_items SET sequence = ?, wbs_code = ? WHERE id = ? AND (sequence <> ? OR wbs_code <> ?)', [i + 1, code, it.id, i + 1, code]);
      await walk(it.id, code);
    }
  };
  await walk(null, '');
}

const descendants = async (db, projectId, rootId) => {
  const items = (await liveItems(db, projectId));
  const kids = new Map();
  for (const it of items) { const k = it.parent_id || ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(it.id); }
  const out = []; const stack = [rootId];
  while (stack.length) { const id = stack.pop(); for (const c of kids.get(id) || []) { out.push(c); stack.push(c); } }
  return out;
};

const getItem = async (db, projectId, id) => (await db.get('SELECT * FROM wbs_items WHERE project_id = ? AND id = ?', [projectId, id]));

/* ---------- reads ---------- */
/** Flat, depth-first ordered list with computed progress, depth, child counts and predecessor ids. */
export async function loadTree(db, project, { includeArchived = false } = {}) {
  const items = (await db.all(`SELECT w.*, u.name AS owner_name FROM wbs_items w LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE w.project_id = ? ${includeArchived ? '' : 'AND w.archived_at IS NULL'} ORDER BY w.sequence, w.created_at`, [project.id]));
  const deps = (await db.all(`SELECT d.* FROM wbs_dependencies d JOIN wbs_items a ON a.id = d.predecessor_id JOIN wbs_items b ON b.id = d.successor_id
    WHERE d.project_id = ? AND a.archived_at IS NULL AND b.archived_at IS NULL`, [project.id]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map();
  for (const it of items) { const k = it.parent_id && byId.has(it.parent_id) ? it.parent_id : ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(it); }
  const linkCounts = (await linkCountsByWbs(db, project.id));
  const predsOf = new Map();
  for (const d of deps) { if (!predsOf.has(d.successor_id)) predsOf.set(d.successor_id, []); predsOf.get(d.successor_id).push({ id: d.id, predecessor_id: d.predecessor_id, dependency_type: d.dependency_type }); }
  const out = [];
  const walk = (parentKey, depth) => {
    for (const it of kids.get(parentKey) || []) {
      const children = kids.get(it.id) || [];
      const node = { ...it, depth, children_count: children.length, predecessors: predsOf.get(it.id) || [], linked_req_count: linkCounts.get(it.id) || 0 };
      out.push(node);
      walk(it.id, depth + 1);
      node.computed_progress = computeProgress(node, kids);
    }
  };
  walk('', 0);
  return { items: out, dependencies: deps };
}

/** TASK: own progress. SUMMARY: mean of children (milestones excluded; no children → 0). MILESTONE: 100 if completed else 0. */
function computeProgress(node, kids) {
  if (node.item_type === 'MILESTONE') return node.status === 'COMPLETED' ? 100 : 0;
  const children = (kids.get(node.id) || []).filter((c) => c.item_type !== 'MILESTONE');
  if (node.item_type === 'TASK' && !children.length) return node.progress;
  if (!children.length) return 0;
  const vals = children.map((c) => computeProgress(c, kids));
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Project WBS progress = mean of leaf TASK progress (milestones and summaries excluded). */
export async function wbsStats(db, projectId) {
  const items = (await liveItems(db, projectId));
  const hasChild = new Set(items.filter((i) => i.parent_id).map((i) => i.parent_id));
  const leafTasks = items.filter((i) => i.item_type === 'TASK' && !hasChild.has(i.id));
  const tasks = items.filter((i) => i.item_type === 'TASK');
  const deps = (await db.get(`SELECT COUNT(*) n FROM wbs_dependencies d JOIN wbs_items a ON a.id = d.predecessor_id JOIN wbs_items b ON b.id = d.successor_id
    WHERE d.project_id = ? AND a.archived_at IS NULL AND b.archived_at IS NULL`, [projectId])).n;
  return {
    total: items.length,
    tasks: tasks.length,
    summaries: items.filter((i) => i.item_type === 'SUMMARY').length,
    milestones: items.filter((i) => i.item_type === 'MILESTONE').length,
    in_progress: items.filter((i) => i.status === 'IN_PROGRESS').length,
    completed: items.filter((i) => i.status === 'COMPLETED').length,
    dependencies: deps,
    tasks_without_owner: tasks.filter((i) => !i.owner_user_id).length,
    tasks_without_dates: tasks.filter((i) => !i.planned_start_date || !i.planned_end_date).length,
    progress: leafTasks.length ? Math.round(leafTasks.reduce((a, t) => a + t.progress, 0) / leafTasks.length) : 0,
    tasks_unlinked: (await traceStats(db, projectId)).tasks_unlinked,
  };
}

export async function getWbs(db, project, id) {
  const { items } = (await loadTree(db, project, { includeArchived: true }));
  const it = items.find((i) => i.id === id);
  if (!it) return null;
  const preds = (await db.all(`SELECT d.id, d.predecessor_id, d.dependency_type, p.wbs_code, p.title, p.item_type, p.archived_at
    FROM wbs_dependencies d JOIN wbs_items p ON p.id = d.predecessor_id WHERE d.successor_id = ? ORDER BY p.sequence`, [id]));
  const succs = (await db.all(`SELECT d.id, d.successor_id, s.wbs_code, s.title FROM wbs_dependencies d JOIN wbs_items s ON s.id = d.successor_id
    WHERE d.predecessor_id = ? AND s.archived_at IS NULL ORDER BY s.sequence`, [id]));
  return { ...it, predecessors: preds.filter((p) => !p.archived_at), successors: succs, requirement_links: (await linksForWbs(db, id)), raid: (await linkedRaid(db, 'WBS', id)), testing: (await testsFor(db, 'WBS', id)), changes: (await changesFor(db, 'WBS', id)) };
}

/* ---------- writes (caller wraps in tx) ---------- */
export async function createWbs(db, project, input, userId) {
  if (input.parent_id) {
    const parent = (await getItem(db, project.id, input.parent_id));
    if (!parent || parent.archived_at) throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    if (parent.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래에는 항목을 만들 수 없습니다.' });
  }
  const id = randomUUID(); const ts = now();
  const seq = (await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM ?', [project.id, input.parent_id || null])).s;
  (await db.run(`INSERT INTO wbs_items (id, project_id, parent_id, sequence, item_type, title, description, owner_user_id, status, progress,
      planned_start_date, planned_end_date, actual_start_date, actual_end_date, milestone_date, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, project.id, input.parent_id || null, seq, input.item_type, input.title, input.description ?? '', input.owner_user_id ?? null, input.status ?? 'NOT_STARTED', input.item_type === 'TASK' ? (input.progress ?? (input.status === 'COMPLETED' ? 100 : 0)) : 0, input.item_type === 'MILESTONE' ? null : input.planned_start_date ?? null, input.item_type === 'MILESTONE' ? null : input.planned_end_date ?? null, input.actual_start_date ?? null, input.actual_end_date ?? null, input.item_type === 'MILESTONE' ? input.milestone_date ?? null : null, userId, ts, ts]));
  (await renumber(db, project.id));
  return id;
}

export async function updateWbs(db, project, existing, input) {
  const sets = []; const vals = [];
  const next = { ...input };
  if (next.item_type && next.item_type !== existing.item_type) {
    const childCount = (await db.get('SELECT COUNT(*) n FROM wbs_items WHERE parent_id = ? AND archived_at IS NULL', [existing.id])).n;
    if (next.item_type === 'MILESTONE' && childCount) throw new ValidationError({ item_type: '하위 항목이 있는 항목은 마일스톤으로 바꿀 수 없습니다.' });
    if (next.item_type === 'MILESTONE') { next.planned_start_date = null; next.planned_end_date = null; next.progress = 0; }
    if (next.item_type !== 'MILESTONE') next.milestone_date = null;
    if (next.item_type === 'SUMMARY') next.progress = 0;
  }
  for (const [k, v] of Object.entries(next)) { if (v === undefined || v === existing[k]) continue; sets.push(`${k} = ?`); vals.push(v); }
  if (!sets.length) return false;
  sets.push('updated_at = ?'); vals.push(now(), existing.id);
  (await db.run(`UPDATE wbs_items SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return true;
}

/** Move within/between parents. sequence is the 1-based target position among live siblings of the new parent. */
export async function moveWbs(db, project, existing, { parent_id, sequence }) {
  const newParent = parent_id === undefined ? existing.parent_id : (parent_id || null);
  if (newParent) {
    const parent = (await getItem(db, project.id, newParent));
    if (!parent || parent.archived_at) throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    if (parent.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래로는 이동할 수 없습니다.' });
    if (newParent === existing.id || (await descendants(db, project.id, existing.id)).includes(newParent)) throw new ValidationError({ parent_id: '자기 자신이나 하위 항목 아래로는 이동할 수 없습니다.' });
  }
  const siblings = (await db.all('SELECT id FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM ? AND id <> ? ORDER BY sequence, created_at', [project.id, newParent, existing.id])).map((x) => x.id);
  const curIdx = existing.parent_id === newParent ? existing.sequence - 1 : siblings.length;
  const target = sequence === undefined || sequence === null ? curIdx : Math.max(0, Math.min(siblings.length, Number(sequence) - 1));
  siblings.splice(target, 0, existing.id);
  const ts = now();
  for (const [i, id] of siblings.entries()) await db.run('UPDATE wbs_items SET parent_id = ?, sequence = ?, updated_at = ? WHERE id = ?', [newParent, i + 1, ts, id]);
  (await renumber(db, project.id));
}

/** Archive an item with all live descendants. Dependency rows are kept (history); reads filter them out. */
export async function archiveWbs(db, project, existing) {
  if (existing.archived_at) return [];
  const ids = [existing.id, ...(await descendants(db, project.id, existing.id))];
  const ts = now();
  for (const id of ids) await db.run('UPDATE wbs_items SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, id]);
  (await renumber(db, project.id));
  return ids;
}

/* ---------- dependencies ---------- */
/** True if `fromId` can reach `toId` following predecessor → successor edges (live items only). */
async function reaches(db, projectId, fromId, toId) {
  const edges = (await db.all('SELECT predecessor_id, successor_id FROM wbs_dependencies WHERE project_id = ?', [projectId]));
  const next = new Map();
  for (const e of edges) { if (!next.has(e.predecessor_id)) next.set(e.predecessor_id, []); next.get(e.predecessor_id).push(e.successor_id); }
  const seen = new Set([fromId]); const stack = [fromId];
  while (stack.length) { const id = stack.pop(); if (id === toId) return true; for (const n of next.get(id) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); } }
  return false;
}

export async function addDependency(db, project, successor, predecessorId, userId) {
  if (predecessorId === successor.id) throw new ValidationError({ predecessor_id: '자기 자신을 선행 작업으로 지정할 수 없습니다.' });
  const pred = (await getItem(db, project.id, predecessorId));
  if (!pred || pred.archived_at) throw new ValidationError({ predecessor_id: '선행 작업을 찾을 수 없습니다.' });
  if ((await db.get('SELECT 1 FROM wbs_dependencies WHERE predecessor_id = ? AND successor_id = ?', [predecessorId, successor.id]))) throw new ValidationError({ predecessor_id: '이미 선행 작업으로 지정되어 있습니다.' });
  // Adding pred → succ creates a cycle iff succ already reaches pred.
  if ((await reaches(db, project.id, successor.id, predecessorId))) throw new ValidationError({ predecessor_id: '순환 관계가 생겨 지정할 수 없습니다.' });
  const id = randomUUID();
  (await db.run('INSERT INTO wbs_dependencies (id, project_id, predecessor_id, successor_id, dependency_type, created_by) VALUES (?,?,?,?,?,?)', [id, project.id, predecessorId, successor.id, 'FINISH_TO_START', userId]));
  return id;
}

export async function removeDependency(db, project, successor, depId) {
  return (await db.run('DELETE FROM wbs_dependencies WHERE id = ? AND project_id = ? AND successor_id = ?', [depId, project.id, successor.id])).changes > 0;
}
