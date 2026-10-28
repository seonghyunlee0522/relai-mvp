/**
 * AI layer configuration (Phase 11). Everything is read from the environment once per call so tests can flip it.
 * Secrets never leave this module except into the provider adapter; `publicConfig()` is what the frontend may see.
 *
 * Usage metering (2026-10-27, credits retired): every run records its tokens and its provider cost in USD (ai_runs.provider_cost_amount),
 * and a workspace's AI allowance is a USD budget per plan (plans.js AI_LIMIT_USD, ai/usage-limit.js). Users only ever see a percentage.
 */
export const FEATURES = ['REQUIREMENT_EXTRACTION', 'WBS_GENERATION', 'CHANGE_IMPACT', 'PROJECT_QA', 'WBS_PLAN_QUESTIONS', 'WBS_PLAN_FIX', 'TEST_GENERATION'];
export const FEATURE_LABEL = { REQUIREMENT_EXTRACTION: 'AI 요구사항 추출', WBS_GENERATION: 'AI WBS 초안', CHANGE_IMPACT: 'AI 영향 분석', PROJECT_QA: 'RELAI에게 물어보기', WBS_PLAN_QUESTIONS: 'AI WBS Planner 질문', WBS_PLAN_FIX: 'AI WBS Planner 보완', TEST_GENERATION: '테스트 시나리오 만들기' };

const envInt = (k, def) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== undefined && process.env[k] !== '' ? n : def; };

/**
 * Provider price table in USD per 1M tokens: [input, output, cached input]. A dated model id (…-20250929) falls back to its base id.
 * Check against the vendors' price pages whenever a model is added or a price changes; AI_PRICE_<MODEL>="in,out,cached" overrides one
 * model without a deploy of this file (model id upper-cased, non-alphanumerics → _). Unknown models cost null and are never blocked.
 */
export const PROVIDER_PRICES = {
  'claude-sonnet-4-5': [3, 15, 0.3], 'claude-haiku-4-5': [1, 5, 0.1], 'claude-opus-4-1': [15, 75, 1.5],
  'gpt-4o': [2.5, 10, 1.25], 'gpt-4o-mini': [0.15, 0.6, 0.075], 'gpt-4.1': [2, 8, 0.5], 'gpt-4.1-mini': [0.4, 1.6, 0.1], 'gpt-5': [1.25, 10, 0.125], 'gpt-5-mini': [0.25, 2, 0.025],
  'fake-model': [0, 0, 0],
};
export function priceOf(model) {
  const id = String(model || '');
  const env = process.env[`AI_PRICE_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (env) { const p = env.split(',').map(Number); if (p.length >= 2 && p.every((x) => Number.isFinite(x) && x >= 0)) return [p[0], p[1], p[2] ?? p[0]]; }
  return PROVIDER_PRICES[id] || PROVIDER_PRICES[id.replace(/-\d{8}$/, '')] || null;
}
/** USD cost of one call. cached ⊂ input (billed at the cached rate). null when the model has no price or no usage was reported. */
export function estimateProviderCost(model, inputTokens, outputTokens, cachedTokens = 0) {
  const p = priceOf(model);
  if (!p || inputTokens == null || outputTokens == null) return null;
  const cached = Math.min(Math.max(0, Number(cachedTokens) || 0), inputTokens);
  return Number((((inputTokens - cached) * p[0] + cached * p[2] + outputTokens * p[1]) / 1e6).toFixed(6));
}
/**
 * Worst-case USD of a call that has not run yet: every input character counted as a token (Korean runs ≈ 1 token per 1–2 chars, so this
 * over-estimates) plus the feature's whole output cap. Used to reserve the allowance and as the recorded cost of a run that timed out.
 */
export const worstCaseCost = (model, inputChars, maxOutputTokens) => estimateProviderCost(model, Math.ceil(Number(inputChars) || 0), maxOutputTokens, 0);

/**
 * Output-token cap per call, sized to each feature's schema so a run cannot run away (gpt-4o-mini: $0.6 per 1M output tokens,
 * so the largest cap costs under ₩10). AI_MAX_OUTPUT_TOKENS_<FEATURE> overrides one feature; AI_MAX_OUTPUT_TOKENS, when set, is a ceiling for all.
 * WBS_GENERATION covers the Planner's full draft (up to 100 items); Q&A answers are short.
 */
const MAX_OUTPUT_TOKENS = { REQUIREMENT_EXTRACTION: 4_000, WBS_GENERATION: 8_000, CHANGE_IMPACT: 2_500, PROJECT_QA: 1_500, WBS_PLAN_QUESTIONS: 3_000, WBS_PLAN_FIX: 3_000, TEST_GENERATION: 8_000 };   // TEST_GENERATION: ≤ 20 requirements × ≤ 3 scenarios
export function maxOutputTokensFor(feature) {
  const per = Math.max(256, envInt(`AI_MAX_OUTPUT_TOKENS_${feature}`, MAX_OUTPUT_TOKENS[feature] ?? 4_000));
  const ceiling = process.env.AI_MAX_OUTPUT_TOKENS ? Math.max(256, envInt('AI_MAX_OUTPUT_TOKENS', per)) : Infinity;
  return Math.min(per, ceiling);
}

const DEFAULT_MODEL = { anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', fake: 'fake-model' };

/** Full (server-side) configuration. `enabled` is false whenever the provider has no credential. */
export function aiConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const keys = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, fake: 'fake' };
  const apiKey = keys[provider] || '';
  const flag = String(env.AI_ENABLED ?? 'true').toLowerCase() !== 'false';
  const enabled = flag && Boolean(provider) && Boolean(apiKey);
  return {
    enabled, provider, apiKey,
    model: String(env.AI_MODEL || DEFAULT_MODEL[provider] || '').trim(),
    timeoutMs: Math.min(120_000, Math.max(1_000, envInt('AI_REQUEST_TIMEOUT_MS', 25_000))),
    maxInputChars: Math.max(500, envInt('AI_MAX_INPUT_CHARS', 20_000)),
    dailyLimit: Math.max(0, envInt('AI_DAILY_LIMIT', 300)),            // per workspace per day (0 = unlimited)
    userMinuteLimit: Math.max(0, envInt('AI_USER_MINUTE_LIMIT', 10)),  // per user per minute (0 = unlimited)
    // Who the Free allowance (once) is for. 'owner' (default) = one workspace per owner account and per e-mail hash (free_credit_claims);
    // 'workspace' = every workspace. ai/usage-limit.js.
    freeClaimScope: String(env.AI_FREE_CLAIM_SCOPE || 'owner').toLowerCase() === 'workspace' ? 'workspace' : 'owner',
    maxOutputTokens: Math.max(256, envInt('AI_MAX_OUTPUT_TOKENS', 4_000)),
    disabledReason: !flag ? 'AI_ENABLED=false' : !provider ? 'AI_PROVIDER 미설정' : !apiKey ? 'Provider API Key 미설정' : null,
  };
}

/** Operator view (Admin console only): which vendor and model are live. */
export function adminAiConfig() { const c = aiConfig(); return { enabled: c.enabled, provider: c.enabled ? c.provider : null, model: c.enabled ? c.model : null, disabled_reason: c.disabledReason }; }

/** What the frontend is allowed to know. No keys, no limits that would help abuse. */
export function publicConfig() {
  const c = aiConfig();
  return { enabled: c.enabled,
    notice: '현재 프로젝트의 요구사항, WBS, 이슈·리스크, 테스트, 변경 데이터와 RELAI의 PM 실무 지식을 참고합니다. AI 결과는 초안·후보이며 사용자가 검토·승인한 항목만 저장됩니다.' };
}
