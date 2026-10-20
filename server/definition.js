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
import { randomUUID, createHash } from 'node:crypto';
import { ValidationError, isDate } from './validate.js';
import { updateStep } from './guide.js';
import { parseTraits } from './validate.js';
import { TRAIT_FIELDS } from '../public/app/shared/project-traits.js';

/** Definition sections (counted in progress d.done/d.total) + the two 착수 gate activities (Phase 1 v2): 착수보고회 and 착수 결과 승인.
 * All seven are INITIATION steps edited on the 프로젝트 정의 screen; KICKOFF/APPROVAL drive their own guidance (guidance.js), not progress. */
export const CORE_SECTIONS = ['GOALS', 'SCOPE', 'STAKEHOLDERS', 'MILESTONES', 'OPERATIONS'];
export const GATE_SECTIONS = ['KICKOFF', 'APPROVAL'];
export const SECTIONS = [...CORE_SECTIONS, ...GATE_SECTIONS];
export const SECTION_LABEL = { GOALS: '목표와 성공 기준', SCOPE: '수행 범위 · 적용 환경', STAKEHOLDERS: '관계자', MILESTONES: '주요 일정과 마일스톤', OPERATIONS: '운영 방식', KICKOFF: '착수보고회', APPROVAL: '착수 결과 승인' };
/** 승인 방법. KICKOFF ("착수보고회에서 승인") is hidden in the UI when the 착수보고회 activity was skipped. */
export const APPROVAL_METHODS = { SIGNED: '서명본 수령', EMAIL: '이메일 회신', KICKOFF: '착수보고회에서 승인', OTHER: '기타' };
/** 요구사항 기준선 승인 (02, Phase 2) — the same approval record, its own method list. */
export const REQ_APPROVAL_METHODS = { SIGNED: '서명본 수령', EMAIL: '이메일 회신', REVIEW: '검토 회의에서 승인', OTHER: '기타' };
export const KICKOFF_PREP_DEFAULT = ['안건 확정', '발표자료(사업수행계획서) 준비', '참석자 초대 발송', '회의실·화상회의 준비'];
export const KICKOFF_AGENDA_DEFAULT = '1. 프로젝트 개요·목표\n2. 범위\n3. 추진 조직\n4. 일정\n5. 운영 방식\n6. 질의응답';
/** "[승인 전 진행] 사유 · 날짜 · 이름" lines in the APPROVAL step note (written by the 01→02 dialog through the step note API). */
export const BYPASS_TAG = '[승인 전 진행]';
/** The fixed reason the 01→02 dialog writes since batch7 #5 (착수 승인 = 권장, no reason asked; public/app/project/initiation.js NO_REASON). */
export const NO_REASON = '승인 없이 진행';
export function parseBypass(note) {
  const lines = String(note || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x.startsWith(BYPASS_TAG));
  if (!lines.length) return null;
  const parts = lines[lines.length - 1].slice(BYPASS_TAG.length).trim().split(' · ');
  const name = parts.length >= 3 ? parts.pop() : ''; const date = parts.length >= 2 ? parts.pop() : '';
  return { reason: parts.join(' · '), date, name, count: lines.length };
}
const APP_TZ = () => process.env.APP_TIMEZONE || 'Asia/Seoul';
/** Today (YYYY-MM-DD) and now (YYYY-MM-DDTHH:MM) in the app's time zone — the 승인일 / 착수보고회 일시 checks use local dates. */
export const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const localNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const OPS_KEYS = ['meetings', 'reporting', 'communication', 'decisions'];
/** 적용 환경 (batch7 #2): where the product must run — not features (기능 범위 = 요구사항의 범위 IN/OUT). Each choice is 지원 / 미지원;
 * an option left unchosen is simply not stated. Free fields: OS, 최소 해상도, 언어. Shared with the client (public/app/shared/environments.js). */
