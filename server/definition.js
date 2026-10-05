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
/** Project Chater free-text fields (2026-10-05). Stored as plain text columns; the owning section decides which work screen edits them.
 * They never gate completion — readiness (missingFor) is unchanged. API name → column. */
export const TEXT_FIELDS = { project_type: 'project_type', deliverables: 'deliverables', assumptions: 'assumptions', constraints: 'constraints_text', initial_risks: 'initial_risks', change_management: 'change_management', acceptance: 'acceptance' };
const TEXT_SECTION = { project_type: 'GOALS', deliverables: 'SCOPE', assumptions: 'SCOPE', constraints: 'SCOPE', initial_risks: 'SCOPE', change_management: 'OPERATIONS', acceptance: 'OPERATIONS' };
const TEXT_MAX = { project_type: 200 };
const textOf = (row) => Object.fromEntries(Object.entries(TEXT_FIELDS).map(([k, col]) => [k, row ? row[col] || '' : '']));
/** Stakeholder 조직 구분 (Lifecycle V2 UX): 당사 · 고객사 · 협력사 · 기타. Hierarchy = 조직 구분 → 부서 → 사람. (의사결정 권한 항목은 제거됨) */
export const ORG_TYPES = ['OWN', 'CLIENT', 'PARTNER', 'OTHER'];
export const ORG_TYPE_LABEL = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
export const ORG_TYPE_ALIAS = { OWN: ['당사', '수행사', '자사', 'own', 'vendor', 'us'], CLIENT: ['고객사', '고객', '발주사', 'client', 'customer'], PARTNER: ['협력사', '파트너', '협력업체', 'partner', 'subcontractor'], OTHER: ['기타', 'other', 'etc'] };
export const parseOrgType = (v) => { const t = String(v ?? '').trim().toLowerCase(); if (!t) return ''; if (ORG_TYPES.includes(t.toUpperCase())) return t.toUpperCase(); for (const k of ORG_TYPES) if (ORG_TYPE_ALIAS[k].some((a) => a.toLowerCase() === t)) return k; return null; };

const str = (v, max) => { const s = typeof v === 'string' ? v.trim() : ''; return max && s.length > max ? s.slice(0, max) : s; };
const parse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const EMPTY = { goal: '', success_criteria: [], scope_in: [], scope_out: [], stakeholders: [], key_dates: [], operations: {}, memo: '', section_updated: {}, ...textOf(null) };
const hydrate = (row) => (row ? {
  goal: row.goal, success_criteria: parse(row.success_criteria, []), scope_in: parse(row.scope_in, []), scope_out: parse(row.scope_out, []),
  stakeholders: parse(row.stakeholders, []), key_dates: parse(row.key_dates, []), operations: parse(row.operations, {}), memo: row.memo, ...textOf(row),
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
  for (const [f, sec] of Object.entries(TEXT_SECTION)) if (sec === key && b[f] !== undefined) {
    if (b[f] !== null && typeof b[f] !== 'string') throw new ValidationError({ [f]: '텍스트로 입력해 주세요.' });
    out[f] = str(b[f], TEXT_MAX[f] || 4000);
  }
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
        const ot = parseOrgType(x?.org_type);
        const s = { id: str(x?.id) || randomUUID(), org_type: ot || '', org: str(x?.org, 100), department: str(x?.department, 100), name: str(x?.name, 100), role: str(x?.role, 100), area: str(x?.area, 200), note: str(x?.note, 500) };
        if (ot === null) f[`stakeholders.${i}.org_type`] = '조직 구분은 당사 · 고객사 · 협력사 · 기타 중 하나여야 합니다.';
        return s;
      }).filter((s) => s.name || s.org || s.department || s.role);
      for (const s of out.stakeholders) { if (!s.name) { f.stakeholders = '이해관계자는 이름을 입력해야 합니다.'; break; } if (!s.org_type) { f.stakeholders = '이해관계자마다 조직 구분(당사 · 고객사 · 협력사 · 기타)을 선택하세요.'; break; } }
      if (out.stakeholders.length > 300) f.stakeholders = '이해관계자는 최대 300명까지 등록할 수 있습니다.';
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

