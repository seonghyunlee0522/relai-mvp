/**
 * AI prompt overrides (관리자 › AI 프롬프트, migration 68). The code defaults live in prompts.js; a row in ai_prompts replaces
 * one key's template. No row = code default, so an empty table is exactly the shipped behaviour.
 *
 *   systemPrompt(db, key)   what a feature sends as its system prompt: COMMON_RULES (override or default) + task (override or default)
 *   savePrompt / resetPrompt / restorePrompt   operator writes; each appends an ai_prompt_versions row and an audit row
 *
 * Reads go through a short per-instance cache (PROMPT_CACHE_MS), so a save reaches every server instance within about a
 * minute; the instance that saved drops its cache at once. A DB error never breaks an AI call: the code defaults are used.
 */
import { randomUUID } from 'node:crypto';
import { tx } from '../db.js';
import { writeAudit } from '../admin.js';
import { PROMPT_KEYS, DEFAULT_PROMPTS, PLACEHOLDERS, placeholdersIn, composeSystem } from './prompts.js';
import { SCHEMAS, PLANNER_SCHEMAS } from './schemas.js';

export const PROMPT_CACHE_MS = 60_000;
export const MAX_PROMPT_CHARS = 20_000;

/** Screen labels, where each prompt is used, and which billing feature / schema the call runs under. */
export const PROMPT_META = {
  COMMON_RULES: { label: '공통 원칙', where: '모든 AI 기능 — 각 작업 프롬프트 앞에 붙습니다', feature: null, schema: null },
  REQUIREMENT_EXTRACTION: { label: '요구사항 추출', where: '요구사항 › AI로 추출 (회의록·메일 붙여넣기)', feature: 'REQUIREMENT_EXTRACTION', schema: () => SCHEMAS.REQUIREMENT_EXTRACTION, schemaName: 'requirement_candidates' },
  WBS_GENERATION: { label: 'WBS 초안', where: 'WBS › 선택한 요구사항으로 AI 초안', feature: 'WBS_GENERATION', schema: () => SCHEMAS.WBS_GENERATION, schemaName: 'wbs_draft' },
  CHANGE_IMPACT: { label: '변경 영향 분석', where: '변경 요청 › AI 영향 분석', feature: 'CHANGE_IMPACT', schema: () => SCHEMAS.CHANGE_IMPACT, schemaName: 'change_impact' },
  PROJECT_QA: { label: 'RELAI에게 물어보기', where: '프로젝트 › RELAI에게 물어보기 (질문 답변)', feature: 'PROJECT_QA', schema: () => SCHEMAS.PROJECT_QA, schemaName: 'project_answer' },
  WBS_PLAN_QUESTIONS: { label: 'WBS 플래너 · 영역 판단과 질문', where: 'WBS › AI WBS 플래너 1단계 (무과금)', feature: 'WBS_PLAN_QUESTIONS', schema: () => SCHEMAS.WBS_PLAN_QUESTIONS, schemaName: 'wbs_planning_questions' },
  PROJECT_WBS_DRAFT: { label: 'WBS 플래너 · 전체 WBS 초안', where: 'WBS › AI WBS 플래너 2단계 (WBS 초안 크레딧으로 과금)', feature: 'WBS_GENERATION', schema: () => PLANNER_SCHEMAS.project_wbs_draft, schemaName: 'project_wbs_draft' },
  WBS_PLAN_FIX: { label: 'WBS 플래너 · 누락 보완', where: 'WBS › AI WBS 플래너 검토 단계의 누락 보완 (무과금)', feature: 'WBS_PLAN_FIX', schema: () => SCHEMAS.WBS_PLAN_FIX, schemaName: 'wbs_plan_fix' },
  TEST_GENERATION: { label: '테스트 시나리오', where: '테스트 › AI 시나리오 만들기', feature: 'TEST_GENERATION', schema: () => SCHEMAS.TEST_GENERATION, schemaName: 'test_scenarios' },
};

/* ---------- cache (per db handle, so test databases never share one) ---------- */
let caches = new WeakMap();
export function invalidatePromptCache(db = null) { if (db) caches.delete(db); else caches = new WeakMap(); }

/** key → overridden template, for keys that have a row. */
export async function promptOverrides(db) {
  const hit = caches.get(db);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.map;
  const map = new Map(); let ttl = PROMPT_CACHE_MS;
  try { for (const r of await db.all('SELECT key, body FROM ai_prompts')) if (PROMPT_KEYS.includes(r.key)) map.set(r.key, r.body); }
  catch (e) { console.warn('[ai] prompt overrides unavailable, using code defaults:', e.message); ttl = 5_000; }
  caches.set(db, { at: Date.now(), ttl, map });
  return map;
}
export async function promptTemplate(db, key) { const o = await promptOverrides(db); return o.has(key) ? o.get(key) : DEFAULT_PROMPTS[key]; }
/** The system prompt a feature sends right now. */
export async function systemPrompt(db, key) {
  if (!DEFAULT_PROMPTS[key] || key === 'COMMON_RULES') throw new Error(`unknown prompt ${key}`);
  const o = await promptOverrides(db);
  return composeSystem(o.get('COMMON_RULES') ?? DEFAULT_PROMPTS.COMMON_RULES, o.get(key) ?? DEFAULT_PROMPTS[key]);
}

