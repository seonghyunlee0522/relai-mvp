/**
 * Activity checklists (06 전환·오픈 · 07 운영) — items an activity is worked through when it has no dedicated work screen.
 *
 *   item = { title, owner (free text) | owner_user_id | owner_stakeholder_id (Phase 6 US-6: one of the three), due_date (YYYY-MM-DD | null), done, note }
 *
 * Only activities listed in CHECKLIST_TEMPLATES carry a checklist. The activity's state derives from its items
 * (activities.js via loadGuide → ctx.checklists); the stored project_steps.status stays the manual 완료 처리 / 제외 mark.
 */
import { randomUUID } from 'node:crypto';
import { CHECKLIST_STEP_KEYS, CHECKLIST_TEMPLATES } from './templates/default-phases.js';
import { isDate } from './validate.js';

const now = () => new Date().toISOString();
const COLS = `i.id, i.step_id, s.step_key, i.title, i.owner, i.owner_user_id, i.owner_stakeholder_id, ou.name AS owner_user_name, i.due_date, i.done, i.done_at, i.done_by, i.note, i.sequence, i.created_at, i.updated_at`;
const FROM = `activity_checklist_items i JOIN project_steps s ON s.id = i.step_id LEFT JOIN users ou ON ou.id = i.owner_user_id`;
const ORG = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
const stakeholdersOf = async (db, projectId) => { const r = await db.get('SELECT stakeholders FROM project_definitions WHERE project_id = ?', [projectId]); try { const v = r ? JSON.parse(r.stakeholders) : []; return Array.isArray(v) ? v : []; } catch { return []; } };
/** US-6 display: "오지현 · 고객사" (stakeholder) · "정하늘" (RELAI 사용자) · the free text as typed. owner_kind = user | stakeholder | text | none. */
function withOwner(it, sh) {
  if (!it) return it;
  if (it.owner_user_id) return { ...it, owner_kind: 'user', owner_display: it.owner_user_name || '(삭제된 사용자)', owner_org: '' };
  if (it.owner_stakeholder_id) { const x = sh.find((y) => y.id === it.owner_stakeholder_id); return { ...it, owner_kind: 'stakeholder', owner_display: x ? x.name : '(삭제된 담당자)', owner_org: x ? (ORG[x.org_type] || '기타') : '' }; }
  return { ...it, owner_kind: it.owner ? 'text' : 'none', owner_display: it.owner || '', owner_org: '' };
}

/** Validate a create/patch body. Returns { fields, errors }; `partial` = PATCH (absent keys stay untouched). */
export function parseItem(body = {}, { partial = false } = {}) {
  const fields = {}; const errors = {};
  const str = (k, max, label, required = false) => {
    if (body[k] === undefined) { if (required && !partial) errors[k] = `${label}을(를) 입력해 주세요.`; return; }
    if (body[k] === null && !required) { fields[k] = ''; return; }
    if (typeof body[k] !== 'string') { errors[k] = `${label} 값이 올바르지 않습니다.`; return; }
    const v = body[k].trim();
    if (required && !v) errors[k] = `${label}을(를) 입력해 주세요.`;
    else if (v.length > max) errors[k] = `${label}은(는) ${max.toLocaleString('ko-KR')}자 이내로 입력해 주세요.`;
    else fields[k] = v;
  };
  str('title', 200, '항목', true);
  str('owner', 100, '담당');
  // US-6: one select value — '' (미지정) · 'u:<user id>' · 's:<stakeholder id>'; the free text stays in `owner` (직접 입력)
  if (body.owner_ref !== undefined) {
    const v = typeof body.owner_ref === 'string' ? body.owner_ref : '';
    if (/^u:./.test(v)) { fields.owner_user_id = v.slice(2); fields.owner_stakeholder_id = null; fields.owner = ''; }
    else if (/^s:./.test(v)) { fields.owner_stakeholder_id = v.slice(2); fields.owner_user_id = null; fields.owner = ''; }
    else if (v === '') { fields.owner_user_id = null; fields.owner_stakeholder_id = null; if (fields.owner === undefined) fields.owner = ''; }
    else errors.owner_ref = '담당 값이 올바르지 않습니다.';
  } else if (fields.owner !== undefined) { fields.owner_user_id = null; fields.owner_stakeholder_id = null; }   // 직접 입력 replaces a picked owner
  str('note', 2000, '메모');
  if (body.due_date !== undefined) {
    if (body.due_date === null || body.due_date === '') fields.due_date = null;
    else if (typeof body.due_date !== 'string' || !isDate(body.due_date)) errors.due_date = '기한은 YYYY-MM-DD 형식으로 입력해 주세요.';
    else fields.due_date = body.due_date;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== 'boolean') errors.done = '완료 값이 올바르지 않습니다.';
    else fields.done = body.done;
  }
  return { fields, errors };
}

