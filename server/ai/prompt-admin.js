/**
 * /api/admin/ai/prompts/* — 관리자 › AI 프롬프트. SYSTEM_ADMIN only (the admin guard runs first on every route).
 *
 *   GET  /api/admin/ai/prompts                     list (label, where used, overridden?, version, last change)
 *   GET  /api/admin/ai/prompts/:key                template, code default, history, and 전송 내용 (system prompt, user-message
 *                                                  template, JSON schema, model, output cap, temperature, timeout, credits)
 *   POST /api/admin/ai/prompts/:key/check          { body } → errors / warnings / affected features (no write)
 *   PUT  /api/admin/ai/prompts/:key                { body, base_version } → save (audit AI_PROMPT_UPDATE)
 *   POST /api/admin/ai/prompts/:key/reset          { base_version } → back to the code default
 *   POST /api/admin/ai/prompts/:key/restore        { version, base_version } → an older version saved again
 *   GET  /api/admin/ai/preview-projects?q=         projects to preview with
 *   POST /api/admin/ai/prompts/:key/preview        { project_id, text?, question? } → the exact request that would be sent,
 *                                                  built by the real feature code but stopped before any credit, ai_runs row or
 *                                                  provider call (service.previewPrompt). Audit AI_PROMPT_PREVIEW. Nothing is stored.
 *
 * Real user runs are not logged in full (privacy / retention): ai_runs keeps only an input summary.
 */
import { aiConfig, featureCreditCost, maxOutputTokensFor, FEATURE_LABEL } from './config.js';
import { previewPrompt, runAiFeature } from './service.js';
import { providerRequest } from './provider.js';
import { retryHint, DEFAULT_PROMPTS } from './prompts.js';
import { PROMPT_META, affectedBy, checkPrompt, getPrompt, listPrompts, savePrompt, resetPrompt, restorePrompt, systemPrompt, PromptError, PROMPT_CACHE_MS } from './prompt-store.js';
import { extractRequirements, generateWbs, changeImpact, askProject } from './features.js';
import { generateTests } from './test-gen.js';
import * as P from './planner.js';
import { PLANNER_SCHEMAS } from './schemas.js';
import { requirementRows } from './context.js';
import * as C from '../changes.js';
import { ValidationError } from '../validate.js';
import { writeAudit } from '../admin.js';

/** The user message each feature sends, with its data blocks described. Fixed in code (not editable here). */
export const USER_TEMPLATES = {
  REQUIREMENT_EXTRACTION: `<project_data>
{프로젝트 개요(Project Charter) · 현재 단계·규모 · 요구사항 유형 목록 · 기존 요구사항 최대 150건 (ID [상태/범위/우선순위] 제목)}
</project_data>

<untrusted_input>
{사용자가 붙여 넣은 회의록·메일 등 (10자 이상, 최대 AI_MAX_INPUT_CHARS자)}
</untrusted_input>

위 <untrusted_input> 텍스트에서 요구사항 후보를 추출해 JSON으로 반환하세요.`,
  WBS_GENERATION: `<project_data>
{프로젝트 개요 · 현재 단계 · 선택한 요구사항 최대 60건 (설명·완료 조건 포함) · 기존 WBS 최대 150건}
</project_data>

위 선택 요구사항을 구현하기 위한 WBS 초안을 JSON으로 반환하세요.`,
  CHANGE_IMPACT: `<project_data>
{프로젝트 개요 · 변경 요청 내용과 연결 항목 · 요구사항 최대 150건 · WBS 최대 150건 · 테스트 · 리스크}
</project_data>

변경 요청 {CR-nnn}의 영향 후보를 JSON으로 반환하세요.`,
  PROJECT_QA: `<project_data>
{프로젝트 개요 · 질문 유형(일정·범위·품질·리스크·변경)에 맞춰 고른 데이터: 상태(Health), 진척 요약, 다가오는 일정, WBS, 요구사항, 이슈·리스크, 테스트, 변경, Jira 요약}
</project_data>

<untrusted_input>
이전 대화 (데이터):
{최근 대화 최대 4개, 각 600자}
</untrusted_input>            ← 이전 대화가 있을 때만

<untrusted_input>
{PM의 질문 (최대 1,000자)}
</untrusted_input>

위 <untrusted_input>의 질문에 <project_data>만 근거로 답하세요.`,
  WBS_PLAN_QUESTIONS: `<project_data>
{프로젝트 개요 · 선택 요구사항 최대 80건 · 기존 WBS 최대 200건 · 이미 확인된 정보 (다시 묻지 말 것)}
</project_data>

위 프로젝트에 필요한 수행 영역을 판단하고, 정보가 부족한 영역에 대한 질문을 JSON으로 반환하세요.`,
  PROJECT_WBS_DRAFT: `<project_data>
{프로젝트 개요 · 선택 요구사항 · 기존 WBS · 수행 영역 판단 (답변 반영)}
</project_data>

<untrusted_input>
## 사용자 답변
{플래너 질문별 답변}
</untrusted_input>

기능 요구사항만 구현하지 말고 실제 프로젝트 완료에 필요한 전체 수행 WBS 초안을 JSON으로 반환하세요.`,
  WBS_PLAN_FIX: `<project_data>
{프로젝트 개요 · 선택 요구사항 · 기존 WBS · 수행 영역 판단 · 현재 초안 (temp_id · 영역 · 제목) · 보완 대상 (missing_areas, uncovered_requirements)}
</project_data>

<untrusted_input>
## 사용자 답변
{플래너 질문별 답변}
</untrusted_input>

보완 대상에 해당하는 추가 WBS 후보만 JSON으로 반환하세요.`,
  TEST_GENERATION: `<project_data>
{프로젝트 개요 · 적용 환경 · 선택한 요구사항 최대 20건 (설명·완료 조건) · 기존 테스트 제목}
</project_data>

위 선택 요구사항마다 테스트 시나리오 초안을 JSON으로 반환하세요.`,
};