/** One-line read summary of each section for the Process View ("고객사 5명 · 당사 4명 등록"). Empty string when nothing is entered. */
export function sectionSummary(key, d, ctx = {}) {
  switch (key) {
    case 'GOALS': { const parts = []; if (d.project_type) parts.push(`유형: ${d.project_type}`); if (d.goal) parts.push('목표 작성됨'); if (d.success_criteria.length) parts.push(`성공 기준 ${d.success_criteria.length}건`); return parts.join(' · '); }
    case 'SCOPE': { const parts = []; if (d.scope_in.length) parts.push(`수행 범위 ${d.scope_in.length}건`); if (d.scope_out.length) parts.push(`제외 범위 ${d.scope_out.length}건`); if (d.deliverables) parts.push('주요 산출물'); const n = ['assumptions', 'constraints', 'initial_risks'].filter((k) => d[k]).length; if (n) parts.push(`전제·제약·리스크 ${n}개 항목`); return parts.join(' · '); }
    case 'STAKEHOLDERS': { if (!d.stakeholders.length) return ''; const by = {}; for (const x of d.stakeholders) by[x.org_type || 'OTHER'] = (by[x.org_type || 'OTHER'] || 0) + 1; return ORG_TYPES.filter((k) => by[k]).map((k) => `${ORG_TYPE_LABEL[k]} ${by[k]}명`).join(' · ') + ' 등록'; }
    case 'MILESTONES': { const parts = []; if (d.key_dates.length) parts.push(`주요 일정 ${d.key_dates.length}건`); if ((ctx.wbs_milestones || []).length) parts.push(`WBS 마일스톤 ${ctx.wbs_milestones.length}건`); return parts.join(' · '); }
    case 'OPERATIONS': { const n = OPS_KEYS.filter((k) => d.operations[k]).length + ['change_management', 'acceptance'].filter((k) => d[k]).length; return n ? `운영 방식 ${n}개 항목 작성됨` : ''; }
    default: return '';
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
    const completed = st?.status === 'COMPLETED'; const skipped = st?.status === 'SKIPPED';
    const upd = d.section_updated[key] || null;
    const summary = sectionSummary(key, d, { wbs_milestones: ms });
    return { key, label: SECTION_LABEL[key], step_id: st?.id || null, title: st?.title || SECTION_LABEL[key], description: st?.description || '',
      importance: st?.importance || 'REQUIRED', skippable: (st?.importance || 'REQUIRED') !== 'REQUIRED',
      status: completed ? 'COMPLETED' : skipped ? 'SKIPPED' : 'TODO', completed_at: st?.completed_at || null, completed_by_name: st?.completed_by_name || null,
      updated_at: upd, changed_after_completion: Boolean(completed && upd && st.completed_at && new Date(upd) > new Date(st.completed_at)),
      ready: missing.length === 0, missing, summary, has_data: Boolean(summary), legacy_note: st?.note || '' };
  });
  const done = sections.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED').length;
  return { definition: d, sections, progress: { done, total: sections.length, percent: Math.round((done / sections.length) * 100) },
    needs_review: sections.filter((s) => s.changed_after_completion).map((s) => s.key),
    project_dates: { planned_start_date: project.planned_start_date, planned_end_date: project.planned_end_date }, wbs_milestones: ms };
}

/* ---------- writes ---------- */
const COLS = { goal: 'goal', success_criteria: 'success_criteria', scope_in: 'scope_in', scope_out: 'scope_out', stakeholders: 'stakeholders', key_dates: 'key_dates', operations: 'operations', memo: 'memo', ...TEXT_FIELDS };
const SECTION_OF = { goal: 'GOALS', success_criteria: 'GOALS', scope_in: 'SCOPE', scope_out: 'SCOPE', stakeholders: 'STAKEHOLDERS', key_dates: 'MILESTONES', operations: 'OPERATIONS', ...TEXT_SECTION };

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
    const base = { goal: '', success_criteria: '[]', scope_in: '[]', scope_out: '[]', stakeholders: '[]', key_dates: '[]', operations: '{}', memo: '', ...Object.fromEntries(Object.keys(TEXT_FIELDS).map((k) => [k, ''])) };
    for (const k of Object.keys(patch)) base[k] = vals(k);
    const keys = Object.keys(base);
    await db.run(`INSERT INTO project_definitions (project_id, ${keys.map((k) => COLS[k]).join(', ')}, section_updated, updated_by, created_at, updated_at)
      VALUES (${Array(keys.length + 5).fill('?').join(',')})`, [project.id, ...keys.map((k) => base[k]), JSON.stringify(su), userId, ts, ts]);
  } else {
    const sets = Object.keys(patch).map((k) => `${COLS[k]} = ?`); const params = Object.keys(patch).map(vals);
    sets.push('section_updated = ?', 'updated_by = ?', 'updated_at = ?'); params.push(JSON.stringify(su), userId, ts, project.id);
    await db.run(`UPDATE project_definitions SET ${sets.join(', ')} WHERE project_id = ?`, params);
  }
  return loadDefinition(db, project);
}

