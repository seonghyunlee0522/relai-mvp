/**
 * 프로젝트 정의 (Project Definition) — the structured replacement for the INITIATION phase's "description + memo + done".
 *
 * Storage: one project_definitions row per project (created lazily). Completion of each section is the status of the
 * matching INITIATION step in project_steps, so the project home / phase progress keep reading a single source and the
 * existing step records (notes, completed_at/by) are preserved untouched. Legacy step notes are surfaced read-only as
 * "참고 기록" and never parsed into structured fields.
 *
 * Rules
 * - save (PUT) is partial and always allowed (even an empty section); it stamps section_updated[key].
 * - complete (POST …/sections/:key/complete) requires the section's minimum content (readiness below).
 * - editing a completed section keeps it completed but flags `changed_after_completion` (section_updated > completed_at);
 *   confirm (POST …/confirm) re-stamps completed_at; reopen (POST …/reopen) sets the step back to TODO.
 */
import { randomUUID } from 'node:crypto';
import { ValidationError } from './validate.js';
import { updateStep } from './guide.js';

export const SECTIONS = ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS'];
export const SECTION_LABEL = { GOALS: '목표와 성공 기준', SCOPE: '수행 범위와 제외 범위', STAKEHOLDERS: '이해관계자', MILESTONES: '주요 일정과 마일스톤', OPERATIONS: '운영 방식' };
const OPS_KEYS = ['meetings', 'reporting', 'communication', 'decisions'];
const AUTHORITY = ['DECIDER', 'APPROVER', 'CONSULTED', 'INFORMED'];
export const AUTHORITY_LABEL = { DECIDER: '의사결정', APPROVER: '승인', CONSULTED: '협의', INFORMED: '공유' };

const str = (v, max) => { const s = typeof v === 'string' ? v.trim() : ''; return max && s.length > max ? s.slice(0, max) : s; };
const parse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const EMPTY = { goal: '', success_criteria: [], scope_in: [], scope_out: [], stakeholders: [], key_dates: [], operations: {}, memo: '', section_updated: {} };
const hydrate = (row) => (row ? {
  goal: row.goal, success_criteria: parse(row.success_criteria, []), scope_in: parse(row.scope_in, []), scope_out: parse(row.scope_out, []),
  stakeholders: parse(row.stakeholders, []), key_dates: parse(row.key_dates, []), operations: parse(row.operations, {}), memo: row.memo,
  section_updated: parse(row.section_updated, {}), updated_at: row.updated_at, updated_by: row.updated_by, created_at: row.created_at,
} : { ...EMPTY, updated_at: null, updated_by: null, created_at: null });

