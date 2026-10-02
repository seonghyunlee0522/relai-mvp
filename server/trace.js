/**
 * Requirement ↔ WBS traceability: N:M links, coverage, guidance stats.
 * "Active" = not archived. Link rows survive archiving; every read here filters on archived_at.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { addWbsHistory } from './wbs-history.js';

export const LINK_TYPES = ['IMPLEMENTS', 'SUPPORTS', 'VALIDATES'];

export const parseLinkType = (v) => {
  if (v === undefined || v === null || v === '') return 'IMPLEMENTS';
  if (!LINK_TYPES.includes(v)) throw new ValidationError({ link_type: '연결 유형이 올바르지 않습니다.' });
  return v;
};

const addReqHistory = async (db, reqId, action, { oldValue = null, newValue = null } = {}, userId) =>
  (await db.run(`INSERT INTO requirement_history (id, requirement_id, action_type, field_name, old_value, new_value, changed_by)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), reqId, action, 'wbs_link', oldValue, newValue, userId]));

/* ---------- reads ---------- */
/** Links of one requirement with the WBS side (archived WBS included, flagged). */
export async function linksForRequirement(db, reqId) {
  return (await db.all(`SELECT l.id, l.link_type, l.created_at, w.id AS wbs_item_id, w.wbs_code, w.title, w.item_type, w.status, w.archived_at,
      u.name AS owner_name
    FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id LEFT JOIN users u ON u.id = w.owner_user_id
    WHERE l.requirement_id = ? ORDER BY w.archived_at IS NOT NULL, w.sequence, w.wbs_code`, [reqId]));
}
/** Links of one WBS item with the requirement side (archived requirements included, flagged). */
export async function linksForWbs(db, wbsId) {
  return (await db.all(`SELECT l.id, l.link_type, l.created_at, r.id AS requirement_id, r.display_id, r.title, r.status, r.scope, r.archived_at
    FROM requirement_wbs_links l JOIN requirements r ON r.id = l.requirement_id
    WHERE l.wbs_item_id = ? ORDER BY r.archived_at IS NOT NULL, r.sequence_number`, [wbsId]));
}

/** One aggregation for lists: requirement_id → number of links to ACTIVE wbs items. */
export async function linkCountsByRequirement(db, projectId) {
  const rows = (await db.all(`SELECT l.requirement_id AS id, COUNT(*) AS n FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id
    WHERE l.project_id = ? AND w.archived_at IS NULL GROUP BY l.requirement_id`, [projectId]));
  return new Map(rows.map((r) => [r.id, r.n]));
}
/** wbs_item_id → number of links to ACTIVE requirements. */
export async function linkCountsByWbs(db, projectId) {
  const rows = (await db.all(`SELECT l.wbs_item_id AS id, COUNT(*) AS n FROM requirement_wbs_links l JOIN requirements r ON r.id = l.requirement_id
    WHERE l.project_id = ? AND r.archived_at IS NULL GROUP BY l.wbs_item_id`, [projectId]));
  return new Map(rows.map((r) => [r.id, r.n]));
}

/**
 * Coverage: active IN_SCOPE requirements linked to ≥1 active WBS / active IN_SCOPE requirements.
 * Also: confirmed-in-scope-unlinked (requirements phase guidance) and active TASKs without any active requirement link (schedule phase).
 */
