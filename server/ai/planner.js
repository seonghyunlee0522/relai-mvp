/**
 * AI Project WBS Planner (Phase 15) — orchestration over the existing AI layer (runAiFeature / provider / credits /
 * structured output / commitWbs). Nothing here writes project data except commitPlan(), which goes through commitWbs().
 *
 *   createPlan        → plan row (DRAFT) → area assessment + questions (WBS_PLAN_QUESTIONS, 0 credits) → QUESTIONS_READY
 *   saveAnswers       → validated against the plan's own question schema
 *   generatePlanDraft → full project WBS draft (feature WBS_GENERATION = the one credit charge per plan) → REVIEW
 *   reviewCoverage    → deterministic requirement / delivery coverage from candidates + answers + existing WBS (no AI)
 *   fixPlan           → extra candidates for MISSING areas / uncovered requirements only (WBS_PLAN_FIX, 0 credits)
 *   commitPlan        → selected candidates → commitWbs() (real codes, links, history) → COMMITTED (idempotent)
 *
 * Grounding: the model only ever sees <project_data> blocks; user answers are data too. Every id it returns is checked
 * against the plan's requirement set / draft; unknown ids are stripped, unknown areas become OTHER, questions about
 * areas the project data already settles are dropped server-side.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { ValidationError } from '../validate.js';
import { buildProjectCharter } from '../charter.js';
import * as W from '../wbs.js';
import { runAiFeature, AiError } from './service.js';
import { SYSTEM, dataBlock, inputBlock, neutralize, AREA_LABEL } from './prompts.js';
import { PLANNER_SCHEMAS, PLAN_AREAS, AREA_STATUS, AREA_SOURCE, QUESTION_TYPES } from './schemas.js';
import { projectBlock, requirementRows, wbsRows } from './context.js';
import { commitWbs, titleSimilarity, DUPLICATE_THRESHOLD } from './features.js';

export const PLAN_STATUSES = ['DRAFT', 'QUESTIONS_READY', 'GENERATING', 'REVIEW', 'COMMITTED', 'CANCELLED'];
export const MAX_QUESTIONS = 8; export const MAX_OPTIONS = 8; export const MAX_FOLLOWUPS = 10; export const MAX_ITEMS = 80; export const MAX_FIX_ITEMS = 20;
export const MAX_PLAN_DEPTH = W.MAX_DEPTH;   // the real Tree WBS rule (5); the prompt asks for 2–3
const str = (v, n = 2000) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const uniq = (a) => [...new Set(a)];
const clip = (s, n) => { const t = neutralize(String(s ?? '').replace(/\s+/g, ' ').trim()); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export class PlanError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

/* ---------- deterministic pre-assessment: what the project data already settles (never asked again) ---------- */
const AREA_HINTS = {
  DATA_MIGRATION: /이관|마이그레이션|migration|데이터 전환|기존 (시스템|데이터|db)/i,
  INTERFACE: /연계|인터페이스|interface|api 연동|외부 시스템|sso 연동/i,
  INFRASTRUCTURE: /azure|aws|gcp|클라우드|cloud|온프레미스|on-?prem|서버 구성|인프라/i,
  SECURITY: /sso|권한 관리|인증|보안|security/i,
  TRAINING: /교육|training/i,
  CUTOVER: /전환|cutover|컷오버/i,
  OPERATION_HANDOVER: /운영 이관|운영 인수|handover|운영팀/i,
  UAT: /uat|인수 테스트|사용자 테스트/i,
  DOCUMENTATION: /매뉴얼|산출물|manual/i,
};
export function knownAreasFrom({ definitionText = '', requirementText = '' }) {
  const out = [];
  for (const [area, re] of Object.entries(AREA_HINTS)) {
    if (re.test(requirementText)) out.push({ area, status: 'REQUIRED', source: 'REQUIREMENT', reason: `요구사항에 ${AREA_LABEL[area]} 관련 내용이 명시되어 있습니다.` });
    else if (re.test(definitionText)) out.push({ area, status: 'REQUIRED', source: 'PROJECT_DEFINITION', reason: `프로젝트 정의에 ${AREA_LABEL[area]} 관련 내용이 명시되어 있습니다.` });
  }
  return out;
}