export { ENV_DEVICES, ENV_BROWSERS, ENV_TEXT, ENV_STATUS, ENV_GROUPS, envSummary, envLines, hasEnvironment } from '../public/app/shared/environments.js';
import { ENV_DEVICES, ENV_BROWSERS, ENV_TEXT, ENV_STATUS, envSummary, hasEnvironment } from '../public/app/shared/environments.js';
/** Project Charter free-text fields (2026-10-05). Stored as plain text columns; the owning section decides which work screen edits them.
 * They never gate completion — readiness (missingFor) is unchanged. API name → column. */
export const TEXT_FIELDS = { deliverables: 'deliverables', assumptions: 'assumptions', constraints: 'constraints_text', initial_risks: 'initial_risks', change_management: 'change_management', acceptance: 'acceptance' };
const TEXT_SECTION = { deliverables: 'SCOPE', assumptions: 'SCOPE', constraints: 'SCOPE', initial_risks: 'SCOPE', change_management: 'OPERATIONS', acceptance: 'OPERATIONS' };
const TEXT_MAX = {};
// project_definitions.project_type (free text, 2026-10-05 morning) is superseded by projects.project_type (enum, 프로젝트 기본 특성):
// read-only here as a fallback label for the Charter; `project_type` in a save body is the enum and goes to the project.
const textOf = (row) => ({ ...Object.fromEntries(Object.entries(TEXT_FIELDS).map(([k, col]) => [k, row ? row[col] || '' : ''])), project_type: row ? row.project_type || '' : '' });
/** Stakeholder 조직 구분 (Lifecycle V2 UX): 당사 · 고객사 · 협력사 · 기타. Hierarchy = 조직 구분 → 부서 → 사람. (의사결정 권한 항목은 제거됨) */
export const ORG_TYPES = ['OWN', 'CLIENT', 'PARTNER', 'OTHER'];
export const ORG_TYPE_LABEL = { OWN: '당사', CLIENT: '고객사', PARTNER: '협력사', OTHER: '기타' };
export const ORG_TYPE_ALIAS = { OWN: ['당사', '수행사', '자사', 'own', 'vendor', 'us'], CLIENT: ['고객사', '고객', '발주사', 'client', 'customer'], PARTNER: ['협력사', '파트너', '협력업체', 'partner', 'subcontractor'], OTHER: ['기타', 'other', 'etc'] };
export const parseOrgType = (v) => { const t = String(v ?? '').trim().toLowerCase(); if (!t) return ''; if (ORG_TYPES.includes(t.toUpperCase())) return t.toUpperCase(); for (const k of ORG_TYPES) if (ORG_TYPE_ALIAS[k].some((a) => a.toLowerCase() === t)) return k; return null; };

const str = (v, max) => { const s = typeof v === 'string' ? v.trim() : ''; return max && s.length > max ? s.slice(0, max) : s; };
const parse = (s, fb) => { try { const v = JSON.parse(s); return v ?? fb; } catch { return fb; } };