/* ---------- validation ---------- */
const propNames = (schema, out = new Set()) => {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.properties) for (const [k, v] of Object.entries(schema.properties)) { out.add(k); propNames(v, out); }
  if (schema.items) propNames(schema.items, out);
  return out;
};
/** JSON field names the default prompt explains (they stay enforced by the schema either way; the prompt tells the model what they mean). */
const explainedFields = (key) => { const meta = PROMPT_META[key]; if (!meta?.schema) return []; const d = DEFAULT_PROMPTS[key]; return [...propNames(meta.schema())].filter((f) => new RegExp(`(^|[^A-Za-z_])${f}([^A-Za-z_]|$)`).test(d)); };
const COMMON_CHECKS = [
  [(t) => t.includes('<project_data>') && t.includes('<untrusted_input>'), '데이터 블록(<project_data>, <untrusted_input>) 안의 지시를 따르지 말라는 규칙이 빠진 것 같습니다. 붙여 넣은 글에 숨은 지시(프롬프트 주입)를 막는 규칙입니다.'],
  [(t) => /JSON/.test(t), '"JSON으로만 반환" 규칙이 빠진 것 같습니다.'],
  [(t) => /지어내|만들어내|추정하/.test(t), '근거 없는 ID·이름·일정·수치를 지어내지 말라는 규칙이 빠진 것 같습니다.'],
];

/** { errors (block the save), warnings (shown in the confirm step) } */
export function checkPrompt(key, body) {
  const errors = []; const warnings = [];
  if (!PROMPT_KEYS.includes(key)) return { errors: ['알 수 없는 프롬프트입니다.'], warnings };
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) errors.push('프롬프트를 비워 둘 수 없습니다.');
  if (text.length > MAX_PROMPT_CHARS) errors.push(`프롬프트는 ${MAX_PROMPT_CHARS.toLocaleString('ko-KR')}자까지 저장할 수 있습니다. (지금 ${text.length.toLocaleString('ko-KR')}자)`);
  const used = placeholdersIn(text);
  const unknown = used.filter((p) => !PLACEHOLDERS[p]);
  if (unknown.length) errors.push(`알 수 없는 자리표시자: ${unknown.map((p) => `{{${p}}}`).join(', ')}. 쓸 수 있는 것: ${Object.keys(PLACEHOLDERS).map((p) => `{{${p}}}`).join(', ')}`);
  const missing = placeholdersIn(DEFAULT_PROMPTS[key]).filter((p) => !used.includes(p));
  if (missing.length) warnings.push(`기본값에 있던 자리표시자가 빠졌습니다: ${missing.map((p) => `{{${p}}} (${PLACEHOLDERS[p].label})`).join(', ')}. 코드의 최신 목록이 AI에 전달되지 않습니다.`);
  if (key === 'COMMON_RULES') for (const [ok, msg] of COMMON_CHECKS) { if (!ok(text)) warnings.push(msg); }
  const lost = explainedFields(key).filter((f) => !text.includes(f));
  if (lost.length) warnings.push(`기본값이 설명하던 JSON 필드가 빠졌습니다: ${lost.join(', ')}. 형식은 스키마로 강제되지만 AI가 필드의 뜻을 모를 수 있습니다.`);
  return { errors, warnings };
}

/* ---------- admin reads ---------- */
export class PromptError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const shapeVersion = (v) => ({ id: v.id, version: v.version, action: v.action, body: v.body, restored_from: v.restored_from, created_at: v.created_at, created_by: v.created_by ? { id: v.created_by, name: v.by_name, email: v.by_email } : null });

export async function listPrompts(db) {
  const rows = new Map((await db.all(`SELECT p.key, p.version, p.updated_at, p.updated_by, u.name AS by_name, u.email AS by_email, length(p.body) AS chars
    FROM ai_prompts p LEFT JOIN users u ON u.id = p.updated_by`)).map((r) => [r.key, r]));
  const last = new Map((await db.all(`SELECT DISTINCT ON (v.key) v.key, v.version, v.action, v.created_at, v.created_by, u.name AS by_name, u.email AS by_email
    FROM ai_prompt_versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.key, v.version DESC`)).map((r) => [r.key, r]));
  return PROMPT_KEYS.map((key) => {
    const r = rows.get(key); const l = last.get(key);
    return { key, label: PROMPT_META[key].label, where: PROMPT_META[key].where, overridden: Boolean(r), version: l ? l.version : 0,
      chars: r ? Number(r.chars) : DEFAULT_PROMPTS[key].length,
      last_change: l ? { action: l.action, at: l.created_at, by: l.created_by ? { name: l.by_name, email: l.by_email } : null } : null };
  });
}