const DEFAULT_MODEL = { anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', fake: 'fake-model' };
/** Provider settings as the server would use them now (no keys). */
function settingsFor(key) {
  const cfg = aiConfig(); const meta = PROMPT_META[key]; const feature = meta.feature;
  return {
    enabled: cfg.enabled, disabled_reason: cfg.disabledReason, provider: cfg.provider || null, model: cfg.model || DEFAULT_MODEL[cfg.provider] || null,
    feature, feature_label: feature ? FEATURE_LABEL[feature] : null,
    max_output_tokens: feature ? maxOutputTokensFor(feature) : null,
    temperature: null, temperature_note: '설정하지 않음 — 제공사 기본값(OpenAI·Anthropic 모두 1.0)으로 전송됩니다.',
    timeout_ms: cfg.timeoutMs, max_input_chars: cfg.maxInputChars,
    credit_cost: feature ? featureCreditCost(feature) : null,
    retry: '제공사 일시 오류(429·5xx·네트워크)는 0.3초 뒤 1번 재시도, 응답이 JSON 스키마에 맞지 않으면 문제 목록을 붙여 1번 다시 요청합니다. 시간 초과는 재시도하지 않습니다.',
    retry_hint: retryHint(['(검증 오류 내용)']).trim(),
    cache_seconds: PROMPT_CACHE_MS / 1000,
  };
}

async function sendDetail(db, key) {
  const p = await getPrompt(db, key);
  if (!p) return null;
  const meta = PROMPT_META[key];
  const out = { ...p, affected: affectedBy(key).map((k) => ({ key: k, label: PROMPT_META[k].label })) };
  if (key === 'COMMON_RULES') return { ...out, send: { settings: settingsFor(key) } };
  return { ...out, send: { system: await systemPrompt(db, key), user_template: USER_TEMPLATES[key], schema_name: meta.schemaName, schema: meta.schema(), settings: settingsFor(key) } };
}

/* ---------- preview ---------- */
const SAMPLE_TEXT = '(미리보기 예시) 고객 미팅 메모: 사내 SSO로 로그인할 수 있어야 한다. 관리자는 월별 사용 현황을 엑셀로 내려받고 싶어 한다. 응답 시간은 3초 이내여야 한다.';
const SAMPLE_QUESTION = '이번 주에 확인해야 할 이슈와 리스크는 무엇인가요?';
const noData = (msg) => new PromptError(409, 'no_preview_data', msg);
const firstError = (e) => (e instanceof ValidationError ? Object.values(e.fields)[0] : e.message);

async function latestPlan(db, project, statuses) {
  const r = await db.get(`SELECT * FROM ai_wbs_plans WHERE project_id = ? AND workspace_id = ? AND status = ANY(?::text[]) ORDER BY updated_at DESC LIMIT 1`, [project.id, project.workspace_id, statuses]);
  return r ? P.shapePlan(r) : null;
}

/** Runs the real feature code for `key` inside previewPrompt(): returns what would be sent, plus a note on which data was used. */
async function capture(db, key, project, admin, input) {
  const base = { project, wid: project.workspace_id, userId: admin.id };
  const liveIds = async (limit) => (await requirementRows(db, project.id, { limit })).map((r) => r.id);
  switch (key) {
    case 'REQUIREMENT_EXTRACTION': {
      const text = String(input.text || '').trim() || SAMPLE_TEXT;
      return { used: `입력 텍스트 ${text.length.toLocaleString('ko-KR')}자${input.text ? '' : ' (예시 문장)'}`, payload: await previewPrompt(() => extractRequirements(db, { ...base, text })) };
    }
    case 'WBS_GENERATION': {
      const ids = await liveIds(60); if (!ids.length) throw noData('이 프로젝트에 요구사항이 없어 미리 볼 수 없습니다.');
      return { used: `요구사항 ${ids.length}건 선택 (앞에서부터 최대 60건)`, payload: await previewPrompt(() => generateWbs(db, { ...base, requirementIds: ids })) };
    }
    case 'CHANGE_IMPACT': {
      const row = await db.get('SELECT id FROM change_requests WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1', [project.id]);
      const change = row ? await C.getChange(db, project, row.id) : null;
      if (!change) throw noData('이 프로젝트에 변경 요청이 없어 미리 볼 수 없습니다.');
      return { used: `가장 최근 변경 요청 ${change.display_id}`, payload: await previewPrompt(() => changeImpact(db, { ...base, change })) };
    }
    case 'PROJECT_QA': {
      const question = String(input.question || '').trim() || SAMPLE_QUESTION;
      return { used: `질문: ${question}`, payload: await previewPrompt(() => askProject(db, { ...base, question, history: [] })) };
    }
    case 'WBS_PLAN_QUESTIONS': {
      const ids = (await liveIds(300)).slice(0, 80);
      return { used: `요구사항 ${ids.length}건 (플래너 기본: 전체, 최대 80건)`,
        payload: await previewPrompt(() => runAiFeature(db, { ...base, projectId: project.id, feature: 'WBS_PLAN_QUESTIONS', build: async () => (await P.planQuestionsRequest(db, project, ids, '(미리보기)')).prompt })) };
    }
    case 'PROJECT_WBS_DRAFT': {
      let plan = await latestPlan(db, project, ['QUESTIONS_READY', 'REVIEW', 'COMMITTED']); let used;
      if (plan) used = `가장 최근 플래너 기록 (${plan.status}, 답변 ${Object.keys(plan.answers).length}개)`;
      else { plan = { id: '(미리보기)', requirement_ids: (await liveIds(300)).slice(0, 80), questions: [], answers: {}, areas: [] }; used = `플래너 기록이 없어 질문·답변 없이 요구사항 ${plan.requirement_ids.length}건으로 만든 예시`; }
      const areas = P.assessWithAnswers(plan);
      return { used, payload: await previewPrompt(() => runAiFeature(db, { ...base, projectId: project.id, feature: 'WBS_GENERATION', schema: PLANNER_SCHEMAS.project_wbs_draft, build: async () => (await P.planDraftRequest(db, project, plan, areas)).prompt })) };
    }
    case 'WBS_PLAN_FIX': {
      const plan = await latestPlan(db, project, ['REVIEW']);
      if (!plan || !plan.draft || !plan.coverage) throw noData('이 프로젝트에 검토 단계의 WBS 플래너 기록이 없어 미리 볼 수 없습니다.');
      try { return { used: '가장 최근 검토 단계 플래너 기록', payload: await previewPrompt(() => P.fixPlan(db, { ...base, plan })) }; }
      catch (e) { if (e instanceof P.PlanError) throw noData(e.message); throw e; }
    }
    case 'TEST_GENERATION': {
      let ids = []; let used = '확정 · 범위 내 · 테스트 미연결 요구사항 (화면 기본 선택)';
      try { return { used, payload: await previewPrompt(() => generateTests(db, { ...base, requirementIds: ids })) }; }
      catch (e) { if (!(e instanceof ValidationError)) throw e; }
      ids = await liveIds(20); used = `기본 선택 대상이 없어 앞에서부터 요구사항 ${ids.length}건`;
      if (!ids.length) throw noData('이 프로젝트에 요구사항이 없어 미리 볼 수 없습니다.');
      return { used, payload: await previewPrompt(() => generateTests(db, { ...base, requirementIds: ids })) };
    }
    default: throw new PromptError(400, 'no_preview', '공통 원칙은 각 작업 프롬프트의 미리보기에 함께 들어갑니다.');
  }
}

export async function previewSend(db, admin, key, input = {}) {
  if (!PROMPT_META[key]) throw new PromptError(404, 'not_found', '프롬프트를 찾을 수 없습니다.');
  const project = await db.get('SELECT p.*, w.name AS workspace_name FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = ?', [String(input.project_id || '')]);
  if (!project) throw new PromptError(404, 'not_found', '프로젝트를 찾을 수 없습니다.');
  let r;
  try { r = await capture(db, key, project, admin, input); }
  catch (e) { if (e instanceof ValidationError) throw noData(firstError(e)); throw e; }
  const { payload } = r; const cfg = aiConfig(); const settings = settingsFor(key);
  const req = { model: settings.model, maxTokens: payload.maxTokens, system: payload.prompt.system, user: payload.prompt.user, schema: payload.schema, schemaName: payload.prompt.schemaName || payload.feature.toLowerCase(), schemaDescription: payload.prompt.schemaDescription };
  await writeAudit(db, { adminUserId: admin.id, action: 'AI_PROMPT_PREVIEW', targetType: 'PROJECT', targetId: project.id, metadata: { key, label: PROMPT_META[key].label, project: project.name, workspace: project.workspace_name } });
  return {
    key, project: { id: project.id, name: project.name, workspace: project.workspace_name }, used: r.used,
    feature: payload.feature, system: payload.prompt.system, user: payload.prompt.user, schema_name: req.schemaName, schema: payload.schema,
    chars: { system: payload.prompt.system.length, user: payload.prompt.user.length }, input_summary: payload.prompt.inputSummary,
    input_too_large: payload.inputTooLarge, settings: { ...settings, provider: cfg.provider || null },
    request: providerRequest(cfg.provider, req),
  };
}

export async function previewProjects(db, q = '') {
  const term = String(q || '').trim();
  return db.all(`SELECT p.id, p.name, w.name AS workspace, p.status, p.sample_key,
      (SELECT COUNT(*)::int FROM requirements r WHERE r.project_id = p.id AND r.archived_at IS NULL) AS requirements,
      (SELECT COUNT(*)::int FROM change_requests c WHERE c.project_id = p.id AND c.archived_at IS NULL) AS changes
    FROM projects p JOIN workspaces w ON w.id = p.workspace_id
    WHERE (?::text = '' OR p.name ILIKE ? OR w.name ILIKE ?) ORDER BY p.updated_at DESC LIMIT 30`, [term, `%${term}%`, `%${term}%`]);
}

export function mountAdminPromptRoutes(app, db, { guard, wrap, fail }) {
  const base = '/api/admin/ai/prompts';
  const admin = (req) => ({ id: req.user.id });
  const act = (fn) => wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { if (e instanceof PromptError) return res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } }); throw e; }
  });
  app.get(base, guard, wrap(async (req, res) => { const cfg = aiConfig(); res.json({ prompts: await listPrompts(db), cache_seconds: PROMPT_CACHE_MS / 1000, provider: cfg.provider || null, model: cfg.model || null, enabled: cfg.enabled }); }));
  app.get('/api/admin/ai/preview-projects', guard, wrap(async (req, res) => res.json({ projects: await previewProjects(db, req.query.q) })));
  app.get(`${base}/:key`, guard, wrap(async (req, res) => { const d = await sendDetail(db, req.params.key); return d ? res.json(d) : fail(res, 404, 'not_found', '프롬프트를 찾을 수 없습니다.'); }));
  app.post(`${base}/:key/check`, guard, act(async (req) => {
    const key = req.params.key; if (!PROMPT_META[key]) throw new PromptError(404, 'not_found', '프롬프트를 찾을 수 없습니다.');
    return { ...checkPrompt(key, req.body?.body), affected: affectedBy(key).map((k) => ({ key: k, label: PROMPT_META[k].label })), is_default: req.body?.body === DEFAULT_PROMPTS[key] };
  }));
  app.put(`${base}/:key`, guard, act((req) => savePrompt(db, admin(req), req.params.key, req.body || {})));
  app.post(`${base}/:key/reset`, guard, act((req) => resetPrompt(db, admin(req), req.params.key, req.body || {})));
  app.post(`${base}/:key/restore`, guard, act((req) => restorePrompt(db, admin(req), req.params.key, req.body || {})));
  app.post(`${base}/:key/preview`, guard, act((req) => previewSend(db, admin(req), req.params.key, req.body || {})));
}