/** A 착수보고회 never saved starts with the default 준비 체크 and 안건 example (spec US-1). */
const kickoffOf = (raw) => {
  const k = raw && typeof raw === 'object' ? raw : {};
  const fresh = !Object.keys(k).length;
  return { datetime: k.datetime || '', place: k.place || '', attendees: Array.isArray(k.attendees) ? k.attendees : [],
    prep: Array.isArray(k.prep) ? k.prep : fresh ? KICKOFF_PREP_DEFAULT.map((text, i) => ({ id: `prep-${i + 1}`, text, done: false })) : [],
    agenda: k.agenda !== undefined ? k.agenda : KICKOFF_AGENDA_DEFAULT, minutes: k.minutes || '',
    decisions: Array.isArray(k.decisions) ? k.decisions : [], followups: Array.isArray(k.followups) ? k.followups : [] };
};
export const approvalOf = (raw) => {
  const a = raw && typeof raw === 'object' ? raw : {};
  return { approver_id: a.approver_id || '', approver_name: a.approver_name || '', approver_title: a.approver_title || '', date: a.date || '', method: a.method || '',
    evidence: a.evidence || '', conditions: a.conditions || '', baseline: a.baseline || null };
};
const envOf = (raw) => {
  const e = raw && typeof raw === 'object' ? raw : {};
  const pick = (src, opts) => Object.fromEntries(opts.map(([k]) => [k, src && ENV_STATUS[src[k]] ? src[k] : null]).filter(([, v]) => v));
  return { devices: pick(e.devices, ENV_DEVICES), browsers: pick(e.browsers, ENV_BROWSERS), ...Object.fromEntries(ENV_TEXT.map(([k]) => [k, typeof e[k] === 'string' ? e[k] : ''])) };
};
const EMPTY = { environments: envOf(null), goal: '', success_criteria: [], scope_in: [], scope_out: [], stakeholders: [], key_dates: [], operations: {}, memo: '', section_updated: {}, kickoff: kickoffOf(null), approval: approvalOf(null), ...textOf(null) };
const hydrate = (row) => (row ? {
  environments: envOf(parse(row.environments, {})), goal: row.goal, success_criteria: parse(row.success_criteria, []), scope_in: parse(row.scope_in, []), scope_out: parse(row.scope_out, []),
  stakeholders: parse(row.stakeholders, []), key_dates: parse(row.key_dates, []), operations: parse(row.operations, {}), memo: row.memo, ...textOf(row),
  kickoff: kickoffOf(parse(row.kickoff, {})), approval: approvalOf(parse(row.approval, {})),
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
      if (b.environments !== undefined) {
        const e = b.environments; if (typeof e !== 'object' || e === null) throw new ValidationError({ environments: '형식이 올바르지 않습니다.' });
        const f = {};
        for (const [grp, opts] of [['devices', ENV_DEVICES], ['browsers', ENV_BROWSERS]]) for (const [k, v] of Object.entries(e[grp] || {})) {
          if (!opts.some(([o]) => o === k)) f[`environments.${grp}`] = '목록에 없는 항목입니다.'; else if (v !== null && v !== '' && !ENV_STATUS[v]) f[`environments.${grp}.${k}`] = '지원 또는 미지원을 고르세요.';
        }
        if (Object.keys(f).length) throw new ValidationError(f);
        out.environments = { ...envOf(e), ...Object.fromEntries(ENV_TEXT.map(([k, , max]) => [k, str(e[k], max)])) };
      }
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
      for (const s of out.stakeholders) { if (!s.name) { f.stakeholders = '관계자는 이름을 입력해야 합니다.'; break; } if (!s.org_type) { f.stakeholders = '관계자마다 조직 구분(당사 · 고객사 · 협력사 · 기타)을 선택하세요.'; break; } }
      if (out.stakeholders.length > 300) f.stakeholders = '관계자는 최대 300명까지 등록할 수 있습니다.';
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
    case 'KICKOFF': {
      if (b.kickoff === undefined) return out;
      const k = b.kickoff; if (typeof k !== 'object' || k === null) throw new ValidationError({ kickoff: '형식이 올바르지 않습니다.' });
      const f = {};
      const dt = str(k.datetime);
      if (dt && (!/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/.test(dt) || !isDate(dt.slice(0, 10)))) f['kickoff.datetime'] = '일시 형식(YYYY-MM-DD HH:MM)을 확인해 주세요.';
      const list = (arr, field, limit) => { if (arr === undefined) return []; if (!Array.isArray(arr)) { f[`kickoff.${field}`] = '목록 형식이 올바르지 않습니다.'; return []; } if (arr.length > limit) f[`kickoff.${field}`] = `최대 ${limit}개까지 등록할 수 있습니다.`; return arr.slice(0, limit); };
      const followups = list(k.followups, 'followups', 50).map((x) => ({ id: str(x?.id) || randomUUID(), text: str(x?.text, 300), owner: str(x?.owner, 100), due: str(x?.due), done: Boolean(x?.done) })).filter((x) => x.text);
      for (const x of followups) if (x.due && !isDate(x.due)) { f['kickoff.followups'] = '후속 조치 기한 형식(YYYY-MM-DD)을 확인해 주세요.'; break; }
      out.kickoff = { datetime: dt, place: str(k.place, 200),
        attendees: [...new Set(list(k.attendees, 'attendees', 300).map((x) => str(x, 64)).filter(Boolean))],
        prep: list(k.prep, 'prep', 20).map((x) => ({ id: str(x?.id) || randomUUID(), text: str(typeof x === 'string' ? x : x?.text, 200), done: Boolean(x?.done) })).filter((x) => x.text),
        agenda: str(k.agenda, 2000), minutes: str(k.minutes, 4000),
        decisions: list(k.decisions, 'decisions', 50).map((x) => ({ id: str(x?.id) || randomUUID(), text: str(typeof x === 'string' ? x : x?.text, 500) })).filter((x) => x.text),
        followups };
      if (Object.keys(f).length) throw new ValidationError(f);
      return out;
    }
    case 'APPROVAL':
      if (b.approval !== undefined) out.approval = cleanApproval(b.approval, APPROVAL_METHODS);
      return out;
    default: throw new ValidationError({ section: '알 수 없는 섹션입니다.' });
  }
}