/* ---------- context ---------- */
async function plannerContext(db, project, requirementIds) {
  const reqs = await requirementRows(db, project.id, { ids: requirementIds, limit: 80 });
  const crit = reqs.length ? await db.all('SELECT requirement_id, content FROM requirement_criteria WHERE requirement_id = ANY(?::text[]) ORDER BY sequence', [reqs.map((r) => r.id)]) : [];
  const critBy = new Map(); for (const c of crit) critBy.set(c.requirement_id, [...(critBy.get(c.requirement_id) || []), c.content]);
  const wbs = await wbsRows(db, project.id, { limit: 200 });
  const links = wbs.length ? await db.all(`SELECT l.wbs_item_id, r.display_id FROM requirement_wbs_links l JOIN requirements r ON r.id = l.requirement_id WHERE l.project_id = ? AND r.archived_at IS NULL`, [project.id]) : [];
  const linkBy = new Map(); for (const l of links) linkBy.set(l.wbs_item_id, [...(linkBy.get(l.wbs_item_id) || []), l.display_id]);
  // 프로젝트 정의 is sent once, as the [PROJECT CHATER] block inside projectBlock(); the same text drives "이미 확인된 정보".
  const head = await projectBlock(db, project);
  // "이미 확인된 정보" is matched against what the user actually wrote, never the block's own labels.
  const flat = (o) => (o === null || o === undefined ? '' : typeof o === 'object' ? Object.values(o).map(flat).join('\n') : String(o));
  const ch = await buildProjectCharter(db, project);
  // 프로젝트 기본 특성 (profile.traits) are not used by AI yet — keep them out of "이미 확인된 정보" (their labels, e.g. "외부 시스템 연계", would match area hints)
  const defText = flat({ ...ch, profile: { ...ch.profile, traits: undefined, project_type: ch.profile.project_type_text } });
  const reqText = `## 선택 요구사항 (${reqs.length}건)\n${reqs.length ? reqs.map((r) => `- ${r.display_id} [${r.type}/${r.priority}/${r.scope}/${r.status}] ${clip(r.title, 150)}\n  설명: ${clip(r.description, 400) || '(없음)'}${critBy.get(r.id) ? `\n  완료 조건: ${critBy.get(r.id).map((c) => clip(c, 120)).join(' / ')}` : ''}`).join('\n') : '(선택된 요구사항 없음 — 프로젝트 수행 WBS만 제안)'}`;
  const wbsText = `## 기존 WBS (${wbs.length}건, 중복 방지용)\n${wbs.length ? wbs.map((w) => `- ${w.wbs_code} [${w.item_type}/${w.status}] ${clip(w.title, 100)}${linkBy.get(w.id) ? ` ← ${linkBy.get(w.id).join(', ')}` : ''}`).join('\n') : '(없음)'}`;
  const known = knownAreasFrom({ definitionText: defText, requirementText: reqs.map((r) => `${r.title} ${r.description || ''}`).join('\n') });
  const knownText = `## 이미 확인된 정보 (다시 묻지 말 것)\n${known.length ? known.map((k) => `- ${k.area} (${AREA_LABEL[k.area]}): ${k.reason}`).join('\n') : '(없음)'}`;
  const base = `${head}\n\n${reqText}\n\n${wbsText}`;
  return { reqs, wbs, linkBy, known, base, knownText };
}

/* ---------- plan rows ---------- */
const parse = (v, def) => (v === null || v === undefined ? def : typeof v === 'string' ? JSON.parse(v) : v);
export function shapePlan(r) {
  if (!r) return null;
  return { id: r.id, project_id: r.project_id, status: r.status, requirement_ids: parse(r.requirement_ids, []), areas: parse(r.areas, []), questions: parse(r.questions, []), answers: parse(r.answers, {}),
    draft: parse(r.draft, null), coverage: parse(r.coverage, null), ai_run_id: r.ai_run_id, question_run_id: r.question_run_id, commit_result: parse(r.commit_result, null), created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, committed_at: r.committed_at };
}
export async function getPlan(db, project, planId) { return shapePlan(await db.get('SELECT * FROM ai_wbs_plans WHERE id = ? AND project_id = ? AND workspace_id = ?', [planId, project.id, project.workspace_id])); }
export async function listPlans(db, project, { limit = 5 } = {}) {
  const rows = await db.all('SELECT * FROM ai_wbs_plans WHERE project_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?', [project.id, project.workspace_id, limit]);
  const plans = rows.map(shapePlan);
  return { active: plans.find((p) => !['COMMITTED', 'CANCELLED'].includes(p.status)) || null, plans: plans.map(({ draft, coverage, questions, ...p }) => ({ ...p, item_count: draft?.items?.length || 0, question_count: questions.length })) };
}
const save = (db, id, patch) => {
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(['requirement_ids', 'areas', 'questions', 'answers', 'draft', 'coverage', 'commit_result'].includes(k) ? `${k} = ?::jsonb` : `${k} = ?`); vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v); }
  return db.run(`UPDATE ai_wbs_plans SET ${sets.join(', ')}, updated_at = now() WHERE id = ?`, [...vals, id]);
};

