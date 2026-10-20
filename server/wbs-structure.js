/**
 * WBS 고정 최상위 뼈대 (batch7 B3 · #16). Every project's WBS has the 6 RELAI phase nodes at the top (1..6), plus 데이터 이관 when the project
 * has a data migration. They are SUMMARY rows with wbs_items.system_key set; definitions in public/app/shared/wbs-structure.js (shared with the client).
 *
 *   ensureStructure(db, project, userId)  → creates the missing nodes when the WBS is opened (adopting a 뼈대 group of the same phase/name first)
 *   nodeIdFor(db, project, plan, userId)  → the node an item of plan phase `plan` goes under (AI · 뼈대 · 엑셀 · 01 주요 일정)
 *   outsideItems / tidyPreview / applyTidy → "단계 밖에 있는 항목 n건을 단계 아래로 정리" (user-triggered only, one transaction)
 *   setDataMigration(db, project, on, …)  → the WBS toolbar switch; keeps projects.data_migration in step
 *
 * Nothing here runs from a migration: a project gets its nodes the first time new code opens its WBS (B3.4), so code still on the old
 * schema just sees extra empty SUMMARY groups.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { renumber, moveWbs } from './wbs.js';
import { addWbsHistory } from './wbs-history.js';
import { FIXED_NODES, DM_KEY, nodeByKey, nodeByPlan, inferPlanPhase, phaseFromTitle } from '../public/app/shared/wbs-structure.js';

export { FIXED_NODES, DM_KEY, inferPlanPhase };
export const SKELETON_SOURCE = '뼈대로 생성';
export const TIDY_SOURCE = '단계 구조 정리';
export const wantsDm = (project) => ['YES', 'TBD'].includes(project?.data_migration);
/** Shown on open only when the project says 데이터 이관 있음 — 미정 (the default) keeps 6 nodes until the switch, the 뼈대 or an AI draft with 이관 work turns it on. */
export const showsDm = (project) => project?.data_migration === 'YES';

const liveSystem = (db, projectId) => db.all('SELECT * FROM wbs_items WHERE project_id = ? AND system_key IS NOT NULL AND archived_at IS NULL', [projectId]);

async function insertNode(db, project, node, userId) {
  const id = randomUUID(); const ts = new Date().toISOString();
  const r = await db.run(`INSERT INTO wbs_items (id, project_id, parent_id, sequence, item_type, title, description, status, progress, weight, lifecycle_phase, created_by, created_at, updated_at, system_key)
    VALUES (?, ?, NULL, 0, 'SUMMARY', ?, '', 'NOT_STARTED', 0, 1, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, system_key) WHERE system_key IS NOT NULL AND archived_at IS NULL DO NOTHING`, [id, project.id, node.title, node.phase, userId, ts, ts, node.key]);
  if (!r || !r.changes) return null;
  await addWbsHistory(db, id, 'CREATED', { field: 'source', newValue: '단계 구조(고정)' }, userId, ts);
  return id;
}

/** Old 뼈대 groups that can become a fixed node: top-level SUMMARY made by the skeleton, same lifecycle phase and the same (standard) title. */
async function adoptable(db, project, node) {
  return db.get(`SELECT w.id FROM wbs_items w WHERE w.project_id = ? AND w.parent_id IS NULL AND w.archived_at IS NULL AND w.system_key IS NULL AND w.item_type = 'SUMMARY'
      AND w.lifecycle_phase = ? AND w.title = ? AND EXISTS (SELECT 1 FROM wbs_history h WHERE h.wbs_item_id = w.id AND h.action_type = 'CREATED' AND h.field_name = 'source' AND h.new_value = ?)
    ORDER BY w.sequence LIMIT 1`, [project.id, node.phase, node.title, SKELETON_SOURCE]);
}

/** Make sure the project's fixed nodes exist. Cheap when they do (one query). Returns { created, adopted }. */
export async function ensureStructure(db, project, userId) {
  const have = new Set((await liveSystem(db, project.id)).map((r) => r.system_key));
  const want = FIXED_NODES.filter((n) => !n.optional || showsDm(project) || have.has(n.key));
  const missing = want.filter((n) => !have.has(n.key));
  if (!missing.length) return { created: 0, adopted: 0 };
  let created = 0; let adopted = 0;
  for (const n of missing) {
    const old = await adoptable(db, project, n);
    if (old) {
      const r = await db.run(`UPDATE wbs_items SET system_key = ?, title = ?, updated_at = ? WHERE id = ? AND system_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM wbs_items x WHERE x.project_id = ? AND x.system_key = ? AND x.archived_at IS NULL)`, [n.key, n.title, new Date().toISOString(), old.id, project.id, n.key]);
      if (r && r.changes) { adopted++; continue; }
    }
    if (await insertNode(db, project, n, userId)) created++;
  }
  if (created || adopted) await renumber(db, project.id);
  return { created, adopted };
}

/** Id of the node for plan phase `plan` (DATA_MIGRATION turns the optional node on). Falls back to 구현 for an unknown phase. */
export async function nodeIdFor(db, project, plan, userId) {
  const node = nodeByPlan.get(plan) || nodeByPlan.get('DEVELOPMENT');
  if (node.optional) await setDataMigration(db, project, true, userId, { quiet: true });
  else await ensureStructure(db, project, userId);
  return (await db.get('SELECT id FROM wbs_items WHERE project_id = ? AND system_key = ? AND archived_at IS NULL', [project.id, node.key]))?.id || null;
}
/** Map of plan phase → node id for the nodes that exist now. */
export async function nodeIds(db, projectId) {
  const out = new Map(); for (const r of await liveSystem(db, projectId)) { const n = nodeByKey.get(r.system_key); if (n) out.set(n.plan, r.id); }
  return out;
}