/* ---------- approval record (shared: 01 착수 결과 승인 · 02 요구사항 기준선 승인) ---------- */
/** Validate one approval record (partial: empty fields are allowed while drafting; approvalMissing decides completion). */
export function cleanApproval(a, methods, field = 'approval') {
  if (typeof a !== 'object' || a === null) throw new ValidationError({ [field]: '형식이 올바르지 않습니다.' });
  const f = {};
  const date = str(a.date); const method = str(a.method);
  if (date && !isDate(date)) f[`${field}.date`] = '날짜 형식(YYYY-MM-DD)을 확인해 주세요.';
  else if (date && date > localToday()) f[`${field}.date`] = '승인일은 오늘 이후일 수 없습니다.';
  if (method && !methods[method]) f[`${field}.method`] = '승인 방법을 목록에서 선택하세요.';
  if (Object.keys(f).length) throw new ValidationError(f);
  return { approver_id: str(a.approver_id, 64), approver_name: str(a.approver_name, 100), approver_title: str(a.approver_title, 100), date, method,
    evidence: str(a.evidence, 300), conditions: str(a.conditions, 2000), add_to_stakeholders: a.add_to_stakeholders !== false };
}
/** What still blocks 완료 처리 of an approval record: 승인자 · 승인일 (≤ today) · 방법 · 근거. */
export function approvalMissing(a, who) {
  const out = [];
  if (!who) out.push(a.approver_id ? '선택한 승인자가 관계자 목록에 없습니다. 승인자를 다시 선택하세요.' : '승인자를 선택하거나 직접 입력하세요.');
  if (!a.date) out.push('승인일을 입력하세요.'); else if (a.date > localToday()) out.push('승인일은 오늘 이후일 수 없습니다.');
  if (!a.method) out.push('승인 방법을 선택하세요.');
  if (!a.evidence) out.push('승인 근거(문서번호·메일 제목·보관 위치 등)를 입력하세요.');
  return out;
}
/** A directly entered approver added to 이해관계자 (CLIENT). Not an edit of the 이해관계자 activity, so its section stamp is left alone. */
export function approverStakeholder(project, a, area) {
  return { id: randomUUID(), org_type: 'CLIENT', org: project.client_name || '', department: '', name: a.approver_name, role: a.approver_title, area, note: '' };
}
/** Append one stakeholder row without touching section_updated (creates the definition row when missing). */
export async function appendStakeholder(db, project, sh, userId = null) {
  await ensureRow(db, project.id, userId);
  const existing = await row(db, project.id);
  await db.run('UPDATE project_definitions SET stakeholders = ?, updated_at = ? WHERE project_id = ?', [JSON.stringify([...parse(existing.stakeholders, []), sh]), new Date().toISOString(), project.id]);
}
/** The definition row with every column at its default (no section stamped). */
export async function ensureRow(db, projectId, userId = null) {
  await db.run('INSERT INTO project_definitions (project_id, updated_by) VALUES (?, ?) ON CONFLICT (project_id) DO NOTHING', [projectId, userId]);
}

