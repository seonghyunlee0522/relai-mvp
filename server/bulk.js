/**
 * Bulk actions for requirements and WBS items. One transaction per request; every id is validated on its own:
 * ids that are unknown, archived or fail validation land in `skipped` and the rest are applied.
 */
import { ValidationError } from './validate.js';
import { tx } from './db.js';
import * as R from './requirements.js';
import * as W from './wbs.js';

export const BULK_MAX = 500;
const REQ_PATCH_KEYS = ['owner_user_id', 'status', 'priority', 'scope', 'type'];
const WBS_PATCH_KEYS = ['owner_user_id', 'status', 'planned_start_date', 'planned_end_date', 'progress', 'actual_start_date', 'actual_end_date'];

const joinMessages = (e) => (e instanceof ValidationError ? Object.values(e.fields).join(' ') : null);

/** Shared body validation. Returns { ids (deduplicated, order kept), action, patch }. Throws ValidationError (→ 400). */
export function parseBulkBody(b = {}, patchKeys, { allowShift = false } = {}) {
  const f = {};
  let ids = [];
  if (!Array.isArray(b.ids) || !b.ids.length) f.ids = '대상을 하나 이상 선택해 주세요.';
  else if (b.ids.length > BULK_MAX) f.ids = `한 번에 최대 ${BULK_MAX}건까지 처리할 수 있습니다.`;
  else if (b.ids.some((x) => typeof x !== 'string' || !x || x.length > 64)) f.ids = '대상 ID 형식이 올바르지 않습니다.';
  else ids = [...new Set(b.ids)];
  if (!['update', 'archive'].includes(b.action)) f.action = '지원하지 않는 작업입니다.';
  let patch = {}; let shift = 0;
  if (b.action === 'update') {
    if (b.patch !== undefined && (typeof b.patch !== 'object' || b.patch === null || Array.isArray(b.patch))) f.patch = '변경할 내용 형식이 올바르지 않습니다.';
    else {
      const given = Object.entries(b.patch || {}).filter(([, v]) => v !== undefined);
      const unknown = given.map(([k]) => k).filter((k) => !patchKeys.includes(k));
      if (unknown.length) f.patch = `일괄 변경할 수 없는 항목이 포함되어 있습니다: ${unknown.join(', ')}`;
      patch = Object.fromEntries(given);
    }
    if (allowShift && b.shift_days !== undefined && b.shift_days !== null) {
      if (!Number.isInteger(b.shift_days) || b.shift_days < -3650 || b.shift_days > 3650) f.shift_days = '일정 이동 일수는 -3650~3650 사이의 정수여야 합니다.';
      else shift = b.shift_days;
    }
    if (!f.patch && !Object.keys(patch).length && !shift && !f.shift_days) f.patch = '변경할 내용을 입력해 주세요.';
  }
  if (Object.keys(f).length) throw new ValidationError(f);
  return { ids, action: b.action, patch, shift };
}

const byIds = async (db, table, project, ids) => {
  const rows = await db.all(`SELECT * FROM ${table} WHERE project_id = ? AND id = ANY(?)`, [project.id, ids]);
  return new Map(rows.map((r) => [r.id, r]));
};
const NO_CHANGE = '변경할 내용이 없습니다.';

/* ---------- requirements ---------- */
export async function bulkRequirements(db, project, wid, body, userId) {
  const { ids, action, patch } = parseBulkBody(body, REQ_PATCH_KEYS);
  let input = {}; let source = null;
  if (action === 'update') {
    input = R.parseRequirement(patch, { partial: true });          // static problems (bad enum …) → 400 for the whole request
    source = await R.resolveSourceChange(db, project, body.source_change_request_id);
  }
  const ownerBad = action === 'update' && input.owner_user_id && !(await R.isWorkspaceMember(db, wid, input.owner_user_id));
  return tx(db, async (t) => {
    const rows = await byIds(t, 'requirements', project, ids);
    let updated = 0; const skipped = [];
    for (const id of ids) {
      const r = rows.get(id);
      if (!r) { skipped.push({ id, reason: '요구사항을 찾을 수 없습니다.' }); continue; }
      if (r.archived_at) { skipped.push({ id, reason: '보관된 요구사항은 수정할 수 없습니다.' }); continue; }
      if (action === 'archive') { await R.archiveRequirement(t, r, userId); updated++; continue; }
      if (ownerBad) { skipped.push({ id, reason: 'Owner는 현재 Workspace 멤버만 지정할 수 있습니다.' }); continue; }
      const changed = await R.updateRequirement(t, project, r, input, userId, { sourceChangeRequestId: source ? source.id : null });
      if (changed.length) updated++; else skipped.push({ id, reason: NO_CHANGE });
    }
    return { updated, skipped, summary: await R.requirementStats(t, project.id) };
  });
}