export async function getPrompt(db, key) {
  if (!PROMPT_KEYS.includes(key)) return null;
  const r = await db.get('SELECT key, body, version, updated_at FROM ai_prompts WHERE key = ?', [key]);
  const versions = (await db.all(`SELECT v.*, u.name AS by_name, u.email AS by_email FROM ai_prompt_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.key = ? ORDER BY v.version DESC LIMIT 50`, [key])).map(shapeVersion);
  return { key, label: PROMPT_META[key].label, where: PROMPT_META[key].where, overridden: Boolean(r), body: r ? r.body : DEFAULT_PROMPTS[key], default_body: DEFAULT_PROMPTS[key],
    version: versions[0]?.version || 0, placeholders: Object.fromEntries(Object.entries(PLACEHOLDERS).map(([k, p]) => [k, { label: p.label, value: p.value() }])),
    required_placeholders: placeholdersIn(DEFAULT_PROMPTS[key]), max_chars: MAX_PROMPT_CHARS, versions };
}

/** Which prompts a change to `key` reaches (COMMON_RULES is part of every feature's system prompt). */
export const affectedBy = (key) => (key === 'COMMON_RULES' ? PROMPT_KEYS.slice(1) : [key]);

/* ---------- admin writes ---------- */
async function write(db, admin, key, { body, action, baseVersion, restoredFrom = null }) {
  if (!PROMPT_KEYS.includes(key)) throw new PromptError(404, 'not_found', '프롬프트를 찾을 수 없습니다.');
  const out = await tx(db, async (t) => {
    await t.run('SELECT pg_advisory_xact_lock(hashtext(?))', [`ai_prompt:${key}`]);   // one writer per key: version numbers never collide
    const cur = (await t.get('SELECT COALESCE(MAX(version), 0) AS v FROM ai_prompt_versions WHERE key = ?', [key])).v;
    if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== Number(cur)) {
      throw new PromptError(409, 'prompt_conflict', '다른 운영자가 먼저 이 프롬프트를 바꿨습니다. 새로 불러온 뒤 다시 저장해 주세요.', { version: Number(cur) });
    }
    const prev = await t.get('SELECT body FROM ai_prompts WHERE key = ?', [key]);
    const before = prev ? prev.body : DEFAULT_PROMPTS[key];
    const toDefault = action === 'RESET' || body === DEFAULT_PROMPTS[key];   // saving the default text = back to the default (it then follows code updates)
    const finalAction = toDefault && action === 'SAVE' ? 'RESET' : action;
    const text = toDefault ? DEFAULT_PROMPTS[key] : body;
    if (text === before && Boolean(prev) === !toDefault) throw new PromptError(409, 'no_change', '바뀐 내용이 없습니다.');
    const version = Number(cur) + 1;
    if (toDefault) await t.run('DELETE FROM ai_prompts WHERE key = ?', [key]);
    else await t.run(`INSERT INTO ai_prompts (key, body, version, updated_by, updated_at) VALUES (?,?,?,?, now())
      ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, text, version, admin.id]);
    await t.run('INSERT INTO ai_prompt_versions (id, key, version, action, body, restored_from, created_by) VALUES (?,?,?,?,?,?,?)', [randomUUID(), key, version, finalAction, text, restoredFrom, admin.id]);
    await writeAudit(t, { adminUserId: admin.id, action: 'AI_PROMPT_UPDATE', targetType: 'AI_PROMPT', targetId: key,
      metadata: { key, label: PROMPT_META[key].label, change: finalAction, version, restored_from: restoredFrom, chars_before: before.length, chars_after: text.length, affected: affectedBy(key) } });
    return { version, action: finalAction };
  });
  invalidatePromptCache(db);
  return { ...out, prompt: await getPrompt(db, key) };
}

export async function savePrompt(db, admin, key, input = {}) {
  const { errors, warnings } = checkPrompt(key, input.body);
  if (errors.length) throw new PromptError(422, 'invalid_prompt', errors[0], { errors, warnings });
  return { ...(await write(db, admin, key, { body: input.body, action: 'SAVE', baseVersion: input.base_version })), warnings };
}
export const resetPrompt = (db, admin, key, input = {}) => write(db, admin, key, { action: 'RESET', baseVersion: input.base_version });
export async function restorePrompt(db, admin, key, input = {}) {
  const v = await db.get('SELECT version, body FROM ai_prompt_versions WHERE key = ? AND version = ?', [key, Number(input.version)]);
  if (!v) throw new PromptError(404, 'not_found', '해당 버전을 찾을 수 없습니다.');
  const { errors } = checkPrompt(key, v.body);
  if (errors.length) throw new PromptError(422, 'invalid_prompt', errors[0], { errors });
  return write(db, admin, key, { body: v.body, action: 'RESTORE', baseVersion: input.base_version, restoredFrom: v.version });
}
