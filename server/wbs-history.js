/**
 * WBS change log (table wbs_history), modelled on requirement_history. Standalone on purpose:
 * wbs.js, trace.js, bulk.js and importer.js all write here and must not import each other cyclically.
 * Action types: CREATED | UPDATED (one row per tracked field) | MOVED | ARCHIVED | DEP_ADDED | DEP_REMOVED | LINKED_REQ | UNLINKED_REQ | LINK_TYPE_CHANGED
 */
import { randomUUID } from 'node:crypto';

export const WBS_TRACKED = ['title', 'description', 'item_type', 'status', 'owner_user_id', 'owner_stakeholder_id', 'progress', 'weight',
  'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'milestone_date', 'lifecycle_phase'];

/** Phase 3 US-1 — here (not wbs.js) because trace.js / changes.js must not import wbs.js. */
export const DELETED_OWNER = '(삭제된 담당자)';
/** SQL: the owner's display name for wbs alias `w` joined to users alias `u` — user name, else the stakeholder's name, else (삭제된 담당자). */
export const OWNER_NAME_SQL = (w = 'w', u = 'u') => `COALESCE(${u}.name, CASE WHEN ${w}.owner_stakeholder_id IS NOT NULL THEN COALESCE((SELECT sh->>'name' FROM project_definitions pd
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(pd.stakeholders::jsonb) = 'array' THEN pd.stakeholders::jsonb ELSE '[]'::jsonb END) sh
  WHERE pd.project_id = ${w}.project_id AND sh->>'id' = ${w}.owner_stakeholder_id LIMIT 1), '${DELETED_OWNER}') END)`;

const txt = (v) => (v === null || v === undefined ? null : String(v));

/** `note` = Phase 4 US-1 delay reason on a planned_end_date / milestone_date row pushed later. */
export const addWbsHistory = async (db, wbsId, action, { field = null, oldValue = null, newValue = null, note = null } = {}, userId = null, ts = new Date().toISOString()) =>
  (await db.run(`INSERT INTO wbs_history (id, wbs_item_id, action_type, field_name, old_value, new_value, changed_by, changed_at, note)
    VALUES (?,?,?,?,?,?,?,?,?)`, [randomUUID(), wbsId, action, field, txt(oldValue), txt(newValue), userId, ts, note]));

export const listWbsHistory = async (db, wbsId) =>
  (await db.all(`SELECT h.*, u.name AS changed_by_name FROM wbs_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.wbs_item_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [wbsId]));