export async function traceStats(db, projectId) {
  const r = (await db.get(`SELECT
      COUNT(*) AS in_scope,
      COALESCE(SUM((EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id
        WHERE l.requirement_id = rq.id AND w.archived_at IS NULL))::int), 0) AS in_scope_linked,
      COALESCE(SUM((rq.status = 'CONFIRMED' AND NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN wbs_items w ON w.id = l.wbs_item_id
        WHERE l.requirement_id = rq.id AND w.archived_at IS NULL))::int), 0) AS confirmed_unlinked
    FROM requirements rq WHERE rq.project_id = ? AND rq.archived_at IS NULL AND rq.scope = 'IN_SCOPE'`, [projectId]));
  const t = (await db.get(`SELECT COUNT(*) AS tasks,
      COALESCE(SUM((NOT EXISTS (SELECT 1 FROM requirement_wbs_links l JOIN requirements rq ON rq.id = l.requirement_id
        WHERE l.wbs_item_id = w.id AND rq.archived_at IS NULL))::int), 0) AS tasks_unlinked
    FROM wbs_items w WHERE w.project_id = ? AND w.archived_at IS NULL AND w.item_type = 'TASK' AND NOT EXISTS (SELECT 1 FROM wbs_items wc WHERE wc.parent_id = w.id AND wc.archived_at IS NULL)`, [projectId]));
  return {
    in_scope: r.in_scope, in_scope_linked: r.in_scope_linked, in_scope_unlinked: r.in_scope - r.in_scope_linked,
    coverage: r.in_scope ? Math.round((r.in_scope_linked / r.in_scope) * 100) : null, // null = no target
    confirmed_unlinked: r.confirmed_unlinked,
    tasks: t.tasks, tasks_unlinked: t.tasks_unlinked, tasks_linked: t.tasks - t.tasks_unlinked,
  };
}

/* ---------- writes (caller wraps in tx) ---------- */
export async function addLink(db, project, { requirement, wbs }, linkType, userId) {
  if (requirement.archived_at) throw new ValidationError({ requirement_id: '보관된 요구사항은 연결할 수 없습니다.' });
  if (wbs.archived_at) throw new ValidationError({ wbs_item_id: '보관된 WBS 항목은 연결할 수 없습니다.' });
  if ((await db.get('SELECT 1 FROM requirement_wbs_links WHERE requirement_id = ? AND wbs_item_id = ?', [requirement.id, wbs.id])))
    throw new ValidationError({ wbs_item_id: '이미 연결되어 있습니다.' });
  const id = randomUUID();
  (await db.run('INSERT INTO requirement_wbs_links (id, project_id, requirement_id, wbs_item_id, link_type, created_by) VALUES (?,?,?,?,?,?)', [id, project.id, requirement.id, wbs.id, linkType, userId]));
  (await addReqHistory(db, requirement.id, 'LINKED_WBS', { newValue: `${wbs.wbs_code} ${wbs.title} (${linkType})` }, userId));
  (await addWbsHistory(db, wbs.id, 'LINKED_REQ', { field: 'requirement_link', newValue: requirement.display_id }, userId));
  return id;
}

export async function getLink(db, project, linkId) {
  return (await db.get(`SELECT l.*, r.display_id, w.wbs_code, w.title AS wbs_title FROM requirement_wbs_links l
    JOIN requirements r ON r.id = l.requirement_id JOIN wbs_items w ON w.id = l.wbs_item_id WHERE l.id = ? AND l.project_id = ?`, [linkId, project.id]));
}

export async function updateLinkType(db, link, linkType, userId) {
  if (link.link_type === linkType) return false;
  (await db.run('UPDATE requirement_wbs_links SET link_type = ? WHERE id = ?', [linkType, link.id]));
  (await addReqHistory(db, link.requirement_id, 'LINK_TYPE_CHANGED', { oldValue: `${link.wbs_code} ${link.link_type}`, newValue: `${link.wbs_code} ${linkType}` }, userId));
  (await addWbsHistory(db, link.wbs_item_id, 'LINK_TYPE_CHANGED', { field: 'requirement_link', oldValue: `${link.display_id} ${link.link_type}`, newValue: `${link.display_id} ${linkType}` }, userId));
  return true;
}

export async function removeLink(db, link, userId) {
  (await db.run('DELETE FROM requirement_wbs_links WHERE id = ?', [link.id]));
  (await addReqHistory(db, link.requirement_id, 'UNLINKED_WBS', { oldValue: `${link.wbs_code} ${link.wbs_title}` }, userId));
  (await addWbsHistory(db, link.wbs_item_id, 'UNLINKED_REQ', { field: 'requirement_link', oldValue: link.display_id }, userId));
}
