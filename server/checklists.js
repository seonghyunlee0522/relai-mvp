/**
 * Activity checklists (06 전환·오픈 · 07 운영) — items an activity is worked through when it has no dedicated work screen.
 *
 *   item = { title, owner (free text), due_date (YYYY-MM-DD | null), done, note }
 *
 * Only activities listed in CHECKLIST_TEMPLATES carry a checklist. The activity's state derives from its items
 * (activities.js via loadGuide → ctx.checklists); the stored project_steps.status stays the manual 완료 처리 / 제외 mark.
 */
import { randomUUID } from 'node:crypto';
import { CHECKLIST_STEP_KEYS, CHECKLIST_TEMPLATES } from './templates/default-phases.js';

const now = () => new Date().toISOString();
const COLS = `i.id, i.step_id, s.step_key, i.title, i.owner, i.due_date, i.done, i.done_at, i.done_by, i.note, i.sequence, i.created_at, i.updated_at`;

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
  str('note', 2000, '메모');
  if (body.due_date !== undefined) {
    if (body.due_date === null || body.due_date === '') fields.due_date = null;
    else if (typeof body.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date) || Number.isNaN(Date.parse(`${body.due_date}T00:00:00Z`))) errors.due_date = '기한은 YYYY-MM-DD 형식으로 입력해 주세요.';
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
  return db.all(`SELECT ${COLS} FROM activity_checklist_items i JOIN project_steps s ON s.id = i.step_id
    WHERE i.project_id = ? ORDER BY i.step_id, i.sequence, i.created_at`, [projectId]);
}

export async function getItem(db, projectId, itemId) {
  return db.get(`SELECT ${COLS} FROM activity_checklist_items i JOIN project_steps s ON s.id = i.step_id WHERE i.id = ? AND i.project_id = ?`, [itemId, projectId]);
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
  await db.run(`INSERT INTO activity_checklist_items (id, project_id, step_id, title, owner, due_date, done, done_at, done_by, note, sequence, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, projectId, step.id, fields.title, fields.owner || '', fields.due_date || null, done, done ? ts : null, done ? userId : null, fields.note || '', seq, userId, ts, ts]);
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
  for (const k of ['title', 'owner', 'due_date', 'note']) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
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