/* ---------- validation per section (returns the cleaned patch) ---------- */
const textList = (arr, field, max = 500, limit = 50) => {
  if (!Array.isArray(arr)) throw new ValidationError({ [field]: '목록 형식이 올바르지 않습니다.' });
  const out = arr.map((x) => ({ id: str(x?.id) || randomUUID(), text: str(typeof x === 'string' ? x : x?.text, max) })).filter((x) => x.text);
  if (out.length > limit) throw new ValidationError({ [field]: `최대 ${limit}개까지 등록할 수 있습니다.` });
  return out;
};
export function cleanSection(key, body = {}) {
  const b = body || {}; const out = {};
  switch (key) {
    case 'GOALS':
      if (b.goal !== undefined) out.goal = str(b.goal, 2000);
      if (b.success_criteria !== undefined) out.success_criteria = textList(b.success_criteria, 'success_criteria');
      return out;
    case 'SCOPE':
      if (b.scope_in !== undefined) out.scope_in = textList(b.scope_in, 'scope_in');
      if (b.scope_out !== undefined) out.scope_out = textList(b.scope_out, 'scope_out');
      return out;
    case 'STAKEHOLDERS': {
      if (b.stakeholders === undefined) return out;
      if (!Array.isArray(b.stakeholders)) throw new ValidationError({ stakeholders: '목록 형식이 올바르지 않습니다.' });
      const f = {};
      out.stakeholders = b.stakeholders.map((x, i) => {
        const s = { id: str(x?.id) || randomUUID(), name: str(x?.name, 100), org: str(x?.org, 100), role: str(x?.role, 100), area: str(x?.area, 200), authority: str(x?.authority), note: str(x?.note, 500) };
        if (s.authority && !AUTHORITY.includes(s.authority)) f[`stakeholders.${i}.authority`] = '권한 값이 올바르지 않습니다.';
        return s;
      }).filter((s) => s.name || s.org || s.role);
      for (const s of out.stakeholders) if (!s.name && !s.org) { f.stakeholders = '이해관계자는 이름 또는 조직 중 하나는 입력해야 합니다.'; break; }
      if (out.stakeholders.length > 100) f.stakeholders = '이해관계자는 최대 100명까지 등록할 수 있습니다.';
      if (Object.keys(f).length) throw new ValidationError(f);
      return out;
    }
    case 'MILESTONES': {
      if (b.key_dates === undefined) return out;
      if (!Array.isArray(b.key_dates)) throw new ValidationError({ key_dates: '목록 형식이 올바르지 않습니다.' });
      const f = {};
      out.key_dates = b.key_dates.map((x, i) => {
        const d = { id: str(x?.id) || randomUUID(), title: str(x?.title, 200), date: str(x?.date), note: str(x?.note, 500) };
        if (d.date && !isDate(d.date)) f[`key_dates.${i}.date`] = '날짜 형식(YYYY-MM-DD)을 확인해 주세요.';
        return d;
      }).filter((d) => d.title || d.date);
      for (const d of out.key_dates) if (!d.title) { f.key_dates = '주요 일정에는 이름이 필요합니다.'; break; }
      if (out.key_dates.length > 50) f.key_dates = '주요 일정은 최대 50개까지 등록할 수 있습니다.';
      if (Object.keys(f).length) throw new ValidationError(f);
      out.key_dates.sort((a, c) => (a.date || '9999').localeCompare(c.date || '9999'));
      return out;
    }
    case 'OPERATIONS': {
      if (b.operations === undefined) return out;
      if (typeof b.operations !== 'object' || b.operations === null) throw new ValidationError({ operations: '형식이 올바르지 않습니다.' });
      out.operations = {}; for (const k of OPS_KEYS) out.operations[k] = str(b.operations[k], 2000);
      return out;
    }
    default: throw new ValidationError({ section: '알 수 없는 섹션입니다.' });
  }
}

/** Minimum content needed before a section can be marked complete. Returns [] when ready. */
export function missingFor(key, d, ctx = {}) {
  switch (key) {
    case 'GOALS': return d.goal || d.success_criteria.length ? [] : ['프로젝트 목표 또는 성공 기준을 1개 이상 입력하세요.'];
    case 'SCOPE': return d.scope_in.length ? [] : ['수행 범위를 1개 이상 입력하세요.'];
    case 'STAKEHOLDERS': return d.stakeholders.length ? [] : ['이해관계자를 1명 이상 등록하세요.'];
    case 'MILESTONES': return d.key_dates.length || (ctx.wbs_milestones || []).length ? [] : ['주요 일정을 1개 이상 입력하거나 WBS에 마일스톤을 등록하세요.'];
    case 'OPERATIONS': return OPS_KEYS.some((k) => d.operations[k]) ? [] : ['회의·보고·소통·의사결정 중 1개 이상의 운영 방식을 입력하세요.'];
    default: return ['알 수 없는 섹션입니다.'];
  }
}

/* ---------- reads ---------- */
async function row(db, projectId) { return db.get('SELECT * FROM project_definitions WHERE project_id = ?', [projectId]); }
async function initiationSteps(db, projectId) {
  return db.all(`SELECT s.*, u.name AS completed_by_name FROM project_steps s JOIN project_phases p ON p.id = s.project_phase_id
    LEFT JOIN users u ON u.id = s.completed_by WHERE p.project_id = ? AND p.phase_key = 'INITIATION' ORDER BY s.sequence`, [projectId]);
}
async function wbsMilestones(db, projectId) {
  return db.all(`SELECT id, wbs_code, title, milestone_date, status FROM wbs_items WHERE project_id = ? AND item_type = 'MILESTONE' AND archived_at IS NULL ORDER BY milestone_date NULLS LAST, wbs_code`, [projectId]);
}