/* ---------- 1. create plan + questions ---------- */
export async function createPlan(db, { project, wid, userId, requirementIds = null, all = false }) {
  const live = await requirementRows(db, project.id, { limit: 300 });
  let ids;
  if (all || requirementIds === null) ids = live.map((r) => r.id);
  else {
    const want = uniq((Array.isArray(requirementIds) ? requirementIds : []).map((x) => String(x || '')).filter(Boolean));
    const liveIds = new Set(live.map((r) => r.id));
    ids = want.filter((x) => liveIds.has(x));   // archived / foreign requirements are silently excluded
  }
  if (ids.length > 80) throw new ValidationError({ requirement_ids: '한 번에 최대 80건의 요구사항을 대상으로 할 수 있습니다.' });
  const id = randomUUID();
  await db.run('INSERT INTO ai_wbs_plans (id, workspace_id, project_id, created_by, status, requirement_ids) VALUES (?,?,?,?,?,?::jsonb)', [id, wid, project.id, userId, 'DRAFT', JSON.stringify(ids)]);
  let ctx;
  let out;
  try {
    out = await runAiFeature(db, {
      wid, projectId: project.id, userId, feature: 'WBS_PLAN_QUESTIONS',
      build: async () => {
        ctx = await plannerContext(db, project, ids);
        return { system: SYSTEM.WBS_PLAN_QUESTIONS, schemaName: 'wbs_planning_questions', schemaDescription: '수행 영역 판단과 사용자 질문',
          user: `${dataBlock(`${ctx.base}\n\n${ctx.knownText}`)}\n\n위 프로젝트에 필요한 수행 영역을 판단하고, 정보가 부족한 영역에 대한 질문을 JSON으로 반환하세요.`,
          inputSummary: `plan ${id}: requirements ${ctx.reqs.length}, existing wbs ${ctx.wbs.length}, known areas ${ctx.known.length}`, inputChars: ctx.base.length };
      },
      postValidate: async (data) => ({ data: normalizeQuestions(data, ctx.known), warnings: [] }),
    });
  } catch (e) { await db.run('DELETE FROM ai_wbs_plans WHERE id = ?', [id]); throw e; }
  await save(db, id, { status: 'QUESTIONS_READY', areas: out.areas, questions: out.questions, question_run_id: out.run.id });
  return { plan: await getPlan(db, project, id), run: out.run, warnings: out.warnings };
}