/* ---------- WBS ---------- */
const shiftDate = (s, days) => (s ? new Date(Date.parse(`${s}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10) : s);

export async function bulkWbs(db, project, wid, body, userId) {
  const { ids, action, patch, shift } = parseBulkBody(body, WBS_PATCH_KEYS, { allowShift: true });
  if (action === 'update' && Object.keys(patch).length) W.parseWbs(patch, { partial: true, existing: { item_type: 'TASK' } });   // static problems → 400
  const ownerBad = action === 'update' && patch.owner_user_id && !(await R.isWorkspaceMember(db, wid, String(patch.owner_user_id)));
  return tx(db, async (t) => {
    const rows = await byIds(t, 'wbs_items', project, ids);
    let updated = 0; const skipped = []; const archivedIds = [];
    for (const id of ids) {
      let w = rows.get(id);
      if (!w) { skipped.push({ id, reason: 'WBS 항목을 찾을 수 없습니다.' }); continue; }
      if (action === 'archive') {
        w = await t.get('SELECT * FROM wbs_items WHERE id = ?', [id]);   // may have been archived with an ancestor earlier in this request
        if (w.archived_at) { if (archivedIds.includes(id)) updated++; else skipped.push({ id, reason: '이미 보관된 항목입니다.' }); continue; }
        archivedIds.push(...await W.archiveWbs(t, project, w, userId, { skipRenumber: true }));
        updated++; continue;
      }
      if (w.archived_at) { skipped.push({ id, reason: '보관된 WBS 항목은 수정할 수 없습니다.' }); continue; }
      if (ownerBad) { skipped.push({ id, reason: 'Owner는 현재 Workspace 멤버만 지정할 수 있습니다.' }); continue; }
      if (w.item_type === 'MILESTONE' && (patch.planned_start_date !== undefined || patch.planned_end_date !== undefined)) {
        skipped.push({ id, reason: '마일스톤은 시작일/종료일 대신 마일스톤 날짜를 사용합니다.' }); continue;
      }
      const draft = { ...patch };
      if (shift) {
        if (w.item_type === 'SUMMARY') { skipped.push({ id, reason: '상위 항목의 일정은 하위 항목에서 계산되어 이동할 수 없습니다.' }); continue; }
        if (w.item_type === 'MILESTONE') {
          if (!w.milestone_date) { skipped.push({ id, reason: '날짜가 없어 이동할 수 없습니다.' }); continue; }
          draft.milestone_date = shiftDate(w.milestone_date, shift);
        } else {
          const s = draft.planned_start_date !== undefined ? draft.planned_start_date || null : w.planned_start_date;
          const e = draft.planned_end_date !== undefined ? draft.planned_end_date || null : w.planned_end_date;
          if (!s && !e) { skipped.push({ id, reason: '일정이 없어 이동할 수 없습니다.' }); continue; }
          draft.planned_start_date = shiftDate(s, shift); draft.planned_end_date = shiftDate(e, shift);
        }
      }
      let input;
      try { input = W.parseWbs(draft, { partial: true, existing: w }); } catch (e) { const m = joinMessages(e); if (m === null) throw e; skipped.push({ id, reason: m }); continue; }
      if (await W.updateWbs(t, project, w, input, userId)) updated++; else skipped.push({ id, reason: NO_CHANGE });
    }
    if (archivedIds.length) await W.renumber(t, project.id);
    return { updated, skipped, ...(action === 'archive' ? { archived_ids: archivedIds } : {}) };
  });
}
