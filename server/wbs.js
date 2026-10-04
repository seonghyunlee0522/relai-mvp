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
import { addWbsHistory, listWbsHistory, WBS_TRACKED } from './wbs-history.js';
import { listComments } from './comments.js';

export const WBS_TYPES = ['SUMMARY', 'TASK', 'MILESTONE'];   // SUMMARY = legacy; new items are TASK (a TASK with children behaves as a group) or MILESTONE
export const WBS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'];
/** Display status derived from progress + dates (ON_HOLD always wins when set explicitly). */
export const WBS_COMPUTED_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'ON_HOLD'];
export const MAX_DEPTH = 5;
/** SQL fragment: `alias` row is a leaf (no live children). Metrics count leaf tasks only — groups are roll-ups. */
export const LEAF_SQL = (alias = 'w') => `NOT EXISTS (SELECT 1 FROM wbs_items ${alias}_c WHERE ${alias}_c.parent_id = ${alias}.id AND ${alias}_c.archived_at IS NULL)`;
const GROUP_ONLY = ['progress', 'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date'];
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const now = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const dateOrNull = (v) => (v === undefined ? undefined : v === null || v === '' ? null : v);

/** Lifecycle V2 (§17): a work item may be tagged with the lifecycle phase it belongs to. */
export const LIFECYCLE_PHASES = ['INITIATION', 'REQUIREMENTS', 'ANALYSIS_DESIGN', 'DEVELOPMENT', 'TESTING', 'TRANSITION_GO_LIVE', 'OPERATIONS'];

/* ---------- validation ---------- */
export function parseWbs(b = {}, { partial = false, existing = null } = {}) {
  const f = {}; const out = {};
  // Required on create: title. item_type defaults to TASK (a TASK with children is a group). Everything else is optional on create and partial on update.
  if (!partial && (b.item_type === undefined || b.item_type === null || b.item_type === '')) b = { ...b, item_type: 'TASK' };
  const has = (k) => !partial || b[k] !== undefined;
  const given = (k) => b[k] !== undefined;
  const type = has('item_type') ? b.item_type : existing?.item_type;
  if (has('item_type') && !WBS_TYPES.includes(b.item_type)) f.item_type = '항목 유형이 올바르지 않습니다.'; else if (has('item_type')) out.item_type = b.item_type;
  if (has('title')) { out.title = str(b.title); if (!out.title || out.title.length > 200) f.title = '업무명을 200자 이내로 입력해 주세요.'; }
  if (given('description')) { out.description = str(b.description); if (out.description.length > 5000) f.description = '설명은 5,000자 이내로 입력해 주세요.'; }
  if (given('owner_user_id')) out.owner_user_id = b.owner_user_id ? String(b.owner_user_id) : null;
  if (given('lifecycle_phase')) { const v = b.lifecycle_phase || null; if (v !== null && !LIFECYCLE_PHASES.includes(v)) f.lifecycle_phase = 'Lifecycle 단계 값이 올바르지 않습니다.'; else out.lifecycle_phase = v; }
  if (given('weight')) { const n = Number(b.weight); if (!Number.isInteger(n) || n < 0 || n > 1000) f.weight = '가중치는 0~1000 사이의 정수여야 합니다.'; else out.weight = n; }
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
  if (type === 'TASK') {
    // Completing a task sets progress to 100 unless an explicit progress came with it.
    if (out.status === 'COMPLETED' && out.progress === undefined) out.progress = 100;
    // UX-007: 100% means done — promote the stored status so counters that read `status` agree with the roll-up.
    if (out.progress === 100 && out.status === undefined && (existing?.status ?? 'NOT_STARTED') !== 'COMPLETED') out.status = 'COMPLETED';
    // BUG-004: leaving COMPLETED must not keep the stale 100 (예정 → 0, 진행중/보류 → capped at 99).
    const prevStatus = existing?.status ?? null;
    if (out.status !== undefined && out.status !== 'COMPLETED' && prevStatus === 'COMPLETED' && out.progress === undefined) {
      out.progress = out.status === 'NOT_STARTED' ? 0 : Math.min(existing?.progress ?? 0, 99);
    }
    // Progress below 100 on a completed task reopens it.
    if (out.progress !== undefined && out.progress < 100 && out.status === undefined && prevStatus === 'COMPLETED') out.status = out.progress === 0 ? 'NOT_STARTED' : 'IN_PROGRESS';
    // Explicit conflicting pair (예정 + 100, 완료 + 50) is rejected rather than silently reconciled.
    if (out.status === 'NOT_STARTED' && out.progress !== undefined && out.progress > 0 && b.progress !== undefined) throw new ValidationError({ progress: '예정 상태의 작업은 진행률이 0이어야 합니다.' });
    if (out.status === 'COMPLETED' && out.progress !== undefined && out.progress < 100 && b.progress !== undefined) throw new ValidationError({ progress: '완료 상태의 작업은 진행률이 100이어야 합니다.' });
  }
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
  const walk = async (parentId, prefix, depth) => {
    for (const [i, it] of (byParent.get(parentId || '') || []).entries()) {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      await db.run('UPDATE wbs_items SET sequence = ?, wbs_code = ?, depth = ? WHERE id = ? AND (sequence <> ? OR wbs_code <> ? OR depth <> ?)', [i + 1, code, depth, it.id, i + 1, code, depth]);
      await walk(it.id, code, depth + 1);
    }
  };
  await walk(null, '', 0);
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
  const out = []; const today = todayStr();
  const walk = (parentKey, depth) => {
    for (const it of kids.get(parentKey) || []) {
      const children = kids.get(it.id) || [];
      const node = { ...it, depth, children_count: children.length, is_group: children.length > 0, predecessors: predsOf.get(it.id) || [], linked_req_count: linkCounts.get(it.id) || 0 };
      out.push(node);
      walk(it.id, depth + 1);
      node.computed_progress = computeProgress(node, kids);
      Object.assign(node, rollupDates(node, kids));
      node.computed_status = computeStatus(node, today);
    }
  };
  walk('', 0);
  return { items: out, dependencies: deps };
}