/** The project's step row if it exists and carries a checklist; `false` = step exists but has no checklist; null = not found. */
export async function checklistStep(db, projectId, stepId) {
  const st = await db.get(`SELECT s.* FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id WHERE s.id = ? AND p.project_id = ?`, [stepId, projectId]);
  if (!st) return null;
  return CHECKLIST_STEP_KEYS.has(st.step_key) ? st : false;
}

export async function listItems(db, projectId) {
  const sh = await stakeholdersOf(db, projectId);
  return (await db.all(`SELECT ${COLS} FROM ${FROM} WHERE i.project_id = ? ORDER BY i.step_id, i.sequence, i.created_at`, [projectId])).map((it) => withOwner(it, sh));
}

export async function getItem(db, projectId, itemId) {
  return withOwner(await db.get(`SELECT ${COLS} FROM ${FROM} WHERE i.id = ? AND i.project_id = ?`, [itemId, projectId]), await stakeholdersOf(db, projectId));
}
/** US-6 picker groups: RELAI 사용자 / 팀원 (계정 없음) / 고객사 — the Phase 5 수행자 groups. Validates a picked id belongs to this project. */
export async function ownerValid(db, project, fields) {
  if (fields.owner_user_id) return Boolean(await db.get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [project.workspace_id, fields.owner_user_id]));
  if (fields.owner_stakeholder_id) return (await stakeholdersOf(db, project.id)).some((x) => x.id === fields.owner_stakeholder_id && x.name);
  return true;
}

/** { [step_id]: { total, done } } for loadGuide → activityStates. */
export async function checklistSummary(db, projectId) {
  const rows = await db.all(`SELECT step_id, COUNT(*) AS total, SUM(done::int) AS done FROM activity_checklist_items WHERE project_id = ? GROUP BY step_id`, [projectId]);
  return Object.fromEntries(rows.map((r) => [r.step_id, { total: Number(r.total) || 0, done: Number(r.done) || 0 }]));
}

export async function createItem(db, projectId, step, fields, userId) {
  const id = randomUUID(); const ts = now();
  const seq = Number((await db.get('SELECT COALESCE(MAX(sequence), 0) AS m FROM activity_checklist_items WHERE step_id = ?', [step.id])).m) + 1;
  const done = Boolean(fields.done);
  await db.run(`INSERT INTO activity_checklist_items (id, project_id, step_id, title, owner, owner_user_id, owner_stakeholder_id, due_date, done, done_at, done_by, note, sequence, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, projectId, step.id, fields.title, fields.owner || '', fields.owner_user_id || null, fields.owner_stakeholder_id || null, fields.due_date || null, done, done ? ts : null, done ? userId : null, fields.note || '', seq, userId, ts, ts]);
  return getItem(db, projectId, id);
}

/** Adds the template's starter items that the activity does not have yet (matched by title). Returns how many were added. */
export async function addDefaults(db, projectId, step, userId) {
  const have = new Set((await db.all('SELECT title FROM activity_checklist_items WHERE step_id = ?', [step.id])).map((r) => r.title));
  let added = 0;
  for (const title of CHECKLIST_TEMPLATES[step.step_key] || []) {
    if (have.has(title)) continue;
    await createItem(db, projectId, step, { title }, userId); added += 1;
  }
  return added;
}

export async function updateItem(db, projectId, itemId, fields, userId) {
  const cur = await getItem(db, projectId, itemId);
  if (!cur) return null;
  const ts = now(); const sets = ['updated_at = ?']; const vals = [ts];
  for (const k of ['title', 'owner', 'owner_user_id', 'owner_stakeholder_id', 'due_date', 'note']) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (fields.done !== undefined && fields.done !== cur.done) {
    sets.push('done = ?', 'done_at = ?', 'done_by = ?'); vals.push(fields.done, fields.done ? ts : null, fields.done ? userId : null);
  }
  vals.push(itemId, projectId);
  await db.run(`UPDATE activity_checklist_items SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`, vals);
  return getItem(db, projectId, itemId);
}

export async function deleteItem(db, projectId, itemId) {
  const r = await db.run('DELETE FROM activity_checklist_items WHERE id = ? AND project_id = ?', [itemId, projectId]);
  return Boolean(r && (r.changes ?? r.rowCount));
}