/** Full read model for the definition screen and the home card. */
export async function loadDefinition(db, project) {
  const d = hydrate(await row(db, project.id));
  const steps = await initiationSteps(db, project.id);
  const ms = await wbsMilestones(db, project.id);
  const sections = SECTIONS.map((key) => {
    const st = steps.find((s) => s.step_key === key) || null;
    const missing = missingFor(key, d, { wbs_milestones: ms });
    const completed = st?.status === 'COMPLETED';
    const upd = d.section_updated[key] || null;
    return { key, label: SECTION_LABEL[key], step_id: st?.id || null, title: st?.title || SECTION_LABEL[key], description: st?.description || '',
      status: completed ? 'COMPLETED' : 'TODO', completed_at: st?.completed_at || null, completed_by_name: st?.completed_by_name || null,
      updated_at: upd, changed_after_completion: Boolean(completed && upd && st.completed_at && new Date(upd) > new Date(st.completed_at)),
      ready: missing.length === 0, missing, legacy_note: st?.note || '' };
  });
  const done = sections.filter((s) => s.status === 'COMPLETED').length;
  return { definition: d, sections, progress: { done, total: sections.length, percent: Math.round((done / sections.length) * 100) },
    needs_review: sections.filter((s) => s.changed_after_completion).map((s) => s.key),
    project_dates: { planned_start_date: project.planned_start_date, planned_end_date: project.planned_end_date }, wbs_milestones: ms };
}

/* ---------- writes ---------- */
const COLS = { goal: 'goal', success_criteria: 'success_criteria', scope_in: 'scope_in', scope_out: 'scope_out', stakeholders: 'stakeholders', key_dates: 'key_dates', operations: 'operations', memo: 'memo' };
const SECTION_OF = { goal: 'GOALS', success_criteria: 'GOALS', scope_in: 'SCOPE', scope_out: 'SCOPE', stakeholders: 'STAKEHOLDERS', key_dates: 'MILESTONES', operations: 'OPERATIONS' };

/** Partial save. Body may carry any subset of the fields; untouched fields stay. Returns the full read model. */
export async function saveDefinition(db, project, body = {}, userId = null) {
  const b = body || {}; const patch = {};
  for (const key of SECTIONS) Object.assign(patch, cleanSection(key, b));
  if (b.memo !== undefined) patch.memo = str(b.memo, 4000);
  if (!Object.keys(patch).length) throw new ValidationError({ body: '저장할 내용이 없습니다.' });
  const existing = await row(db, project.id);
  const ts = new Date().toISOString();
  const touched = new Set(Object.keys(patch).map((k) => SECTION_OF[k]).filter(Boolean));
  const su = { ...(existing ? parse(existing.section_updated, {}) : {}) }; for (const k of touched) su[k] = ts;
  const vals = (k) => (typeof patch[k] === 'string' ? patch[k] : JSON.stringify(patch[k]));
  if (!existing) {
    const base = { goal: '', success_criteria: '[]', scope_in: '[]', scope_out: '[]', stakeholders: '[]', key_dates: '[]', operations: '{}', memo: '' };
    for (const k of Object.keys(patch)) base[k] = vals(k);
    await db.run(`INSERT INTO project_definitions (project_id, goal, success_criteria, scope_in, scope_out, stakeholders, key_dates, operations, memo, section_updated, updated_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [project.id, base.goal, base.success_criteria, base.scope_in, base.scope_out, base.stakeholders, base.key_dates, base.operations, base.memo, JSON.stringify(su), userId, ts, ts]);
  } else {
    const sets = Object.keys(patch).map((k) => `${COLS[k]} = ?`); const params = Object.keys(patch).map(vals);
    sets.push('section_updated = ?', 'updated_by = ?', 'updated_at = ?'); params.push(JSON.stringify(su), userId, ts, project.id);
    await db.run(`UPDATE project_definitions SET ${sets.join(', ')} WHERE project_id = ?`, params);
  }
  return loadDefinition(db, project);
}

/** complete | confirm | reopen a section. complete/confirm need readiness; all three write the INITIATION step. */
export async function setSectionStatus(db, project, key, action, userId) {
  if (!SECTIONS.includes(key)) return { error: 'not_found' };
  const model = await loadDefinition(db, project);
  const sec = model.sections.find((s) => s.key === key);
  if (!sec.step_id) return { error: 'not_found' };
  if (action === 'reopen') { await updateStep(db, project, sec.step_id, { status: 'TODO' }, userId); return { ok: true }; }
  if (!sec.ready) throw new ValidationError({ section: sec.missing[0] });
  await updateStep(db, project, sec.step_id, { status: 'COMPLETED' }, userId);   // confirm == complete again: completed_at moves past section_updated
  return { ok: true };
}
