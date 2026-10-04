/**
 * WBS change log (table wbs_history), modelled on requirement_history. Standalone on purpose:
 * wbs.js, trace.js, bulk.js and importer.js all write here and must not import each other cyclically.
 * Action types: CREATED | UPDATED (one row per tracked field) | MOVED | ARCHIVED | DEP_ADDED | DEP_REMOVED | LINKED_REQ | UNLINKED_REQ | LINK_TYPE_CHANGED
 */
import { randomUUID } from 'node:crypto';

export const WBS_TRACKED = ['title', 'description', 'item_type', 'status', 'owner_user_id', 'progress', 'weight',
  'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'milestone_date', 'lifecycle_phase'];

const txt = (v) => (v === null || v === undefined ? null : String(v));

export const addWbsHistory = async (db, wbsId, action, { field = null, oldValue = null, newValue = null } = {}, userId = null, ts = new Date().toISOString()) =>
  (await db.run(`INSERT INTO wbs_history (id, wbs_item_id, action_type, field_name, old_value, new_value, changed_by, changed_at)
    VALUES (?,?,?,?,?,?,?,?)`, [randomUUID(), wbsId, action, field, txt(oldValue), txt(newValue), userId, ts]));

export const listWbsHistory = async (db, wbsId) =>
  (await db.all(`SELECT h.*, u.name AS changed_by_name FROM wbs_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.wbs_item_id = ? ORDER BY h.changed_at DESC, h.seq DESC`, [wbsId]));