/**
 * complete | confirm | reopen | skip | resume a section — all write the INITIATION step.
 * complete/confirm need readiness and may carry the section's fields (`body`) so one click saves and completes.
 * skip is refused for REQUIRED sections; resume puts a SKIPPED section back to TODO.
 */
export async function setSectionStatus(db, project, key, action, userId, body = null) {
  if (!SECTIONS.includes(key)) return { error: 'not_found' };
  if (body && Object.keys(cleanSection(key, body)).length) await saveDefinition(db, project, body, userId);
  const model = await loadDefinition(db, project);
  const sec = model.sections.find((s) => s.key === key);
  if (!sec.step_id) return { error: 'not_found' };
  if (action === 'reopen' || action === 'resume') { await updateStep(db, project, sec.step_id, { status: 'TODO' }, userId); return { ok: true }; }
  if (action === 'skip') {
    if (!sec.skippable) throw new ValidationError({ section: '필수 업무는 건너뛸 수 없습니다.' });
    await updateStep(db, project, sec.step_id, { status: 'SKIPPED' }, userId); return { ok: true };
  }
  if (!sec.ready) throw new ValidationError({ section: sec.missing[0] });
  await updateStep(db, project, sec.step_id, { status: 'COMPLETED' }, userId);   // confirm == complete again: completed_at moves past section_updated
  return { ok: true };
}

/* ---------- stakeholder Excel (template · preview) ---------- */
export const STAKEHOLDER_COLUMNS = [
  { key: 'org_type', label: '조직 구분 *', required: true, width: 12, options: ORG_TYPES.map((k) => ORG_TYPE_LABEL[k]) },
  { key: 'org', label: '조직(회사)', width: 20 }, { key: 'department', label: '부서', width: 18 }, { key: 'name', label: '이름 *', required: true, width: 14 },
  { key: 'role', label: '역할', width: 18 }, { key: 'area', label: '담당 영역', width: 24 }, { key: 'note', label: '비고', width: 24 },
];
/** Map raw workbook rows (header text → cell) to stakeholder rows with per-row validation. */
export function previewStakeholderRows({ headers, rows }) {
  const norm = (t) => String(t || '').replace(/\s+/g, '').replace(/\*+$/, '').toLowerCase();
  const colOf = {}; for (const c of STAKEHOLDER_COLUMNS) { const h = headers.find((x) => norm(x.text) === norm(c.label)); if (h) colOf[c.key] = h.n; }
  if (!colOf.name) throw new ValidationError({ file: "'이름' 열을 찾을 수 없습니다. 템플릿의 열 제목을 사용해 주세요." });
  const out = rows.map((r) => {
    const v = (k) => (colOf[k] ? String(r.cells[colOf[k]] || '').trim() : '');
    const errors = {};
    const ot = parseOrgType(v('org_type'));
    if (!v('name')) errors.name = '이름을 입력하세요.';
    if (ot === null) errors.org_type = '당사 · 고객사 · 협력사 · 기타 중 하나여야 합니다.'; else if (!ot) errors.org_type = '조직 구분을 입력하세요.';
    const values = { org_type: ot || '', org_type_label: ot ? ORG_TYPE_LABEL[ot] : v('org_type'), org: v('org').slice(0, 100), department: v('department').slice(0, 100), name: v('name').slice(0, 100), role: v('role').slice(0, 100), area: v('area').slice(0, 200), note: v('note').slice(0, 500) };
    return { row: r.row, ok: !Object.keys(errors).length, errors, values };
  });
  return { columns: STAKEHOLDER_COLUMNS.map(({ key, label, required }) => ({ key, label, required: Boolean(required) })), rows: out, summary: { total: out.length, ok: out.filter((x) => x.ok).length, error: out.filter((x) => !x.ok).length } };
}