/* ---------- 데이터 이관 switch ---------- */
export class HasChildren extends ValidationError {
  constructor(n) { super({ data_migration: `하위 ${n}건을 먼저 옮기세요.` }); this.status = 409; this.code = 'has_children'; this.message = `데이터 이관 아래에 하위 ${n}건이 있습니다. 하위 ${n}건을 먼저 옮기세요.`; this.extra = { children: n }; }
}
/** on: create (or keep) the node and set projects.data_migration = 'YES'. off: 409 has_children when it has live children, else archive it and set 'NO'. */
export async function setDataMigration(db, project, on, userId, { quiet = false } = {}) {
  const node = await db.get('SELECT * FROM wbs_items WHERE project_id = ? AND system_key = ? AND archived_at IS NULL', [project.id, DM_KEY]);
  const ts = new Date().toISOString();
  if (on) {
    if (!node) { await ensureStructure(db, project, userId); if (!(await insertNode(db, project, nodeByKey.get(DM_KEY), userId)) && !quiet) { /* already there (race) */ } await renumber(db, project.id); }
    if (project.data_migration !== 'YES' && !(quiet && project.data_migration === 'TBD')) { await db.run('UPDATE projects SET data_migration = ?, updated_at = now() WHERE id = ?', ['YES', project.id]); project.data_migration = 'YES'; }
    return { on: true };
  }
  if (node) {
    const n = Number((await db.get('SELECT COUNT(*) n FROM wbs_items WHERE parent_id = ? AND archived_at IS NULL', [node.id])).n);
    if (n) throw new HasChildren(n);
    await db.run('UPDATE wbs_items SET archived_at = ?, updated_at = ? WHERE id = ?', [ts, ts, node.id]);
    await addWbsHistory(db, node.id, 'ARCHIVED', { field: 'source', newValue: '데이터 이관 끔' }, userId, ts);
    await renumber(db, project.id);
  }
  if (project.data_migration !== 'NO') { await db.run('UPDATE projects SET data_migration = ?, updated_at = now() WHERE id = ?', ['NO', project.id]); project.data_migration = 'NO'; }
  return { on: false };
}

/* ---------- 단계 구조 정리 (existing projects, user-triggered) ---------- */
/** Top-level user items (outside every fixed node). */
export const outsideItems = (db, projectId) => db.all(`SELECT * FROM wbs_items WHERE project_id = ? AND parent_id IS NULL AND archived_at IS NULL AND system_key IS NULL ORDER BY sequence, created_at`, [projectId]);

/** Suggested node for one top-level item: its lifecycle tag, else title keywords; null = 그대로 두기 (no match). */
export function suggestFor(it, { withDm = false } = {}) {
  const word = phaseFromTitle(it.title);
  let plan = word === 'DATA_MIGRATION' ? 'DATA_MIGRATION' : it.lifecycle_phase ? inferPlanPhase({ lifecycle_phase: it.lifecycle_phase, title: it.title }) : word;
  if (plan === 'DATA_MIGRATION' && !withDm) plan = 'TRANSITION_GO_LIVE';
  return plan ? nodeByPlan.get(plan).key : null;
}
export async function tidyPreview(db, project) {
  const items = await outsideItems(db, project.id);
  const kids = new Map((await db.all(`SELECT parent_id, COUNT(*) n FROM wbs_items WHERE project_id = ? AND archived_at IS NULL AND parent_id IS NOT NULL GROUP BY parent_id`, [project.id])).map((r) => [r.parent_id, Number(r.n)]));
  const withDm = Boolean(await db.get('SELECT 1 FROM wbs_items WHERE project_id = ? AND system_key = ? AND archived_at IS NULL', [project.id, DM_KEY])) || showsDm(project);
  return { items: items.map((it) => ({ id: it.id, wbs_code: it.wbs_code, title: it.title, item_type: it.item_type, lifecycle_phase: it.lifecycle_phase, children: kids.get(it.id) || 0, suggest: suggestFor(it, { withDm }) })),
    nodes: FIXED_NODES.filter((n) => !n.optional || withDm).map((n) => ({ key: n.key, title: n.title })) };
}
/** moves: [{ id, key }] — key null/'' = 그대로 두기. One transaction (caller). Returns how many moved. */
export async function applyTidy(db, project, moves, userId) {
  if (!Array.isArray(moves)) throw new ValidationError({ moves: '정리할 항목을 보내 주세요.' });
  await ensureStructure(db, project, userId);
  let moved = 0;
  for (const m of moves) {
    if (!m || !m.key) continue;
    const node = nodeByKey.get(String(m.key)); if (!node) throw new ValidationError({ moves: '단계 값이 올바르지 않습니다.' });
    const it = await db.get('SELECT * FROM wbs_items WHERE id = ? AND project_id = ? AND parent_id IS NULL AND archived_at IS NULL AND system_key IS NULL', [String(m.id || ''), project.id]);
    if (!it) continue;   // already moved / archived meanwhile
    const parentId = await nodeIdFor(db, project, node.plan, userId);
    await moveWbs(db, project, it, { parent_id: parentId, sequence: 9999 }, userId);
    await addWbsHistory(db, it.id, 'MOVED', { field: 'source', newValue: TIDY_SOURCE }, userId);
    moved++;
  }
  await renumber(db, project.id);
  return { moved };
}