/**
 * Progress roll-up. Leaf TASK: own progress. MILESTONE: 100 if completed else 0.
 * Any item with children (TASK group or legacy SUMMARY): weighted mean of its non-milestone children,
 * SUM(child progress × child weight) / SUM(child weight); children with weight 0 are excluded; all-zero → equal weights.
 */
function computeProgress(node, kids) {
  if (node.item_type === 'MILESTONE') return node.status === 'COMPLETED' ? 100 : 0;
  const children = (kids.get(node.id) || []).filter((c) => c.item_type !== 'MILESTONE');
  if (node.item_type !== 'SUMMARY' && !children.length) return node.progress;
  if (!children.length) return 0;
  const w = (c) => (c.weight === null || c.weight === undefined ? 1 : Number(c.weight));
  const totalW = children.reduce((a, c) => a + w(c), 0);
  const vals = children.map((c) => [computeProgress(c, kids), totalW > 0 ? w(c) : 1]);
  const den = vals.reduce((a, [, x]) => a + x, 0);
  return den ? Math.round(vals.reduce((a, [p, x]) => a + p * x, 0) / den) : 0;
}

/** Date roll-up for groups: planned/actual start = min over descendants, end = max (milestone_date counts as both). Leaves keep their own dates. */
function rollupDates(node, kids) {
  const children = kids.get(node.id) || [];
  if (!children.length) {
    const ms = node.item_type === 'MILESTONE';
    return { rollup: false, planned_start: ms ? node.milestone_date : node.planned_start_date, planned_end: ms ? node.milestone_date : node.planned_end_date, actual_start: node.actual_start_date, actual_end: node.actual_end_date };
  }
  const acc = { planned_start: null, planned_end: null, actual_start: null, actual_end: null };
  const stack = [...children];
  while (stack.length) {
    const c = stack.pop(); const ms = c.item_type === 'MILESTONE';
    const ps = ms ? c.milestone_date : c.planned_start_date; const pe = ms ? c.milestone_date : c.planned_end_date;
    if (ps && (!acc.planned_start || ps < acc.planned_start)) acc.planned_start = ps;
    if (pe && (!acc.planned_end || pe > acc.planned_end)) acc.planned_end = pe;
    if (c.actual_start_date && (!acc.actual_start || c.actual_start_date < acc.actual_start)) acc.actual_start = c.actual_start_date;
    if (c.actual_end_date && (!acc.actual_end || c.actual_end_date > acc.actual_end)) acc.actual_end = c.actual_end_date;
    for (const k of kids.get(c.id) || []) stack.push(k);
  }
  return { rollup: true, ...acc };
}