/* ---------- 착수 결과 승인: approver + re-approval baseline ---------- */
/** The approver as shown everywhere (stakeholder row when linked, otherwise the directly entered name/title). */
export function approverOf(d, a = d.approval || {}) {
  const sh = a.approver_id ? (d.stakeholders || []).find((s) => s.id === a.approver_id) : null;
  if (sh) return { id: sh.id, name: sh.name, title: sh.role || '', org: [sh.org, sh.department].filter(Boolean).join(' '), linked: true };
  if (a.approver_name) return { id: null, name: a.approver_name, title: a.approver_title || '', org: '', linked: false };
  return null;
}
/** What the customer approved: 목표·성공 기준 · 수행/제외 범위·산출물 · 상위 일정 · 승인자 행. Any change after approval → 다시 확인 필요.
 * (Other stakeholder rows, 전제·제약·리스크 and 운영 방식 are deliberately not part of it — spec C1.) */
export function approvalFingerprint(d) {
  const t = (l) => (l || []).map((x) => (typeof x === 'string' ? x : x.text || '')).filter(Boolean);
  const a = d.approval || {};
  const sh = a.approver_id ? (d.stakeholders || []).find((s) => s.id === a.approver_id) : null;
  // 적용 환경 joins the approved content only once it is filled, so projects approved before batch7 keep their fingerprint
  const env = hasEnvironment(d.environments) ? { env: envSummary(d.environments) } : {};
  const basis = { ...env, goal: d.goal || '', success: t(d.success_criteria), in: t(d.scope_in), out: t(d.scope_out), deliverables: d.deliverables || '',
    dates: (d.key_dates || []).map((k) => [k.title || '', k.date || '']),
    approver: a.approver_id ? (sh ? [sh.org_type, sh.org, sh.department, sh.name, sh.role, sh.area || ''] : 'deleted') : [a.approver_name || '', a.approver_title || ''] };
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 24);
}

/** Minimum content needed before a section can be marked complete. Returns [] when ready. */
export function missingFor(key, d, ctx = {}) {
  switch (key) {
    case 'GOALS': return d.goal || d.success_criteria.length ? [] : ['프로젝트 목표 또는 성공 기준을 1개 이상 입력하세요.'];
    // batch7 #2: 지원 환경 1개 이상. A project that already listed 수행 범위 (환경·조건 메모) before batch7 still counts (하위 호환).
    case 'SCOPE': return hasEnvironment(d.environments, 'SUPPORTED') || d.scope_in.length ? [] : ['지원 환경(기기 또는 브라우저)을 1개 이상 선택하세요.'];
    case 'STAKEHOLDERS': return d.stakeholders.length ? [] : ['관계자를 1명 이상 등록하세요.'];
    case 'MILESTONES': return d.key_dates.length || (ctx.wbs_milestones || []).length ? [] : ['주요 일정을 1개 이상 입력하거나 WBS에 마일스톤을 등록하세요.'];
    case 'OPERATIONS': return OPS_KEYS.some((k) => d.operations[k]) ? [] : ['회의·보고·소통·의사결정 중 1개 이상의 운영 방식을 입력하세요.'];
    case 'KICKOFF': {
      const k = d.kickoff || {}; const out = [];
      if (!k.datetime) out.push('착수보고회 일시를 입력하세요.');
      else if (k.datetime.slice(0, 16) > localNow()) out.push('착수보고회가 아직 열리지 않았습니다. 개최한 뒤 완료 처리하세요.');
      if (!(k.minutes || (k.decisions || []).length)) out.push('회의록 요약 또는 결정사항을 1개 이상 입력하세요.');
      return out;
    }
    case 'APPROVAL': return approvalMissing(d.approval || {}, approverOf(d));
    default: return ['알 수 없는 섹션입니다.'];
  }
}