/** Server post-validation of the question set: allowed areas, known areas dropped, dedupe, caps, option/followup limits. */
export function normalizeQuestions(data, known = []) {
  const knownBy = new Map(known.map((k) => [k.area, k]));
  const areas = [];
  const seenA = new Set();
  for (const a of Array.isArray(data.areas) ? data.areas : []) {
    const area = PLAN_AREAS.includes(a.area) ? a.area : null; if (!area || seenA.has(area)) continue; seenA.add(area);
    const k = knownBy.get(area);
    areas.push(k ? { ...k } : { area, status: AREA_STATUS.includes(a.status) ? a.status : 'UNKNOWN', source: AREA_SOURCE.includes(a.source) ? a.source : 'INFERRED', reason: str(a.reason, 300) });
  }
  for (const k of known) if (!seenA.has(k.area)) areas.push({ ...k });
  const questions = []; const seenQ = new Set(); const slug = (s) => str(s, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  for (const q of Array.isArray(data.questions) ? data.questions : []) {
    if (questions.length >= MAX_QUESTIONS) break;
    const area = PLAN_AREAS.includes(q.area) ? q.area : null; if (!area) continue;                       // invalid area → removed
    if (knownBy.has(area)) continue;                                                                      // already settled by project data → never asked
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'SINGLE';
    const key = `${area}:${type}`; if (seenQ.has(key)) continue; seenQ.add(key);                        // one question per area/type
    const text = str(q.question, 200); if (!text) continue;
    const optSeen = new Set();
    let options = (Array.isArray(q.options) ? q.options : []).map((o, i) => ({ id: slug(o.id) || `opt_${i + 1}`, label: str(o.label, 80), followups: (Array.isArray(o.followups) ? o.followups : []).slice(0, MAX_FOLLOWUPS).map((f, j) => ({ id: slug(f.id) || `f_${j + 1}`, label: str(f.label, 80) })).filter((f) => f.label) }))
      .filter((o) => o.label && !optSeen.has(o.id) && optSeen.add(o.id)).slice(0, MAX_OPTIONS);
    if ((type === 'SINGLE' || type === 'MULTI') && options.length < 2) continue;                          // unusable choice question
    if (type === 'BOOLEAN' || type === 'TEXT') options = [];
    questions.push({ id: slug(q.id) || `q_${area.toLowerCase()}`, area, question: text, help_text: str(q.help_text, 300) || null, type, required: Boolean(q.required), options, allow_other: Boolean(q.allow_other), reason: str(q.reason, 300) });
  }
  const qid = new Set(); for (const q of questions) { let base = q.id; let n = 1; while (qid.has(q.id)) q.id = `${base}_${++n}`; qid.add(q.id); }
  return { areas, questions };
}

/* ---------- 2. answers ---------- */
export async function saveAnswers(db, plan, answers) {
  if (!['QUESTIONS_READY', 'REVIEW', 'DRAFT'].includes(plan.status)) throw new PlanError(409, 'plan_state', '현재 상태에서는 답변을 수정할 수 없습니다.');
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ValidationError({ answers: '답변 형식이 올바르지 않습니다.' });
  const byId = new Map(plan.questions.map((q) => [q.id, q])); const out = {}; const fields = {};
  for (const [qid, a] of Object.entries(answers)) {
    const q = byId.get(qid); if (!q) continue;
    const v = a && typeof a === 'object' && !Array.isArray(a) ? a : { value: a };
    const ids = new Set(q.options.map((o) => o.id));
    let value;
    if (q.type === 'BOOLEAN') value = v.value === true || v.value === 'true' ? true : v.value === false || v.value === 'false' ? false : null;
    else if (q.type === 'TEXT') value = str(v.value, 500) || null;
    else if (q.type === 'SINGLE') { value = ids.has(v.value) ? v.value : null; if (v.value && !value) fields[qid] = '선택지가 올바르지 않습니다.'; }
    else { value = uniq((Array.isArray(v.value) ? v.value : v.value ? [v.value] : []).filter((x) => ids.has(x))); }
    const fu = new Set(q.options.flatMap((o) => o.followups.map((f) => f.id)));
    out[qid] = { value, followups: uniq((Array.isArray(v.followups) ? v.followups : []).filter((x) => fu.has(x))), other: q.allow_other ? str(v.other, 300) || null : null };
  }
  for (const q of plan.questions) if (q.required && (out[q.id] === undefined || out[q.id].value === null || (Array.isArray(out[q.id]?.value) && !out[q.id].value.length))) fields[q.id] = '필수 질문입니다.';
  if (Object.keys(fields).length) throw new ValidationError(fields);
  await save(db, plan.id, { answers: out });
  return out;
}
const NEG = /^(none|no|not_needed|not_required|n_a|na|without|skip)$|없음|불필요/i; const UND = /undecided|unknown|later|tbd|미정|모름/i;
/** Area status after answers: USER_ANSWER beats the model's assessment. */
export function assessWithAnswers(plan) {
  const by = new Map(plan.areas.map((a) => [a.area, { ...a }]));
  for (const q of plan.questions) {
    const a = plan.answers[q.id]; if (!a || a.value === null || a.value === undefined) continue;
    let status = null; const labelOf = (id) => q.options.find((o) => o.id === id)?.label || id;
    if (q.type === 'BOOLEAN') status = a.value ? 'REQUIRED' : 'NOT_NEEDED';
    else if (q.type === 'SINGLE') status = UND.test(a.value) || UND.test(labelOf(a.value)) ? 'UNKNOWN' : NEG.test(a.value) || NEG.test(labelOf(a.value)) ? 'NOT_NEEDED' : 'REQUIRED';
    else if (q.type === 'MULTI') { const vs = a.value; status = !vs.length ? null : vs.every((v) => NEG.test(v) || NEG.test(labelOf(v))) ? 'NOT_NEEDED' : vs.every((v) => UND.test(v) || UND.test(labelOf(v))) ? 'UNKNOWN' : 'REQUIRED'; }
    else if (q.type === 'TEXT') status = NEG.test(a.value) ? 'NOT_NEEDED' : 'REQUIRED';
    if (status) by.set(q.area, { area: q.area, status, source: 'USER_ANSWER', reason: `사용자 답변: ${q.type === 'MULTI' ? a.value.map(labelOf).join(', ') : q.type === 'SINGLE' ? labelOf(a.value) : String(a.value)}` });
  }
  return [...by.values()];
}
const answersText = (plan) => `## 사용자 답변\n${plan.questions.length ? plan.questions.map((q) => { const a = plan.answers[q.id]; const lab = (id) => q.options.find((o) => o.id === id)?.label || id; const fu = (a?.followups || []).map((f) => q.options.flatMap((o) => o.followups).find((x) => x.id === f)?.label || f);
  const v = !a || a.value === null || a.value === undefined ? '(미응답)' : q.type === 'MULTI' ? a.value.map(lab).join(', ') || '(없음)' : q.type === 'SINGLE' ? lab(a.value) : String(a.value);
  return `- [${q.area}] ${clip(q.question, 150)} → ${clip(v, 200)}${fu.length ? ` (세부: ${fu.map((x) => clip(x, 60)).join(', ')})` : ''}${a?.other ? ` (기타: ${clip(a.other, 200)})` : ''}`; }).join('\n') : '(질문 없음)'}`;
const areasText = (areas) => `## 수행 영역 판단\n${areas.map((a) => `- ${a.area} (${AREA_LABEL[a.area]}): ${a.status} [${a.source}] ${clip(a.reason, 160)}`).join('\n')}`;

/* ---------- 3. draft generation ---------- */
export async function generatePlanDraft(db, { plan, project, wid, userId }) {
  if (!['QUESTIONS_READY', 'REVIEW'].includes(plan.status)) throw new PlanError(409, 'plan_state', '현재 상태에서는 초안을 생성할 수 없습니다.');
  const areas = assessWithAnswers(plan);
  await save(db, plan.id, { status: 'GENERATING', areas });
  let ctx;
  let out;
  try {
    out = await runAiFeature(db, {
      wid, projectId: project.id, userId, feature: 'WBS_GENERATION', schema: PLANNER_SCHEMAS.project_wbs_draft,
      build: async () => {
        ctx = await plannerContext(db, project, plan.requirement_ids);
        return { system: SYSTEM.PROJECT_WBS_DRAFT, schemaName: 'project_wbs_draft', schemaDescription: '전체 프로젝트 WBS 초안',
          user: `${dataBlock(`${ctx.base}\n\n${areasText(areas)}`)}\n\n${inputBlock(answersText(plan))}\n\n기능 요구사항만 구현하지 말고 실제 프로젝트 완료에 필요한 전체 수행 WBS 초안을 JSON으로 반환하세요.`,
          inputSummary: `plan ${plan.id}: requirements ${ctx.reqs.length}, existing wbs ${ctx.wbs.length}, answers ${Object.keys(plan.answers).length}`, inputChars: ctx.base.length };
      },
      postValidate: async (data) => { const r = normalizeCandidates(data.items, { reqs: ctx.reqs, existing: ctx.wbs, max: MAX_ITEMS }); return { data: { items: r.items, notes: (data.notes || []).map((n) => str(n, 300)).filter(Boolean) }, warnings: r.warnings }; },
    });
  } catch (e) { await save(db, plan.id, { status: 'QUESTIONS_READY' }); throw e; }
  const draft = { items: out.items, notes: out.notes, warnings: out.warnings, requirements: ctx.reqs.map((r) => ({ id: r.id, display_id: r.display_id, title: r.title })) };
  const coverage = computeCoverage({ areas, items: draft.items, reqs: ctx.reqs, existing: ctx.wbs, linkBy: ctx.linkBy });
  await save(db, plan.id, { status: 'REVIEW', draft, coverage, areas, ai_run_id: out.run.id });
  return { plan: await getPlan(db, project, plan.id), run: out.run };
}

/** Hierarchy / id / depth / similarity normalization shared by draft and fix. Returns { items, warnings }. */
export function normalizeCandidates(raw, { reqs, existing, max = MAX_ITEMS, prefix = 'AI-WBS', reserved = [] }) {
  const warnings = []; const selected = new Map(reqs.map((r) => [r.display_id, r]));
  const seen = new Set(reserved.map((i) => i.temp_id)); const items = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (items.length >= max) { warnings.push(`후보가 ${max}개를 넘어 나머지는 제외했습니다. 범위가 크면 상위 수준 초안으로 검토하세요.`); break; }
    let temp = str(it.temp_id, 20) || `${prefix}-${items.length + 1}`;
    if (seen.has(temp)) { const t2 = `${prefix}-${items.length + 1}-${Math.random().toString(36).slice(2, 5)}`; warnings.push(`중복 임시 ID ${temp} → ${t2}`); temp = t2; }
    seen.add(temp);
    const area = PLAN_AREAS.includes(it.project_area) ? it.project_area : 'OTHER';
    if (it.project_area && area === 'OTHER' && it.project_area !== 'OTHER') warnings.push(`${temp}: 알 수 없는 영역(${str(it.project_area, 40)})을 OTHER로 바꿨습니다.`);
    items.push({ temp_id: temp, parent_temp_id: it.parent_temp_id ? str(it.parent_temp_id, 20) : null, item_type: it.item_type === 'MILESTONE' ? 'MILESTONE' : 'TASK', title: str(it.title, 200) || '(제목 없음)', description: str(it.description, 2000),
      project_area: area, planned_duration_days: Number.isInteger(it.planned_duration_days) && it.planned_duration_days >= 0 ? Math.min(365, it.planned_duration_days) : null,
      related_requirement_ids: uniq((Array.isArray(it.related_requirement_ids) ? it.related_requirement_ids : []).map((x) => str(x, 20)).filter(Boolean)) });
  }
  const all = [...reserved, ...items]; const byTemp = new Map(all.map((i) => [i.temp_id, i]));
  for (const it of items) {
    if (it.parent_temp_id && !byTemp.has(it.parent_temp_id)) { warnings.push(`${it.temp_id}: 존재하지 않는 상위 항목(${it.parent_temp_id})을 참조해 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
    if (it.parent_temp_id === it.temp_id) { warnings.push(`${it.temp_id}: 자기 자신을 상위로 지정해 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
    if (it.parent_temp_id && byTemp.get(it.parent_temp_id).item_type === 'MILESTONE') { warnings.push(`${it.temp_id}: 마일스톤 아래에는 항목을 둘 수 없어 최상위로 옮겼습니다.`); it.parent_temp_id = null; }
    const unknown = it.related_requirement_ids.filter((d) => !selected.has(d));
    if (unknown.length) warnings.push(`${it.temp_id}: 대상 범위 밖의 요구사항 ${unknown.join(', ')} 참조를 제거했습니다.`);
    it.related_requirement_ids = it.related_requirement_ids.filter((d) => selected.has(d));
    it.requirement_ids = it.related_requirement_ids.map((d) => selected.get(d).id);
  }
  for (const it of items) {   // cycles
    const trail = new Set([it.temp_id]); let p = it.parent_temp_id;
    while (p) { if (trail.has(p)) { warnings.push(`${it.temp_id}: 순환 참조를 끊고 최상위로 옮겼습니다.`); it.parent_temp_id = null; break; } trail.add(p); p = byTemp.get(p)?.parent_temp_id || null; }
  }
  const depthOf = (it, guard = 0) => (!it || !it.parent_temp_id || guard > 60 ? 1 : 1 + depthOf(byTemp.get(it.parent_temp_id), guard + 1));
  for (const it of items) {
    if (depthOf(it) > MAX_PLAN_DEPTH) {
      let anc = byTemp.get(it.parent_temp_id); while (anc && depthOf(anc) > MAX_PLAN_DEPTH - 1) anc = byTemp.get(anc.parent_temp_id);
      warnings.push(`${it.temp_id}: 깊이 ${MAX_PLAN_DEPTH}단계를 넘어 ${anc ? anc.temp_id : '최상위'} 아래로 옮겼습니다.`); it.parent_temp_id = anc ? anc.temp_id : null;
    }
  }
  for (const it of items) if (it.item_type === 'MILESTONE' && items.some((c) => c.parent_temp_id === it.temp_id)) { warnings.push(`${it.temp_id}: 하위 항목이 있는 마일스톤을 작업(TASK)으로 바꿨습니다.`); it.item_type = 'TASK'; }
  // similarity with existing WBS → flagged and deselected by default
  for (const it of items) {
    const best = existing.map((w) => ({ wbs_code: w.wbs_code, title: w.title, score: titleSimilarity(it.title, w.title) })).filter((x) => x.score >= DUPLICATE_THRESHOLD).sort((a, b) => b.score - a.score)[0];
    it.similar_to = best ? { wbs_code: best.wbs_code, title: best.title, score: Number(best.score.toFixed(2)) } : null;
    it.selected = !best;
  }
  const ordered = []; const placed = new Set(reserved.map((i) => i.temp_id));
  const place = (it) => { if (!it || placed.has(it.temp_id)) return; if (it.parent_temp_id) place(byTemp.get(it.parent_temp_id)); placed.add(it.temp_id); ordered.push(it); };
  items.forEach(place);
  if (!ordered.length && !reserved.length) throw new AiError('AI_INVALID_OUTPUT', 'AI가 WBS 항목을 제안하지 않았습니다.');
  return { items: ordered.map((it) => ({ ...it, depth: depthOf(it) })), warnings };
}

/* ---------- 4. coverage (deterministic) ---------- */
export const COVERAGE_STATUS = ['COVERED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'UNKNOWN'];
const MISSING_MSG = {
  DATA_MIGRATION: '데이터 이관이 필요하다고 확인됐지만 이관 작업(대상 분석·매핑·Trial/Final Migration)이 없습니다.', INTERFACE: '외부 연계가 필요하다고 확인됐지만 연계(인터페이스) 작업이 없습니다.',
  INFRASTRUCTURE: '운영 환경(인프라)이 확인됐지만 환경 구성 작업이 없습니다.', ENVIRONMENT: '개발·검증·운영 환경 구성 작업이 없습니다.', TRAINING: '교육이 필요하다고 답했지만 교육 작업이 없습니다.',
  CUTOVER: '전환(Cutover) 작업이 필요하다고 확인됐지만 전환 작업이 없습니다.', OPERATION_HANDOVER: '운영 이관이 필요하다고 확인됐지만 운영 이관 작업이 없습니다.', TESTING: '테스트 작업이 없습니다.', UAT: 'UAT 지원 작업이 없습니다.',
  DEPLOYMENT: '배포 작업이 없습니다.', SECURITY: '보안/인증/권한 작업이 필요하다고 확인됐지만 관련 작업이 없습니다.', PROJECT_MANAGEMENT: '프로젝트 관리(착수/보고/이슈 관리) 작업이 없습니다.', DOCUMENTATION: '산출물/매뉴얼 작업이 없습니다.', STABILIZATION: '오픈/안정화 작업이 없습니다.',
};
export function computeCoverage({ areas, items, reqs, existing = [], linkBy = new Map() }) {
  const sel = items.filter((i) => i.selected !== false);
  const requirement_coverage = reqs.map((r) => {
    const cands = sel.filter((i) => (i.related_requirement_ids || []).includes(r.display_id)).map((i) => i.temp_id);
    const ex = existing.filter((w) => (linkBy.get(w.id) || []).includes(r.display_id)).map((w) => w.wbs_code);
    return { display_id: r.display_id, title: r.title, status: cands.length || ex.length ? 'COVERED' : 'MISSING', candidates: cands, existing: ex };
  });
  const covered = requirement_coverage.filter((x) => x.status === 'COVERED').length;
  const byArea = new Map(areas.map((a) => [a.area, a]));
  const delivery_coverage = PLAN_AREAS.filter((a) => a !== 'OTHER').map((area) => {
    const a = byArea.get(area) || { area, status: 'UNKNOWN', source: 'INFERRED', reason: '' };
    const cand = sel.filter((i) => i.project_area === area).length;
    const ex = existing.filter((w) => AREA_HINTS[area] && AREA_HINTS[area].test(w.title)).length;
    const n = cand + ex;
    let status;
    if (a.status === 'NOT_NEEDED') status = 'NOT_APPLICABLE';
    else if (a.status === 'REQUIRED') status = n >= 2 ? 'COVERED' : n === 1 ? 'PARTIAL' : 'MISSING';
    else if (a.status === 'POSSIBLE') status = n ? 'COVERED' : 'PARTIAL';
    else status = n ? 'COVERED' : 'UNKNOWN';
    return { area, label: AREA_LABEL[area], assessment: a.status, source: a.source, reason: a.reason, status, candidates: cand, existing: ex };
  });
  const warnings = [];
  for (const d of delivery_coverage) if (d.status === 'MISSING') warnings.push(MISSING_MSG[d.area] || `${d.label} 영역이 필요하다고 확인됐지만 관련 작업이 없습니다.`);
  for (const d of delivery_coverage) if (d.status === 'PARTIAL' && d.assessment === 'REQUIRED') warnings.push(`${d.label} 영역에 작업이 1건뿐입니다. 충분한지 확인하세요.`);
  for (const r of requirement_coverage) if (r.status === 'MISSING') warnings.push(`${r.display_id}에 연결된 실행 WBS가 없습니다.`);
  const counts = { selected: sel.length, linked: sel.filter((i) => (i.related_requirement_ids || []).length).length, delivery: sel.filter((i) => !(i.related_requirement_ids || []).length && i.item_type !== 'MILESTONE').length, milestones: sel.filter((i) => i.item_type === 'MILESTONE').length };
  return { requirement_coverage, requirement_summary: { total: reqs.length, covered, missing: reqs.length - covered, percent: reqs.length ? Math.round((covered / reqs.length) * 100) : null }, delivery_coverage, warnings, counts };
}

/** Review step: accept the user's edited candidate list (title/description/parent/type/duration/links/selection), store it, recompute coverage. */
export async function reviewCoverage(db, { plan, project, items = null }) {
  if (plan.status !== 'REVIEW') throw new PlanError(409, 'plan_state', '검토 단계가 아닙니다.');
  if (!plan.draft) throw new PlanError(409, 'plan_state', '초안이 없습니다.');
  let draftItems = plan.draft.items;
  if (Array.isArray(items)) draftItems = mergeEdits(plan.draft.items, items, plan.draft.requirements);
  const ctx = await plannerContext(db, project, plan.requirement_ids);
  const coverage = computeCoverage({ areas: assessWithAnswers(plan), items: draftItems, reqs: ctx.reqs, existing: ctx.wbs, linkBy: ctx.linkBy });
  await save(db, plan.id, { draft: { ...plan.draft, items: draftItems }, coverage });
  return { plan: await getPlan(db, project, plan.id) };
}
/** User edits are applied field by field on the server-owned candidates: unknown temp_ids are ignored, requirement ids are re-validated, hierarchy re-checked. */
export function mergeEdits(base, edits, requirements) {
  const byTemp = new Map(base.map((i) => [i.temp_id, { ...i }])); const reqBy = new Map((requirements || []).map((r) => [r.display_id, r]));
  const fields = {};
  for (const e of edits) {
    const it = byTemp.get(str(e?.temp_id, 20)); if (!it) continue;
    if (e.title !== undefined) { const t = str(e.title, 200); if (!t) fields[`items.${it.temp_id}.title`] = '업무명을 입력해 주세요.'; else it.title = t; }
    if (e.description !== undefined) it.description = str(e.description, 2000);
    if (e.item_type !== undefined) it.item_type = e.item_type === 'MILESTONE' ? 'MILESTONE' : 'TASK';
    if (e.planned_duration_days !== undefined) it.planned_duration_days = Number.isInteger(e.planned_duration_days) && e.planned_duration_days >= 0 ? Math.min(365, e.planned_duration_days) : null;
    if (e.parent_temp_id !== undefined) it.parent_temp_id = e.parent_temp_id ? str(e.parent_temp_id, 20) : null;
    if (e.related_requirement_ids !== undefined) { it.related_requirement_ids = uniq((Array.isArray(e.related_requirement_ids) ? e.related_requirement_ids : []).map((x) => str(x, 20)).filter((d) => reqBy.has(d))); it.requirement_ids = it.related_requirement_ids.map((d) => reqBy.get(d).id); }
    if (e.selected !== undefined) it.selected = Boolean(e.selected);
  }
  if (Object.keys(fields).length) throw new ValidationError(fields);
  const items = [...byTemp.values()];
  for (const it of items) {
    if (it.parent_temp_id && (!byTemp.has(it.parent_temp_id) || it.parent_temp_id === it.temp_id)) it.parent_temp_id = null;
    if (it.parent_temp_id && byTemp.get(it.parent_temp_id).item_type === 'MILESTONE') it.parent_temp_id = null;
    const trail = new Set([it.temp_id]); let p = it.parent_temp_id; while (p) { if (trail.has(p)) { it.parent_temp_id = null; break; } trail.add(p); p = byTemp.get(p)?.parent_temp_id || null; }
  }
  // parent/child rule: a selected child always selects its parent chain
  for (const it of items) if (it.selected !== false) { let p = it.parent_temp_id; let g = 0; while (p && g++ < 60) { const x = byTemp.get(p); if (!x) break; x.selected = true; p = x.parent_temp_id; } }
  const depthOf = (it, g = 0) => (!it || !it.parent_temp_id || g > 60 ? 1 : 1 + depthOf(byTemp.get(it.parent_temp_id), g + 1));
  const ordered = []; const placed = new Set(); const place = (it) => { if (!it || placed.has(it.temp_id)) return; if (it.parent_temp_id) place(byTemp.get(it.parent_temp_id)); placed.add(it.temp_id); ordered.push(it); };
  base.forEach((b) => place(byTemp.get(b.temp_id)));
  return ordered.map((it) => ({ ...it, depth: depthOf(it) }));
}

/* ---------- 5. coverage fix ---------- */
export async function fixPlan(db, { plan, project, wid, userId, areas: wanted = null }) {
  if (plan.status !== 'REVIEW' || !plan.draft || !plan.coverage) throw new PlanError(409, 'plan_state', '검토 단계에서만 보완할 수 있습니다.');
  const missingAreas = plan.coverage.delivery_coverage.filter((d) => d.status === 'MISSING' || (d.status === 'PARTIAL' && d.assessment === 'REQUIRED')).map((d) => d.area).filter((a) => !wanted || wanted.includes(a));
  const missingReqs = plan.coverage.requirement_coverage.filter((r) => r.status === 'MISSING').map((r) => r.display_id);
  if (!missingAreas.length && !missingReqs.length) throw new PlanError(409, 'nothing_to_fix', '보완할 누락 영역이나 요구사항이 없습니다.');
  const areas = assessWithAnswers(plan);
  let ctx;
  const out = await runAiFeature(db, {
    wid, projectId: project.id, userId, feature: 'WBS_PLAN_FIX',
    build: async () => {
      ctx = await plannerContext(db, project, plan.requirement_ids);
      const draftText = `## 현재 초안 (temp_id · 영역 · 제목)\n${plan.draft.items.map((i) => `- ${i.temp_id}${i.parent_temp_id ? ` (상위 ${i.parent_temp_id})` : ''} [${i.project_area}] ${clip(i.title, 100)}`).join('\n')}`;
      const target = `## 보완 대상\nmissing_areas: ${missingAreas.map((a) => `${a} (${AREA_LABEL[a]})`).join(', ') || '(없음)'}\nuncovered_requirements: ${missingReqs.join(', ') || '(없음)'}`;
      return { system: SYSTEM.WBS_PLAN_FIX, schemaName: 'wbs_plan_fix', schemaDescription: '누락 영역 보완 후보',
        user: `${dataBlock(`${ctx.base}\n\n${areasText(areas)}\n\n${draftText}\n\n${target}`)}\n\n${inputBlock(answersText(plan))}\n\n보완 대상에 해당하는 추가 WBS 후보만 JSON으로 반환하세요.`,
        inputSummary: `plan ${plan.id} fix: areas ${missingAreas.length}, requirements ${missingReqs.length}`, inputChars: ctx.base.length };
    },
    postValidate: async (data) => { const r = normalizeCandidates(data.items, { reqs: ctx.reqs, existing: ctx.wbs, max: MAX_FIX_ITEMS, prefix: 'AI-FIX', reserved: plan.draft.items }); return { data: { items: r.items, notes: (data.notes || []).map((n) => str(n, 300)).filter(Boolean) }, warnings: r.warnings }; },
  });
  const added = out.items.map((i) => ({ ...i, fix: true }));
  const items = [...plan.draft.items, ...added].slice(0, MAX_ITEMS);
  const warnings = [...(plan.draft.warnings || []), ...out.warnings, ...(plan.draft.items.length + added.length > MAX_ITEMS ? [`전체 후보가 ${MAX_ITEMS}개를 넘어 일부 보완 후보를 제외했습니다.`] : [])];
  const draft = { ...plan.draft, items, notes: [...(plan.draft.notes || []), ...out.notes], warnings };
  const coverage = computeCoverage({ areas, items, reqs: ctx.reqs, existing: ctx.wbs, linkBy: ctx.linkBy });
  await save(db, plan.id, { draft, coverage, areas });
  return { plan: await getPlan(db, project, plan.id), added: added.map((i) => i.temp_id), run: out.run };
}

/* ---------- 6. commit (idempotent, same transaction as the WBS writes) ---------- */
export async function commitPlan(db, { plan, project, userId, items = null }) {
  if (plan.status === 'COMMITTED') throw new PlanError(409, 'plan_committed', '이미 WBS에 반영된 초안입니다.');
  if (plan.status !== 'REVIEW' || !plan.draft) throw new PlanError(409, 'plan_state', '검토 단계에서만 반영할 수 있습니다.');
  const draftItems = Array.isArray(items) ? mergeEdits(plan.draft.items, items, plan.draft.requirements) : plan.draft.items;
  const chosen = draftItems.filter((i) => i.selected !== false);
  if (!chosen.length) throw new ValidationError({ items: '반영할 항목을 선택해 주세요.' });
  const chosenIds = new Set(chosen.map((i) => i.temp_id));
  const payload = chosen.map((i) => ({ temp_id: i.temp_id, parent_temp_id: i.parent_temp_id && chosenIds.has(i.parent_temp_id) ? i.parent_temp_id : null, item_type: i.item_type, title: i.title, description: i.description || '', requirement_ids: i.requirement_ids || [] }));
  return tx(db, async (t) => {
    const claimed = await t.run(`UPDATE ai_wbs_plans SET status = 'COMMITTED', committed_at = now(), updated_at = now() WHERE id = ? AND status = 'REVIEW'`, [plan.id]);
    if (!claimed || claimed.changes === 0) throw new PlanError(409, 'plan_committed', '이미 WBS에 반영된 초안입니다.');
    const r = await commitWbs(t, { project, userId, items: payload, source: { kind: 'AI_PROJECT_WBS_PLANNER', plan_id: plan.id } });
    const result = { created: r.created.length, links: r.links, milestones: chosen.filter((i) => i.item_type === 'MILESTONE').length, delivery: chosen.filter((i) => !(i.requirement_ids || []).length && i.item_type !== 'MILESTONE').length };
    await save(t, plan.id, { draft: { ...plan.draft, items: draftItems }, commit_result: result });
    return { ...r, plan: await getPlan(t, project, plan.id) };
  });
}
export async function cancelPlan(db, plan) {
  if (plan.status === 'COMMITTED') throw new PlanError(409, 'plan_committed', '이미 반영된 초안은 취소할 수 없습니다.');
  await save(db, plan.id, { status: 'CANCELLED' });
}