/** 보류 (explicit) > 완료 (100% / COMPLETED) > 지연 (end passed) > 진행중 (progress > 0 or IN_PROGRESS) > 예정. */
/** UX-008: non-blocking warnings when a task/milestone is scheduled outside the project's planned window. */
export function rangeWarnings(project, item) {
  const out = []; if (!project) return out;
  const ps = project.planned_start_date, pe = project.planned_end_date;
  const chk = (label, d) => { if (!d) return; if (ps && d < ps) out.push(`${label}(${d})이 프로젝트 시작일(${ps})보다 앞섭니다.`); if (pe && d > pe) out.push(`${label}(${d})이 프로젝트 종료일(${pe})을 넘습니다.`); };
  chk('계획 시작일', item.planned_start_date); chk('계획 종료일', item.planned_end_date); chk('마일스톤 일자', item.milestone_date);
  return out;
}

export function computeStatus(node, today = todayStr()) {
  if (node.status === 'ON_HOLD') return 'ON_HOLD';
  if (node.item_type === 'MILESTONE') return node.status === 'COMPLETED' ? 'COMPLETED' : node.milestone_date && node.milestone_date < today ? 'DELAYED' : 'PLANNED';
  const p = node.computed_progress ?? node.progress ?? 0;
  if (p >= 100 || node.status === 'COMPLETED') return 'COMPLETED';
  const end = node.planned_end ?? node.planned_end_date;
  if (end && end < today) return 'DELAYED';
  if (p > 0 || node.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  return 'PLANNED';
}

/** Live child count (the "group" test used by write guards). */
export const childCount = async (db, id) => (await db.get('SELECT COUNT(*) n FROM wbs_items WHERE parent_id = ? AND archived_at IS NULL', [id])).n;

/* ---------- project-level progress (one place; Overview / header KPI / guidance all read these) ---------- */
const leafWeight = (t) => (t.weight === null || t.weight === undefined ? 1 : Number(t.weight));
/** Weighted mean over leaf TASKs with the same weight rule as computeProgress (weight 0 excluded; all-zero → equal). `value(t)` ∈ [0,100]. */
function weightedMean(tasks, value) {
  if (!tasks.length) return null;
  const totalW = tasks.reduce((a, t) => a + leafWeight(t), 0);
  const w = (t) => (totalW > 0 ? leafWeight(t) : 1);
  const den = tasks.reduce((a, t) => a + w(t), 0);
  return den ? Math.round(tasks.reduce((a, t) => a + value(t) * w(t), 0) / den) : null;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Planned % of one leaf task at `today` from its planned window (inclusive days): before start 0, after end 100, else elapsed share. */
export function plannedPercent(task, today) {
  const s = task.planned_start_date, e = task.planned_end_date;
  if (!s || !e) return null;
  if (today < s) return 0;
  if (today >= e) return 100;
  const span = daysBetween(s, e) + 1; const done = daysBetween(s, today) + 1;
  return Math.max(0, Math.min(100, Math.round((done / span) * 100)));
}
/**
 * Schedule figures for Overview (§13–§17 of the landing redesign). Computed from leaf TASKs only — groups are roll-ups.
 *   actual  = weighted mean of stored leaf progress (same weight rule as the tree roll-up)         — same number the header KPI shows
 *   planned = weighted mean of plannedPercent over leaf tasks that have both planned dates; null when none has dates
 *   variance = actual − planned (%p); null when planned is null
 *   overdue_* / max_overdue_days come from the real planned dates — no predicted end date is invented.
 */
export function scheduleFigures(leafTasks, milestones, today = todayStr()) {
  const actual = weightedMean(leafTasks, (t) => Number(t.progress) || 0);   // stored leaf progress (COMPLETED is always 100 by validation)
  const dated = leafTasks.filter((t) => t.planned_start_date && t.planned_end_date);
  const planned = weightedMean(dated, (t) => plannedPercent(t, today));
  const overdueTasks = leafTasks.filter((t) => t.status !== 'COMPLETED' && t.planned_end_date && t.planned_end_date < today);
  const overdueMs = milestones.filter((m) => m.status !== 'COMPLETED' && m.milestone_date && m.milestone_date < today);
  const maxDays = Math.max(0, ...overdueTasks.map((t) => daysBetween(t.planned_end_date, today)), ...overdueMs.map((m) => daysBetween(m.milestone_date, today)));
  return {
    progress: actual ?? 0, planned_progress: planned, planned_basis: { dated: dated.length, tasks: leafTasks.length },
    variance: planned === null || actual === null ? null : actual - planned,
    overdue_tasks: overdueTasks.length, overdue_milestones: overdueMs.length, max_overdue_days: overdueTasks.length || overdueMs.length ? maxDays : 0,
  };
}

/** Project WBS stats. `progress` = weighted mean of leaf TASK progress (milestones and groups excluded) — see scheduleFigures. */
const countBy = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
export async function wbsStats(db, projectId) {
  const items = (await liveItems(db, projectId));
  const hasChild = new Set(items.filter((i) => i.parent_id).map((i) => i.parent_id));
  const leafTasks = items.filter((i) => i.item_type === 'TASK' && !hasChild.has(i.id));
  const tasks = leafTasks;   // groups (TASK with children, legacy SUMMARY) are roll-ups, never counted as work items
  const groups = items.filter((i) => hasChild.has(i.id));
  const milestones = items.filter((i) => i.item_type === 'MILESTONE');
  const deps = (await db.get(`SELECT COUNT(*) n FROM wbs_dependencies d JOIN wbs_items a ON a.id = d.predecessor_id JOIN wbs_items b ON b.id = d.successor_id
    WHERE d.project_id = ? AND a.archived_at IS NULL AND b.archived_at IS NULL`, [projectId])).n;
  return {
    total: items.length,
    tasks: tasks.length,
    summaries: groups.length,
    milestones: milestones.length,
    milestones_completed: milestones.filter((i) => i.status === 'COMPLETED').length,
    in_progress: items.filter((i) => i.status === 'IN_PROGRESS').length,
    completed: items.filter((i) => i.status === 'COMPLETED').length,
    tasks_completed: tasks.filter((i) => i.status === 'COMPLETED').length,
    // Lifecycle V2 (§17): leaf tasks per lifecycle phase (NULL = unclassified) so 구현/시험/전환 can look at their own slice of the one WBS
    by_phase: countBy(tasks, (i) => i.lifecycle_phase || 'UNCLASSIFIED'),
    by_phase_completed: countBy(tasks.filter((i) => i.status === 'COMPLETED'), (i) => i.lifecycle_phase || 'UNCLASSIFIED'),
    dependencies: deps,
    tasks_without_owner: tasks.filter((i) => !i.owner_user_id).length,
    tasks_without_dates: tasks.filter((i) => !i.planned_start_date || !i.planned_end_date).length,
    ...scheduleFigures(leafTasks, milestones),
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
  return { ...it, predecessors: preds.filter((p) => !p.archived_at), successors: succs, requirement_links: (await linksForWbs(db, id)), raid: (await linkedRaid(db, 'WBS', id)), testing: (await testsFor(db, 'WBS', id)), changes: (await changesFor(db, 'WBS', id)),
    history: (await listWbsHistory(db, id)), comments: (await listComments(db, 'WBS', id)) };
}

/* ---------- writes (caller wraps in tx) ---------- */
/* BUG-005: a leaf TASK that already carries its own progress or dates becomes a group the moment it gets a child, and
 * from then on its stored values are hidden behind the roll-up. Refuse silently converting such a parent: the caller
 * must pass convert_parent = 'move' (copy the parent's execution values into the new child, when the child has none) or
 * 'drop' (the parent's values are discarded; recorded in history). */
export const leafHasValues = (p) => p.item_type === 'TASK' && (Number(p.progress) > 0 || Boolean(p.planned_start_date || p.planned_end_date || p.actual_start_date || p.actual_end_date));
export async function guardLeafToGroup(db, project, parent, convert, userId, { child = null, ts = now() } = {}) {
  if (!parent || !leafHasValues(parent) || (await childCount(db, parent.id))) return child;
  if (convert !== 'move' && convert !== 'drop') {
    const e = new ValidationError({ parent_id: `'${parent.wbs_code || parent.title}'에 입력된 일정·진행률(${parent.progress}%)은 하위 작업이 생기면 하위 기준으로 바뀝니다. 기존 값을 첫 하위 작업으로 옮기거나(convert_parent=move) 버리는(convert_parent=drop) 방식을 지정하세요.` });
    e.code = 'parent_has_values'; e.parent = { id: parent.id, wbs_code: parent.wbs_code, title: parent.title, progress: parent.progress, planned_start_date: parent.planned_start_date, planned_end_date: parent.planned_end_date }; throw e;
  }
  const summary = `${parent.progress}% · ${parent.planned_start_date || '-'}~${parent.planned_end_date || '-'}`;
  if (convert === 'move' && child) {
    const c = { ...child };
    for (const k of ['planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date']) if (c[k] == null && parent[k]) c[k] = parent[k];
    if ((c.progress ?? 0) === 0 && Number(parent.progress) > 0) { c.progress = Number(parent.progress); if (!c.status || c.status === 'NOT_STARTED') c.status = parent.status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS'; }
    (await addWbsHistory(db, parent.id, 'CONVERTED', { field: 'group', oldValue: summary, newValue: '하위 작업으로 이관' }, userId, ts));
    return c;
  }
  (await addWbsHistory(db, parent.id, 'CONVERTED', { field: 'group', oldValue: summary, newValue: '하위 작업 기준으로 전환' }, userId, ts));
  return child;
}

export async function createWbs(db, project, input, userId, { skipRenumber = false, skipGuard = false } = {}) {
  if (input.parent_id) {
    const parent = (await getItem(db, project.id, input.parent_id));
    if (!parent || parent.archived_at) throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    if (parent.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래에는 항목을 만들 수 없습니다.' });
    if ((parent.depth || 0) + 1 >= MAX_DEPTH) throw new ValidationError({ parent_id: `WBS는 최대 ${MAX_DEPTH}단계까지 만들 수 있습니다.` });
    if (!skipGuard) input = await guardLeafToGroup(db, project, parent, input.convert_parent, userId, { child: input });
  }
  const id = randomUUID(); const ts = now();
  const seq = (await db.get('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM ?', [project.id, input.parent_id || null])).s;
  (await db.run(`INSERT INTO wbs_items (id, project_id, parent_id, sequence, item_type, title, description, owner_user_id, status, progress, weight,
      planned_start_date, planned_end_date, actual_start_date, actual_end_date, milestone_date, lifecycle_phase, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, project.id, input.parent_id || null, seq, input.item_type, input.title, input.description ?? '', input.owner_user_id ?? null, input.status ?? 'NOT_STARTED', input.item_type === 'TASK' ? (input.progress ?? (input.status === 'COMPLETED' ? 100 : 0)) : 0, input.weight ?? 1, input.item_type === 'MILESTONE' ? null : input.planned_start_date ?? null, input.item_type === 'MILESTONE' ? null : input.planned_end_date ?? null, input.actual_start_date ?? null, input.actual_end_date ?? null, input.item_type === 'MILESTONE' ? input.milestone_date ?? null : null, input.lifecycle_phase ?? null, userId, ts, ts]));
  (await addWbsHistory(db, id, 'CREATED', {}, userId, ts));
  if (!skipRenumber) (await renumber(db, project.id));
  return id;
}

export async function updateWbs(db, project, existing, input, userId = null) {
  const sets = []; const vals = [];
  const next = { ...input };
  // A group's progress and dates are roll-ups of its children: refuse direct edits instead of silently storing dead values.
  if (GROUP_ONLY.some((k) => next[k] !== undefined && next[k] !== existing[k]) && (await childCount(db, existing.id))) {
    const k = GROUP_ONLY.find((x) => next[x] !== undefined && next[x] !== existing[x]);
    throw new ValidationError({ [k]: k === 'progress' ? '하위 작업이 있는 항목의 진행률은 하위 작업에서 자동 계산됩니다.' : '하위 작업이 있는 항목의 일정은 하위 작업에서 자동 계산됩니다.' });
  }
  if (next.item_type && next.item_type !== existing.item_type) {
    const childCount = (await db.get('SELECT COUNT(*) n FROM wbs_items WHERE parent_id = ? AND archived_at IS NULL', [existing.id])).n;
    if (next.item_type === 'MILESTONE' && childCount) throw new ValidationError({ item_type: '하위 항목이 있는 항목은 마일스톤으로 바꿀 수 없습니다.' });
    if (next.item_type === 'MILESTONE') { next.planned_start_date = null; next.planned_end_date = null; next.progress = 0; }
    if (next.item_type !== 'MILESTONE') next.milestone_date = null;
    if (next.item_type === 'SUMMARY') next.progress = 0;
  }
  const ts = now();
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === existing[k]) continue;
    sets.push(`${k} = ?`); vals.push(v);
    if (WBS_TRACKED.includes(k)) (await addWbsHistory(db, existing.id, 'UPDATED', { field: k, oldValue: existing[k], newValue: v }, userId, ts));
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?'); vals.push(ts, existing.id);
  (await db.run(`UPDATE wbs_items SET ${sets.join(', ')} WHERE id = ?`, [...vals]));
  return true;
}

/** Move within/between parents. sequence is the 1-based target position among live siblings of the new parent. */
export async function moveWbs(db, project, existing, { parent_id, sequence, convert_parent }, userId = null) {
  const newParent = parent_id === undefined ? existing.parent_id : (parent_id || null);
  if (newParent) {
    const parent = (await getItem(db, project.id, newParent));
    if (!parent || parent.archived_at) throw new ValidationError({ parent_id: '상위 항목을 찾을 수 없습니다.' });
    if (parent.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래로는 이동할 수 없습니다.' });
    if (newParent === existing.id || (await descendants(db, project.id, existing.id)).includes(newParent)) throw new ValidationError({ parent_id: '자기 자신이나 하위 항목 아래로는 이동할 수 없습니다.' });
    const subDepth = await subtreeDepth(db, project.id, existing.id);
    if ((parent.depth || 0) + 1 + subDepth >= MAX_DEPTH) throw new ValidationError({ parent_id: `WBS는 최대 ${MAX_DEPTH}단계까지 만들 수 있습니다.` });
    if (newParent !== existing.parent_id) await guardLeafToGroup(db, project, parent, convert_parent, userId);   // BUG-005 (values stay on the moved item; 'move' is only meaningful for create)
  }
  const codeOf = async (pid) => (pid ? ((await getItem(db, project.id, pid))?.wbs_code || '') : '(최상위)');
  const oldParentCode = await codeOf(existing.parent_id); const newParentCode = await codeOf(newParent);
  const siblings = (await db.all('SELECT id FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM ? AND id <> ? ORDER BY sequence, created_at', [project.id, newParent, existing.id])).map((x) => x.id);
  const curIdx = existing.parent_id === newParent ? existing.sequence - 1 : siblings.length;
  const target = sequence === undefined || sequence === null ? curIdx : Math.max(0, Math.min(siblings.length, Number(sequence) - 1));
  siblings.splice(target, 0, existing.id);
  const ts = now();
  for (const [i, id] of siblings.entries()) await db.run('UPDATE wbs_items SET parent_id = ?, sequence = ?, updated_at = ? WHERE id = ?', [newParent, i + 1, ts, id]);
  // History: parent change → old/new parent code; pure reorder → field 'sequence' with old/new position.
  if (existing.parent_id !== newParent) (await addWbsHistory(db, existing.id, 'MOVED', { field: 'parent', oldValue: oldParentCode, newValue: newParentCode }, userId, ts));
  else if (existing.sequence !== target + 1) (await addWbsHistory(db, existing.id, 'MOVED', { field: 'sequence', oldValue: existing.sequence, newValue: target + 1 }, userId, ts));
  (await renumber(db, project.id));
}

/** Height of the subtree below `rootId` (0 = leaf). */
async function subtreeDepth(db, projectId, rootId) {
  const items = (await liveItems(db, projectId)); const kids = new Map();
  for (const it of items) { const k = it.parent_id || ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(it.id); }
  const h = (id) => { const c = kids.get(id) || []; return c.length ? 1 + Math.max(...c.map(h)) : 0; };
  return h(rootId);
}
const siblingsOf = (db, projectId, parentId) => db.all('SELECT * FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT DISTINCT FROM ? ORDER BY sequence, created_at', [projectId, parentId || null]);

/** 들여쓰기: become the last child of the previous sibling. */
export async function indentWbs(db, project, existing, userId = null, { convert_parent } = {}) {
  const sibs = await siblingsOf(db, project.id, existing.parent_id);
  const i = sibs.findIndex((x) => x.id === existing.id);
  if (i <= 0) throw new ValidationError({ parent_id: '바로 위에 같은 레벨의 항목이 없어 들여쓸 수 없습니다.' });
  const prev = sibs[i - 1];
  if (prev.item_type === 'MILESTONE') throw new ValidationError({ parent_id: '마일스톤 아래로는 들여쓸 수 없습니다.' });
  await moveWbs(db, project, existing, { parent_id: prev.id, sequence: 9999, convert_parent }, userId);
  return { from: { parent_id: existing.parent_id, sequence: existing.sequence }, to: { parent_id: prev.id } };
}
/** 내어쓰기: become the sibling right after the current parent. */
export async function outdentWbs(db, project, existing, userId = null) {
  if (!existing.parent_id) throw new ValidationError({ parent_id: '최상위 항목은 내어쓸 수 없습니다.' });
  const parent = await getItem(db, project.id, existing.parent_id);
  await moveWbs(db, project, existing, { parent_id: parent.parent_id || null, sequence: parent.sequence + 1 }, userId);
  return { from: { parent_id: existing.parent_id, sequence: existing.sequence }, to: { parent_id: parent.parent_id || null, sequence: parent.sequence + 1 } };
}

/** 복제: copy the item (and, with `withChildren`, its subtree) right after itself. Links/dependencies are not copied. */
export async function duplicateWbs(db, project, existing, userId, { withChildren = true } = {}) {
  const items = (await liveItems(db, project.id)); const kids = new Map();
  for (const it of items) { const k = it.parent_id || ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(it); }
  const copyOf = (src, parentId, title) => ({ item_type: src.item_type, title, description: src.description, owner_user_id: src.owner_user_id, status: 'NOT_STARTED', progress: 0, weight: src.weight,
    planned_start_date: src.planned_start_date, planned_end_date: src.planned_end_date, milestone_date: src.milestone_date, parent_id: parentId });
  const created = [];
  const clone = async (src, parentId, title) => {
    const id = await createWbs(db, project, copyOf(src, parentId, title), userId, { skipRenumber: true });
    created.push(id);
    if (withChildren) for (const c of kids.get(src.id) || []) await clone(c, id, c.title);
    return id;
  };
  const rootId = await clone(existing, existing.parent_id, `${existing.title} (복사)`);
  await addWbsHistory(db, rootId, 'CREATED', { field: 'source', newValue: `${existing.wbs_code} ${existing.title} 복제` }, userId);
  await renumber(db, project.id);
  const root = await getItem(db, project.id, rootId);
  await moveWbs(db, project, root, { sequence: existing.sequence + 1 }, userId);
  return { id: rootId, created };
}

/** Restore an archived item together with the descendants archived in the same operation (same archived_at). */
export async function restoreWbs(db, project, existing, userId = null) {
  if (!existing.archived_at) return [];
  if (existing.parent_id) { const parent = await getItem(db, project.id, existing.parent_id); if (!parent || parent.archived_at) throw new ValidationError({ parent_id: '상위 항목이 보관 상태라 복구할 수 없습니다. 상위 항목을 먼저 복구하세요.' }); }
  const rows = await db.all('SELECT id FROM wbs_items WHERE project_id = ? AND archived_at = ?', [project.id, existing.archived_at]);
  const subtree = new Set([existing.id]);
  const all = await db.all('SELECT id, parent_id FROM wbs_items WHERE project_id = ?', [project.id]);
  let grew = true; while (grew) { grew = false; for (const r of all) if (r.parent_id && subtree.has(r.parent_id) && !subtree.has(r.id)) { subtree.add(r.id); grew = true; } }
  const ids = rows.map((r) => r.id).filter((id) => subtree.has(id));
  const ts = now();
  for (const id of ids) { await db.run('UPDATE wbs_items SET archived_at = NULL, updated_at = ? WHERE id = ?', [ts, id]); await addWbsHistory(db, id, 'RESTORED', {}, userId, ts); }
  await renumber(db, project.id);
  return ids;
}

/** Archive an item with all live descendants. Dependency rows are kept (history); reads filter them out.
 *  children: 'cascade' (default) archives the subtree; 'promote' first moves the direct children to the item's own level. */
export async function archiveWbs(db, project, existing, userId = null, { skipRenumber = false, children = 'cascade' } = {}) {
  if (existing.archived_at) return [];
  if (children === 'promote') {
    const kids = await siblingsOf(db, project.id, existing.id);
    let pos = existing.sequence + 1;
    for (const c of kids) { await moveWbs(db, project, c, { parent_id: existing.parent_id || null, sequence: pos++ }, userId); }
  }
  const ids = [existing.id, ...(await descendants(db, project.id, existing.id))];
  const ts = now();
  for (const id of ids) {
    await db.run('UPDATE wbs_items SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, id]);
    (await addWbsHistory(db, id, 'ARCHIVED', {}, userId, ts));
  }
  if (!skipRenumber) (await renumber(db, project.id));
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
  (await addWbsHistory(db, successor.id, 'DEP_ADDED', { field: 'predecessor', newValue: `${pred.wbs_code} ${pred.title}` }, userId));
  return id;
}

export async function removeDependency(db, project, successor, depId, userId = null) {
  const dep = (await db.get(`SELECT p.wbs_code, p.title FROM wbs_dependencies d JOIN wbs_items p ON p.id = d.predecessor_id
    WHERE d.id = ? AND d.project_id = ? AND d.successor_id = ?`, [depId, project.id, successor.id]));
  const ok = (await db.run('DELETE FROM wbs_dependencies WHERE id = ? AND project_id = ? AND successor_id = ?', [depId, project.id, successor.id])).changes > 0;
  if (ok && dep) (await addWbsHistory(db, successor.id, 'DEP_REMOVED', { field: 'predecessor', oldValue: `${dep.wbs_code} ${dep.title}` }, userId));
  return ok;
}