/** One-line read summary of each section for the Process View ("고객사 5명 · 당사 4명 등록"). Empty string when nothing is entered. */
export function sectionSummary(key, d, ctx = {}) {
  switch (key) {
    case 'GOALS': { const parts = []; if (d.goal) parts.push('목표 작성됨'); if (d.success_criteria.length) parts.push(`성공 기준 ${d.success_criteria.length}건`); return parts.join(' · '); }
    case 'SCOPE': { const parts = []; const env = envSummary(d.environments); if (env) parts.push(env); const memo = d.scope_in.length + d.scope_out.length; if (memo) parts.push(`환경·조건 메모 ${memo}건`); if (d.deliverables) parts.push('주요 산출물'); const n = ['assumptions', 'constraints', 'initial_risks'].filter((k) => d[k]).length; if (n) parts.push(`전제·제약·리스크 ${n}개 항목`); return parts.join(' · '); }
    case 'STAKEHOLDERS': { if (!d.stakeholders.length) return ''; const by = {}; for (const x of d.stakeholders) by[x.org_type || 'OTHER'] = (by[x.org_type || 'OTHER'] || 0) + 1; return ORG_TYPES.filter((k) => by[k]).map((k) => `${ORG_TYPE_LABEL[k]} ${by[k]}명`).join(' · ') + ' 등록'; }
    case 'MILESTONES': { const parts = []; if (d.key_dates.length) parts.push(`주요 일정 ${d.key_dates.length}건`); if ((ctx.wbs_milestones || []).length) parts.push(`WBS 마일스톤 ${ctx.wbs_milestones.length}건`); return parts.join(' · '); }
    case 'OPERATIONS': { const n = OPS_KEYS.filter((k) => d.operations[k]).length + ['change_management', 'acceptance'].filter((k) => d[k]).length; return n ? `운영 방식 ${n}개 항목 작성됨` : ''; }
    case 'KICKOFF': {
      const k = d.kickoff || {}; const when = k.datetime ? `${k.datetime.slice(5, 7)}/${k.datetime.slice(8, 10)}${k.datetime.length > 10 ? ` ${k.datetime.slice(11, 16)}` : ''}` : '';
      if (!when) return (k.prep || []).some((x) => x.done) || k.minutes || (k.decisions || []).length ? '일시 미정' : '';
      if (k.datetime.slice(0, 16) > localNow()) { const p = k.prep || []; return p.length ? `준비 중 · ${p.filter((x) => x.done).length}/${p.length} · ${when}` : `예정 · ${when}`; }
      const parts = [`개최 ${when}`]; if ((k.attendees || []).length) parts.push(`참석 ${k.attendees.length}명`); if ((k.decisions || []).length) parts.push(`결정사항 ${k.decisions.length}건`);
      return parts.join(' · ');
    }
    case 'APPROVAL': {
      const a = d.approval || {}; const who = approverOf(d);
      const parts = []; if (who) parts.push(`${who.name}${who.title ? ` ${who.title}` : ''}`); if (a.date) parts.push(a.date); if (a.method) parts.push(APPROVAL_METHODS[a.method]);
      return parts.join(' · ');
    }
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
    let summary = sectionSummary(key, d, { wbs_milestones: ms });
    let changed = Boolean(completed && upd && st.completed_at && new Date(upd) > new Date(st.completed_at));
    let reapproval = false; let bypass = null;
    if (key === 'APPROVAL') {
      // 승인 후 변경 감지: the approved content (fingerprint at 완료 처리) no longer matches → 다시 확인 필요 (spec US-2, C1)
      reapproval = Boolean(completed && d.approval.baseline && d.approval.baseline !== approvalFingerprint(d));
      changed = changed || reapproval;
      bypass = completed ? null : parseBypass(st?.note);
      // batch7 #5: the 01 gate asks no reason any more ("승인 없이 진행"); older notes keep their 사유
      const bl = bypass && bypass.reason === NO_REASON ? NO_REASON : '승인 전 진행 · 사유 있음';
      if (bypass) summary = summary ? `${bl} · ${summary}` : bl;
    }
    if (key === 'KICKOFF' && completed) { const open = (d.kickoff.followups || []).filter((x) => !x.done).length; if (open) summary = `${summary} · 후속 조치 ${open}건 남음`; }
    return { key, label: SECTION_LABEL[key], step_id: st?.id || null, title: st?.title || SECTION_LABEL[key], description: st?.description || '',
      importance: st?.importance || 'REQUIRED', skippable: (st?.importance || 'REQUIRED') !== 'REQUIRED', gate: GATE_SECTIONS.includes(key),
      status: completed ? 'COMPLETED' : skipped ? 'SKIPPED' : 'TODO', completed_at: st?.completed_at || null, completed_by_name: st?.completed_by_name || null,
      updated_at: upd, changed_after_completion: changed, reapproval, bypass,
      ready: missing.length === 0, missing, summary, has_data: Boolean(summary), legacy_note: st?.note || '' };
  }).filter((s) => !GATE_SECTIONS.includes(s.key) || s.step_id);   // a project whose 01 has no gate steps yet (before migration 31) shows the five
  // progress counts the five definition sections only; 착수보고회 / 승인 have their own guidance state (spec §4)
  const core = sections.filter((s) => CORE_SECTIONS.includes(s.key));
  const done = core.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED').length;
  const apv = sections.find((s) => s.key === 'APPROVAL') || null; const kick = sections.find((s) => s.key === 'KICKOFF') || null;
  return { definition: d, sections, progress: { done, total: core.length, percent: Math.round((done / core.length) * 100) },
    needs_review: sections.filter((s) => s.changed_after_completion).map((s) => s.key),
    // 착수 gate state for guidance / Charter / export: approval status (TODO · COMPLETED · REAPPROVAL), approver, bypass reason
    initiation_gate: { approval: apv ? { status: apv.status === 'COMPLETED' ? (apv.reapproval ? 'REAPPROVAL' : 'COMPLETED') : 'TODO', step_id: apv.step_id, bypass: apv.bypass, approver: approverOf(d), method_label: APPROVAL_METHODS[d.approval.method] || '' } : null,
      kickoff: kick ? { status: kick.status, step_id: kick.step_id } : null },
    project_dates: { planned_start_date: project.planned_start_date, planned_end_date: project.planned_end_date }, wbs_milestones: ms,
    // 프로젝트 기본 특성 live on projects (same values as the create form); shown and edited here, never part of a step's completion
    project_traits: Object.fromEntries(TRAIT_FIELDS.map((k) => [k, project[k] ?? (k === 'project_type' ? null : 'TBD')])) };
}

/* ---------- writes ---------- */
const COLS = { environments: 'environments', goal: 'goal', success_criteria: 'success_criteria', scope_in: 'scope_in', scope_out: 'scope_out', stakeholders: 'stakeholders', key_dates: 'key_dates', operations: 'operations', memo: 'memo', kickoff: 'kickoff', approval: 'approval', ...TEXT_FIELDS };
const SECTION_OF = { environments: 'SCOPE', goal: 'GOALS', success_criteria: 'GOALS', scope_in: 'SCOPE', scope_out: 'SCOPE', stakeholders: 'STAKEHOLDERS', key_dates: 'MILESTONES', operations: 'OPERATIONS', kickoff: 'KICKOFF', approval: 'APPROVAL', ...TEXT_SECTION };

/** Partial save. Body may carry any subset of the fields; untouched fields stay. Returns the full read model. */
export async function saveDefinition(db, project, body = {}, userId = null) {
  const b = body || {}; const patch = {};
  // 프로젝트 기본 특성: same save flow as the rest of the definition, stored on projects. Saving them never completes anything.
  const tf = {}; const traits = parseTraits(b, tf, { partial: true });
  if (Object.keys(tf).length) throw new ValidationError(tf);
  if (Object.keys(traits).length) {
    const keys = Object.keys(traits);
    await db.run(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, [...keys.map((k) => traits[k]), project.id]);
    project = { ...project, ...traits };
  }
  for (const key of SECTIONS) Object.assign(patch, cleanSection(key, b));
  if (b.memo !== undefined) patch.memo = str(b.memo, 4000);
  if (!Object.keys(patch).length) {
    if (Object.keys(traits).length) return loadDefinition(db, project);
    throw new ValidationError({ body: '저장할 내용이 없습니다.' });
  }
  const existing = await row(db, project.id);
  const ts = new Date().toISOString();
  const touched = new Set(Object.keys(patch).map((k) => SECTION_OF[k]).filter(Boolean));
  if (patch.approval) {
    const prev = existing ? approvalOf(parse(existing.approval, {})) : approvalOf(null);
    const { add_to_stakeholders: addSh, ...a } = patch.approval;
    // 직접 입력 승인자 → 이해관계자에도 추가 (기본 체크, spec C6). Not an edit of the 이해관계자 activity, so its section stamp is left alone.
    if (!a.approver_id && a.approver_name && addSh) {
      const list = patch.stakeholders || (existing ? parse(existing.stakeholders, []) : []);
      const sh = approverStakeholder(project, a, '착수 결과 승인');
      patch.stakeholders = [...list, sh]; a.approver_id = sh.id;
    }
    if (a.approver_id) { a.approver_name = ''; a.approver_title = ''; }
    patch.approval = { ...a, baseline: prev.baseline };   // the baseline is written only by 완료 처리 / 다시 확인 완료
  }
  const su = { ...(existing ? parse(existing.section_updated, {}) : {}) }; for (const k of touched) su[k] = ts;
  const vals = (k) => (typeof patch[k] === 'string' ? patch[k] : JSON.stringify(patch[k]));
  if (!existing) {
    const base = { environments: '{}', goal: '', success_criteria: '[]', scope_in: '[]', scope_out: '[]', stakeholders: '[]', key_dates: '[]', operations: '{}', memo: '', kickoff: '{}', approval: '{}', ...Object.fromEntries(Object.keys(TEXT_FIELDS).map((k) => [k, ''])) };
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
  if (!sec.ready) throw new ValidationError({ section: sec.missing[0], missing: sec.missing.join('\n') });
  if (key === 'APPROVAL') {   // remember what was approved → later edits to 목표·범위·일정·승인자 flag 다시 확인 필요
    const d = model.definition;
    await db.run('UPDATE project_definitions SET approval = ? WHERE project_id = ?', [JSON.stringify({ ...d.approval, baseline: approvalFingerprint(d) }), project.id]);
  }
  await updateStep(db, project, sec.step_id, { status: 'COMPLETED' }, userId);   // confirm == complete again: completed_at moves past section_updated
  return { ok: true };
}

/* ---------- stakeholder Excel (template · preview) ---------- */
export const STAKEHOLDER_COLUMNS = [
  { key: 'org_type', label: '조직 구분 *', required: true, width: 12, options: ORG_TYPES.map((k) => ORG_TYPE_LABEL[k]) },
  { key: 'org', label: '조직(회사)', width: 20 }, { key: 'department', label: '부서', width: 18 }, { key: 'name', label: '이름 *', required: true, width: 14 },
  { key: 'role', label: '역할', width: 18 }, { key: 'area', label: '주요 책임', alias: ['담당 영역'], width: 24 }, { key: 'note', label: '비고', width: 24 },
];
/** Map raw workbook rows (header text → cell) to stakeholder rows with per-row validation. */
export function previewStakeholderRows({ headers, rows }) {
  const norm = (t) => String(t || '').replace(/\s+/g, '').replace(/\*+$/, '').toLowerCase();
  const colOf = {}; for (const c of STAKEHOLDER_COLUMNS) { const h = headers.find((x) => [c.label, ...(c.alias || [])].some((l) => norm(x.text) === norm(l))); if (h) colOf[c.key] = h.n; }
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
